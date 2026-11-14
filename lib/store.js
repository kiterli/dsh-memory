/**
 * lib/store.js — one logical schema on two backends (node:sqlite / JSON file).
 * Owner: mem-core. Plain ESM, zero npm dependencies.
 *
 * Contract: see dsh-memory/CONTRACT.md, section "lib/store.js (mem-core)".
 *
 * Design: both backends persist the same logical tables (facts, entities, fact_entities,
 * relations, meta). Every read goes through a shared snapshot -> Fact mapping, so the two
 * backends cannot drift: identical inserts produce byte-identical queryFacts output.
 * No filesystem access (and no sqlite probe) happens at import time.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  ageInDays,
  ARCHIVE_MIN_AGE_DAYS,
  ARCHIVE_MAX_TRUST,
} from './decay.js';

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 10000;
const DEFAULT_CATEGORY = 'general';
const DEFAULT_TRUST = 0.6;
const DEFAULT_SOURCE = 'manual';
const MAX_ENTITIES_PER_FACT = 8;

/**
 * accessCount saturates here. The cap is on the STORED VALUE, not on counting: every recall
 * increments until this ceiling, so "used a lot" and "used twice then forgotten" are
 * distinguishable, while the column stays a small integer forever.
 */
const USAGE_SATURATION = 1000;

const SQLITE_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', tags TEXT NOT NULL DEFAULT '[]', trust REAL NOT NULL DEFAULT 0.6, source TEXT NOT NULL DEFAULT 'manual', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, searchCount INTEGER NOT NULL DEFAULT 0, helpfulCount INTEGER NOT NULL DEFAULT 0, hash TEXT NOT NULL, embedding BLOB, embedModel TEXT, archived INTEGER NOT NULL DEFAULT 0, superseded INTEGER NOT NULL DEFAULT 0, supersededBy TEXT)",
  "CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'topic', factCount INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)",
  'CREATE TABLE IF NOT EXISTS fact_entities (factId TEXT NOT NULL, entityId TEXT NOT NULL, PRIMARY KEY (factId, entityId))',
  'CREATE TABLE IF NOT EXISTS relations (id TEXT PRIMARY KEY, fromName TEXT NOT NULL, toName TEXT NOT NULL, relation TEXT NOT NULL, factId TEXT, createdAt INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, sessionId TEXT, timestamp INTEGER NOT NULL, content TEXT NOT NULL, emotion TEXT NOT NULL DEFAULT \'neutral\', importance REAL NOT NULL DEFAULT 0.5, factId TEXT)',
  'CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, fromId TEXT NOT NULL, toId TEXT NOT NULL, type TEXT NOT NULL, createdAt INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS feedbacks (id TEXT PRIMARY KEY, factId TEXT NOT NULL, vote TEXT NOT NULL CHECK(vote IN (\'up\',\'down\')), query TEXT, createdAt INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)',
  // Bitemporal history: one row per REVISION of a fact, so "what did I believe last month"
  // is answerable instead of being overwritten. `validFrom`/`validTo` are the validity window
  // (null validTo = still in force); `recordedAt` is when the row was written, which differs
  // from validFrom when a correction arrives late.
  'CREATE TABLE IF NOT EXISTS fact_versions (id TEXT PRIMARY KEY, factId TEXT NOT NULL, content TEXT NOT NULL, category TEXT, tags TEXT, trust REAL, source TEXT, validFrom INTEGER NOT NULL, validTo INTEGER, recordedAt INTEGER NOT NULL, reason TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_fact_versions_fact ON fact_versions (factId, validFrom)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_hash ON facts (hash)',
  'CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts (updatedAt)',
  'CREATE INDEX IF NOT EXISTS idx_entities_name ON entities (name)',
  'CREATE INDEX IF NOT EXISTS idx_fact_entities_entity ON fact_entities (entityId)',
  'CREATE INDEX IF NOT EXISTS idx_events_session ON events (sessionId)',
  'CREATE INDEX IF NOT EXISTS idx_events_ts ON events (timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_edges_from ON edges (fromId)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_pair ON edges (fromId, toId, type)',
];

/** Migration: add columns that may not exist on a v1 database. */
const MIGRATIONS = [
  { col: 'embedding', ddl: 'ALTER TABLE facts ADD COLUMN embedding BLOB' },
  { col: 'embedModel', ddl: 'ALTER TABLE facts ADD COLUMN embedModel TEXT' },
  { col: 'archived', ddl: 'ALTER TABLE facts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0' },
  { col: 'accessCount', ddl: 'ALTER TABLE facts ADD COLUMN accessCount INTEGER NOT NULL DEFAULT 0' },
  { col: 'lastHitAt', ddl: 'ALTER TABLE facts ADD COLUMN lastHitAt INTEGER' },
  { col: 'muted', ddl: 'ALTER TABLE facts ADD COLUMN muted INTEGER NOT NULL DEFAULT 0' },
  // A superseded fact was replaced by a later statement. It stays on disk so the history of
  // a decision remains answerable, but it is out of force for retrieval.
  { col: 'superseded', ddl: 'ALTER TABLE facts ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0' },
  { col: 'supersededBy', ddl: 'ALTER TABLE facts ADD COLUMN supersededBy TEXT' },
  { col: 'bodyStr', ddl: 'ALTER TABLE facts ADD COLUMN bodyStr REAL NOT NULL DEFAULT 1.0' },
  { col: 'sumStr', ddl: 'ALTER TABLE facts ADD COLUMN sumStr REAL NOT NULL DEFAULT 1.0' },
  { col: 'kwStr', ddl: 'ALTER TABLE facts ADD COLUMN kwStr REAL NOT NULL DEFAULT 1.0' },
  { col: 'permanent', ddl: 'ALTER TABLE facts ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0' },
];

/* ------------------------------------------------------------------ helpers */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function compareStrings(a, b) {
  const la = String(a).toLowerCase();
  const lb = String(b).toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  const sa = String(a);
  const sb = String(b);
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;
}

function compareIds(a, b) {
  const ia = String(a.id);
  const ib = String(b.id);
  if (ia === ib) return 0;
  return ia < ib ? -1 : 1;
}

/* ------------------------------------------------------- field normalizers */

function normalizeContent(content) {
  return String(content == null ? '' : content).replace(/\r\n?/g, '\n').trim().replace(/\s+/g, ' ').toLowerCase();
}

function hashContent(content) {
  return createHash('sha256').update(normalizeContent(content), 'utf8').digest('hex');
}

function factIdFor(hash) {
  return 'f' + hash.slice(0, 16);
}

function entityIdFor(name) {
  return 'e' + createHash('sha256').update(String(name).trim().toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

function normalizeCategory(value) {
  const category = typeof value === 'string' ? value.trim() : '';
  return category === '' ? DEFAULT_CATEGORY : category;
}

function normalizeTrust(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TRUST;
  return Math.min(1, Math.max(0, n));
}

function normalizeSource(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  return source === '' ? DEFAULT_SOURCE : source;
}

function asTagList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (text === '') return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch { /* fall through to comma split */ }
  }
  return text.split(',').map((v) => v.trim());
}

function normalizeTags(value) {
  const out = [];
  const seen = new Set();
  for (const raw of asTagList(value)) {
    const tag = raw.trim();
    if (tag === '') continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/* -------------------------------------------------------- entity extraction */

const RE_CAPITALIZED = /\b[A-Z][a-z][A-Za-z0-9]*\b/g;
const RE_UPPER_TOKEN = /\b[A-Z][A-Z0-9]*(?:[.\-][A-Za-z0-9]+)+|\b[A-Z0-9-]{3,}\b/g;
const RE_QUOTED = /"([^"\n]{1,120})"|'([^'\n]{1,120})'|\u201c([^\u201d\n]{1,120})\u201d|\u2018([^\u2019\n]{1,120})\u2019/g;

/**
 * Capitalised Latin words, quoted phrases, and A-Z0-9- tokens (length >= 3),
 * in order of first appearance, de-duplicated case-insensitively, capped at 8.
 */
function extractEntities(content) {
  const text = String(content == null ? '' : content);
  const hits = [];
  const push = (pos, raw) => {
    const value = String(raw == null ? '' : raw).trim();
    if (value.length >= 2) hits.push({ pos, value });
  };
  for (const m of text.matchAll(RE_CAPITALIZED)) push(m.index, m[0]);
  for (const m of text.matchAll(RE_QUOTED)) push(m.index + 1, m[1] || m[2] || m[3] || m[4]);
  for (const m of text.matchAll(RE_UPPER_TOKEN)) {
    if (m[0].length >= 3) push(m.index, m[0]);
  }
  hits.sort((a, b) => a.pos - b.pos);
  const out = [];
  const seen = new Set();
  for (const hit of hits) {
    const key = hit.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit.value);
    if (out.length >= MAX_ENTITIES_PER_FACT) break;
  }
  return out;
}

/* ----------------------------------------------------------- row normalizers */

function normalizeFactRow(raw) {
  const content = typeof raw.content === 'string' ? raw.content : String(raw.content == null ? '' : raw.content);
  return {
    id: String(raw.id),
    content,
    category: normalizeCategory(raw.category),
    tags: normalizeTags(raw.tags),
    trust: normalizeTrust(raw.trust),
    source: normalizeSource(raw.source),
    createdAt: toInt(raw.createdAt),
    updatedAt: toInt(raw.updatedAt),
    searchCount: toCount(raw.searchCount),
    helpfulCount: toCount(raw.helpfulCount),
    accessCount: toCount(raw.accessCount),
    lastHitAt: toInt(raw.lastHitAt),
    muted: raw.muted === 1 ? 1 : 0,
    bodyStr: typeof raw.bodyStr === 'number' ? raw.bodyStr : 1.0,
    sumStr: typeof raw.sumStr === 'number' ? raw.sumStr : 1.0,
    kwStr: typeof raw.kwStr === 'number' ? raw.kwStr : 1.0,
    permanent: raw.permanent === 1 ? 1 : 0,
    // Archived must survive a JSON round-trip, or every restart would resurrect facts
    // the maintenance pass had retired.
    archived: raw.archived === 1 ? 1 : 0,
    // Superseded likewise: a corrected belief that came back after a restart would be
    // worse than never correcting it.
    superseded: raw.superseded === 1 ? 1 : 0,
    supersededBy: raw.supersededBy == null ? null : String(raw.supersededBy),
    // Embeddings must survive a JSON round-trip now that the JSON backend supports them.
    embedding: Array.isArray(raw.embedding) ? raw.embedding : null,
    embedModel: raw.embedModel == null ? null : String(raw.embedModel),
    hash: typeof raw.hash === 'string' && raw.hash !== '' ? raw.hash : hashContent(content),
  };
}

function normalizeEntityRow(raw) {
  return {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : String(raw.name == null ? '' : raw.name),
    kind: typeof raw.kind === 'string' && raw.kind !== '' ? raw.kind : 'topic',
    factCount: toCount(raw.factCount),
    createdAt: toInt(raw.createdAt),
    updatedAt: toInt(raw.updatedAt),
  };
}

function normalizeRelationRow(raw) {
  const from = raw.from !== undefined ? raw.from : raw.fromName;
  const to = raw.to !== undefined ? raw.to : raw.toName;
  return {
    id: String(raw.id),
    from: String(from == null ? '' : from),
    to: String(to == null ? '' : to),
    relation: String(raw.relation == null ? '' : raw.relation),
    factId: raw.factId === undefined || raw.factId === null ? null : String(raw.factId),
    createdAt: toInt(raw.createdAt),
  };
}

function encodeMeta(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 'null' : text;
  } catch {
    return JSON.stringify(String(value));
  }
}

function decodeMeta(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/* --------------------------------------------------------------- projection */

function factFromRow(row, entities) {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    tags: row.tags.slice(),
    trust: row.trust,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    searchCount: row.searchCount,
    helpfulCount: row.helpfulCount,
    accessCount: row.accessCount || 0,
    lastHitAt: row.lastHitAt || 0,
    muted: row.muted || 0,
    bodyStr: row.bodyStr ?? 1.0,
    sumStr: row.sumStr ?? 1.0,
    kwStr: row.kwStr ?? 1.0,
    permanent: row.permanent || 0,
    archived: row.archived || 0,
    superseded: row.superseded || 0,
    supersededBy: row.supersededBy == null ? null : String(row.supersededBy),
    entities,
    hash: row.hash,
  };
}

function entityFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    factCount: row.factCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapFacts(snapshot) {
  const nameById = new Map();
  for (const entity of snapshot.entities) nameById.set(entity.id, entity.name);
  const namesByFact = new Map();
  for (const link of snapshot.factEntities) {
    const name = nameById.get(link.entityId);
    if (typeof name !== 'string') continue;
    let list = namesByFact.get(link.factId);
    if (!list) {
      list = [];
      namesByFact.set(link.factId, list);
    }
    list.push(name);
  }
  return snapshot.facts.map((row) => {
    const names = namesByFact.get(row.id);
    const sorted = names ? names.slice().sort(compareStrings) : [];
    return factFromRow(row, sorted);
  });
}

function queryFactsCore(snapshot, opts = {}) {
  // Archived rows are retired from retrieval but kept on disk (and in exports).
  // `includeArchived: true` is the escape hatch the panel/selfcheck uses for auditing.
  //
  // Superseded rows follow the same rule, and it matters more: a corrected belief that
  // still surfaces is worse than never having corrected it. `includeSuperseded: true`
  // answers "以前是怎么定的" without letting old decisions back into normal recall.
  const all = mapFacts(snapshot).filter((f) => {
    if (opts.includeArchived !== true && f.archived) return false;
    if (opts.includeSuperseded !== true && f.superseded) return false;
    return true;
  });
  const total = all.length;

  const q = typeof opts.q === 'string' ? opts.q.trim().toLowerCase() : '';
  const rawCategory = typeof opts.category === 'string' ? opts.category.trim().toLowerCase() : '';
  const hasCategory = rawCategory !== '' && rawCategory !== 'all';
  const rawMinTrust = opts.minTrust;
  const minTrust = rawMinTrust === undefined || rawMinTrust === null || rawMinTrust === ''
    ? null
    : Number(rawMinTrust);
  const hasMinTrust = minTrust !== null && Number.isFinite(minTrust);

  let matched = all;
  if (q !== '' || hasCategory || hasMinTrust) {
    matched = all.filter((fact) => {
      if (q !== '') {
        const hit = fact.content.toLowerCase().includes(q)
          || fact.category.toLowerCase().includes(q)
          || fact.tags.some((tag) => tag.toLowerCase().includes(q));
        if (!hit) return false;
      }
      if (hasCategory && fact.category.toLowerCase() !== rawCategory) return false;
      if (hasMinTrust && fact.trust < minTrust) return false;
      return true;
    });
  }
  const filtered = matched.length;

  const useTrust = opts.sort === 'trust';
  const sorted = matched.slice().sort(useTrust
    ? (a, b) => (b.trust - a.trust) || (b.updatedAt - a.updatedAt) || compareIds(a, b)
    : (a, b) => (b.updatedAt - a.updatedAt) || compareIds(a, b));

  const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInt(opts.limit, DEFAULT_LIMIT, 0, MAX_LIMIT);
  return { facts: sorted.slice(offset, offset + limit), total, filtered };
}

/* ------------------------------------------------------------ json backend */

function emptyData() {
  return { facts: [], entities: [], factEntities: [], relations: [], feedbacks: [], edges: [], events: [], factVersions: [], meta: {} };
}

function normalizeData(parsed) {
  const data = emptyData();
  if (!isPlainObject(parsed)) return data;
  if (Array.isArray(parsed.facts)) {
    data.facts = parsed.facts.filter(isPlainObject).map(normalizeFactRow);
  }
  if (Array.isArray(parsed.entities)) {
    data.entities = parsed.entities.filter(isPlainObject).map(normalizeEntityRow);
  }
  const links = Array.isArray(parsed.fact_entities) ? parsed.fact_entities
    : (Array.isArray(parsed.factEntities) ? parsed.factEntities : []);
  data.factEntities = links
    .filter((row) => isPlainObject(row) && row.factId != null && row.entityId != null)
    .map((row) => ({ factId: String(row.factId), entityId: String(row.entityId) }));
  if (Array.isArray(parsed.relations)) {
    data.relations = parsed.relations.filter(isPlainObject).map(normalizeRelationRow);
  }
  if (Array.isArray(parsed.feedbacks)) {
    data.feedbacks = parsed.feedbacks.filter(isPlainObject).map((row) => ({
      id: String(row.id ?? ''),
      factId: String(row.factId ?? ''),
      vote: String(row.vote ?? ''),
      query: String(row.query ?? ''),
      createdAt: Number(row.createdAt) || 0,
    }));
  }
  if (Array.isArray(parsed.edges)) {
    data.edges = parsed.edges.filter(isPlainObject).map((row) => ({
      id: String(row.id ?? ''),
      fromId: String(row.fromId ?? ''),
      toId: String(row.toId ?? ''),
      type: String(row.type ?? ''),
      createdAt: Number(row.createdAt) || 0,
    }));
  }
  if (Array.isArray(parsed.events)) {
    data.events = parsed.events.filter(isPlainObject).map((row) => ({
      id: String(row.id ?? ''),
      sessionId: row.sessionId == null ? null : String(row.sessionId),
      timestamp: Number(row.timestamp) || 0,
      content: String(row.content ?? ''),
      emotion: String(row.emotion ?? 'neutral'),
      importance: Number(row.importance) || 0.5,
      factId: row.factId == null ? null : String(row.factId),
    }));
  }
  if (Array.isArray(parsed.factVersions) || Array.isArray(parsed.fact_versions)) {
    const src = Array.isArray(parsed.factVersions) ? parsed.factVersions : parsed.fact_versions;
    data.factVersions = src.filter(isPlainObject).map((row) => ({
      id: String(row.id ?? ''),
      factId: String(row.factId ?? ''),
      content: String(row.content ?? ''),
      category: String(row.category ?? 'general'),
      tags: typeof row.tags === 'string' ? row.tags : JSON.stringify(row.tags ?? []),
      trust: Number(row.trust) || 0,
      source: String(row.source ?? ''),
      validFrom: Number(row.validFrom) || 0,
      validTo: row.validTo == null ? null : Number(row.validTo),
      recordedAt: Number(row.recordedAt) || 0,
      reason: row.reason == null ? null : String(row.reason),
    }));
  }
  if (isPlainObject(parsed.meta)) {
    for (const [key, value] of Object.entries(parsed.meta)) data.meta[key] = value;
  } else if (Array.isArray(parsed.meta)) {
    for (const row of parsed.meta) {
      if (isPlainObject(row) && row.key != null) data.meta[String(row.key)] = decodeMeta(row.value);
    }
  }
  return data;
}

async function readJsonFile(filePath, logger) {
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return emptyData();
    throw err;
  }
  if (typeof text !== 'string' || text.trim() === '') return emptyData();
  try {
    return normalizeData(JSON.parse(text));
  } catch {
    logger.warn('dsh-memory: memory store ' + filePath + ' is not valid JSON; starting empty');
    return emptyData();
  }
}

/**
 * On Windows a replace-rename fails with EPERM/EACCES while another handle (a reader,
 * an editor or the AV scanner) still holds the destination. Retry briefly, then fall
 * back to clearing the destination so a save is never lost to a transient lock.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const transient = Boolean(err) && TRANSIENT_RENAME_CODES.has(err.code);
      if (!transient) throw err;
      if (attempt >= 20) {
        await fsp.rm(to, { force: true });
        await fsp.rename(from, to);
        return;
      }
      await sleep(Math.min(5 * (attempt + 1), 50));
    }
  }
}

async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const base = path.basename(filePath);
  const tmp = path.join(dir, base + '.' + process.pid + '.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.tmp');
  const text = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    meta: data.meta,
    facts: data.facts,
    entities: data.entities,
    fact_entities: data.factEntities,
    relations: data.relations,
  }, null, 2) + '\n';
  try {
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, filePath);
  } catch (err) {
    try { await fsp.rm(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

class JsonBackend {
  constructor(storePath, logger) {
    this.kind = 'json';
    this.path = storePath;
    this.logger = logger;
    this.data = null;
    // Set by run()/exec(); the Store's serialised jobs flush it once they settle.
    this._dirty = false;
  }

  async init() {
    if (this.data) return;
    await fsp.mkdir(path.dirname(this.path), { recursive: true });
    this.data = await readJsonFile(this.path, this.logger);
  }

  async _flush() {
    await writeJsonAtomic(this.path, this.data);
  }

  async snapshot() {
    const data = this.data || emptyData();
    return {
      facts: data.facts.map((row) => ({ ...row, tags: row.tags.slice() })),
      entities: data.entities.map((row) => ({ ...row })),
      factEntities: data.factEntities.map((row) => ({ ...row })),
      relations: data.relations.map((row) => ({ ...row })),
      feedbacks: (data.feedbacks || []).map((row) => ({ ...row })),
      edges: (data.edges || []).map((row) => ({ ...row })),
      events: (data.events || []).map((row) => ({ ...row })),
      factVersions: (data.factVersions || []).map((row) => ({ ...row })),
      meta: { ...data.meta },
    };
  }

  async getFactRow(id) {
    const row = this.data.facts.find((f) => f.id === id);
    return row ? { ...row, tags: row.tags.slice() } : null;
  }

  async putFact(row) {
    const index = this.data.facts.findIndex((f) => f.id === row.id);
    if (index >= 0) this.data.facts[index] = row; else this.data.facts.push(row);
    await this._flush();
  }

  async deleteFact(id) {
    const before = this.data.facts.length;
    this.data.facts = this.data.facts.filter((f) => f.id !== id);
    const removed = this.data.facts.length !== before;
    if (removed) await this._flush();
    return removed;
  }

  async getEntityRow(id) {
    const row = this.data.entities.find((e) => e.id === id);
    return row ? { ...row } : null;
  }

  async putEntity(row) {
    const index = this.data.entities.findIndex((e) => e.id === row.id);
    if (index >= 0) this.data.entities[index] = row; else this.data.entities.push(row);
    await this._flush();
  }

  async deleteEntity(id) {
    const before = this.data.entities.length;
    this.data.entities = this.data.entities.filter((e) => e.id !== id);
    if (this.data.entities.length !== before) await this._flush();
  }

  async linkFactEntity(factId, entityId) {
    const exists = this.data.factEntities.some((l) => l.factId === factId && l.entityId === entityId);
    if (exists) return;
    this.data.factEntities.push({ factId, entityId });
    await this._flush();
  }

  async unlinkFactEntity(factId, entityId) {
    const before = this.data.factEntities.length;
    this.data.factEntities = this.data.factEntities.filter((l) => !(l.factId === factId && l.entityId === entityId));
    if (this.data.factEntities.length !== before) await this._flush();
  }

  async clearFactEntities(factId) {
    const before = this.data.factEntities.length;
    this.data.factEntities = this.data.factEntities.filter((l) => l.factId !== factId);
    if (this.data.factEntities.length !== before) await this._flush();
  }

  async setMeta(key, value) {
    this.data.meta[key] = value;
    await this._flush();
  }

  /*
   * The archive / cleanup / contradiction / feedback helpers above are written against
   * the SQLite backend's `all(sql)` / `run(sql, params)` interface. The JSON backend had
   * no such methods, so on a machine without node:sqlite those calls threw and the whole
   * maintenance pass (and clicking a fact's vote button) failed silently.
   *
   * Rather than fork every caller, the JSON backend implements the handful of SQL
   * statements those helpers actually use, translating them to plain array work. The
   * surface is deliberately tiny and explicit: an unrecognised statement throws loudly
   * instead of pretending to succeed.
   */
  all(sql, params = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    if (/^SELECT .* FROM facts WHERE archived = 0$/i.test(q) || /^SELECT id, trust, createdAt, permanent, source, accessCount, archived FROM facts WHERE archived = 0$/i.test(q)) {
      return this.data.facts
        .filter((f) => !(f.archived || 0))
        .map((f) => ({
          id: f.id, trust: f.trust, createdAt: f.createdAt, permanent: f.permanent || 0,
          source: f.source, accessCount: f.accessCount || 0, archived: f.archived || 0,
        }));
    }
    if (/^SELECT id, fromId, toId, type, createdAt FROM edges/i.test(q)) {
      const all = (this.data.edges || []).slice();
      // The only caller passes [factId, factId] and filters either endpoint.
      const wanted = params && params.length > 0 ? String(params[0]) : null;
      const rows = wanted === null
        ? all
        : all.filter((e) => String(e.fromId) === wanted || String(e.toId) === wanted);
      return rows.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    if (/^SELECT id, sessionId, timestamp, content, emotion, importance, factId FROM events/i.test(q)) {
      let rows = (this.data.events || []).slice();
      // listEvents(): WHERE sessionId = ? then ORDER BY timestamp DESC LIMIT ?
      // Params are [sessionId?] then limit, so the last param is always the limit.
      const limit = Number(params[params.length - 1]) || 50;
      if (params.length === 2) rows = rows.filter((e) => String(e.sessionId) === String(params[0]));
      return rows
        .slice()
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, limit);
    }
    if (/^SELECT id, factId, content, category, tags, trust, source, validFrom, validTo, recordedAt, reason FROM fact_versions/i.test(q)) {
      const wanted = params && params.length > 0 ? String(params[0]) : null;
      return (this.data.factVersions || [])
        .filter((v) => wanted === null || String(v.factId) === wanted)
        .slice()
        .sort((a, b) => (a.validFrom || 0) - (b.validFrom || 0));
    }
    throw new Error('dsh-memory: JSON backend does not implement this query: ' + q);
  }

  run(sql, params = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    if (/^UPDATE facts SET archived = 1 WHERE id = \?$/i.test(q)) {
      const row = this.data.facts.find((f) => f.id === params[0]);
      if (!row) return { changes: 0 };
      row.archived = 1;
      this._dirty = true;
      return { changes: 1 };
    }
    if (/^UPDATE facts SET trust = trust \* 0\.3 WHERE id = \? AND permanent = 0$/i.test(q)) {
      const row = this.data.facts.find((f) => f.id === params[0]);
      if (!row || row.permanent) return { changes: 0 };
      row.trust = Math.max(0, Math.min(1, (row.trust ?? 0.5) * 0.3));
      this._dirty = true;
      return { changes: 1 };
    }
    if (/^UPDATE facts SET trust = MAX\(0, MIN\(1, trust \+ \?\)\) WHERE id = \? AND permanent = 0$/i.test(q)) {
      const row = this.data.facts.find((f) => f.id === params[1]);
      if (!row || row.permanent) return { changes: 0 };
      row.trust = Math.max(0, Math.min(1, (row.trust ?? 0.5) + Number(params[0])));
      this._dirty = true;
      return { changes: 1 };
    }
    if (/^DELETE FROM facts WHERE archived = 0 AND permanent = 0 AND trust < 0\.15 AND accessCount = 0 AND createdAt < \?$/i.test(q)) {
      const cutoff = Number(params[0]);
      const before = this.data.facts.length;
      // Keep everything EXCEPT rows that match all four deletion conditions.
      this.data.facts = this.data.facts.filter((f) => {
        const stale = !(f.archived || 0)
          && !(f.permanent || 0)
          && (f.trust ?? 0.5) < 0.15
          && (f.accessCount || 0) === 0
          && (f.createdAt || 0) < cutoff;
        return !stale;
      });
      const changes = before - this.data.facts.length;
      if (changes > 0) this._dirty = true;
      return { changes };
    }
    if (/^UPDATE fact_versions SET validTo = \? WHERE factId = \? AND validTo IS NULL$/i.test(q)) {
      const [now, factId] = params;
      let changes = 0;
      for (const v of (this.data.factVersions || [])) {
        if (String(v.factId) === String(factId) && v.validTo == null) { v.validTo = now; changes += 1; }
      }
      if (changes) this._dirty = true;
      return { changes };
    }
    if (/^UPDATE fact_versions SET validTo = \?, reason = \? WHERE factId = \? AND validTo IS NULL$/i.test(q)) {
      const [now, reason, factId] = params;
      let changes = 0;
      for (const v of (this.data.factVersions || [])) {
        if (String(v.factId) === String(factId) && v.validTo == null) { v.validTo = now; v.reason = reason; changes += 1; }
      }
      if (changes) this._dirty = true;
      return { changes };
    }
    if (/^INSERT INTO fact_versions /i.test(q)) {
      (this.data.factVersions ||= []).push({
        id: params[0], factId: String(params[1]), content: params[2], category: params[3],
        tags: params[4], trust: params[5], source: params[6],
        validFrom: params[7], validTo: params[8], recordedAt: params[9], reason: params[10],
      });
      this._dirty = true;
      return { changes: 1 };
    }
    if (/^INSERT INTO feedbacks /i.test(q)) {
      (this.data.feedbacks ||= []).push({
        id: params[0], factId: params[1], vote: params[2], query: params[3], createdAt: params[4],
      });
      this._dirty = true;
      return { changes: 1 };
    }
    if (/^INSERT INTO events /i.test(q)) {
      (this.data.events ||= []).push({
        id: params[0], sessionId: params[1], timestamp: params[2], content: params[3],
        emotion: params[4], importance: params[5], factId: params[6],
      });
      this._dirty = true;
      return { changes: 1 };
    }
    if (/^INSERT OR IGNORE INTO edges /i.test(q)) {
      (this.data.edges ||= []);
      const [id, fromId, toId, type, createdAt] = params;
      // Mirror SQLite's UNIQUE(fromId, toId, type): an identical edge is a no-op.
      const dup = this.data.edges.some((e) => e.fromId === fromId && e.toId === toId && e.type === type);
      if (dup) return { changes: 0 };
      this.data.edges.push({ id, fromId, toId, type, createdAt });
      this._dirty = true;
      return { changes: 1 };
    }
    throw new Error('dsh-memory: JSON backend does not implement this statement: ' + q);
  }

  exec(sql) {
    return this.run(sql);
  }

  // JSON backend: embeddings stored inline on each fact row as a Float32Array-derived array.
  //
  // HISTORY: these were all no-ops, so a machine without node:sqlite lost the semantic channel
  // entirely — and measurement showed HRR cannot bridge synonyms (语言 vs 中文), so those
  // environments were a whole tier weaker. Storing the vector on the row costs nothing extra
  // (the JSON file already round-trips the whole row) and makes the two backends comparable.
  async updateEmbedding(id, vec, model) {
    const row = this.data.facts.find((f) => f.id === String(id));
    if (!row) return false;
    if (vec == null) {
      row.embedding = null;
      row.embedModel = null;
    } else {
      // Store as a plain array: JSON cannot round-trip a Float32Array.
      row.embedding = Array.from(vec);
      row.embedModel = model == null ? null : String(model);
    }
    this._dirty = true;
    await this._flush();
    return true;
  }

  async listFactsNeedingEmbedding(currentModel = '') {
    return this.data.facts
      .filter((f) => !(f.archived || 0))
      .filter((f) => !Array.isArray(f.embedding) || f.embedding.length === 0 || (currentModel && f.embedModel !== currentModel))
      .map((f) => ({ id: String(f.id), content: String(f.content ?? '') }));
  }

  async getFactEmbedding(id) {
    const row = this.data.facts.find((f) => f.id === String(id));
    if (!row || !Array.isArray(row.embedding)) return null;
    return new Float32Array(row.embedding);
  }

  async listAllEmbeddings() {
    const out = [];
    for (const f of this.data.facts) {
      if (!Array.isArray(f.embedding) || f.embedding.length === 0) continue;
      out.push({ id: String(f.id), embedding: new Float32Array(f.embedding), embedModel: f.embedModel ?? null });
    }
    return out;
  }

  async countEmbeddings() {
    return this.data.facts.filter((f) => Array.isArray(f.embedding) && f.embedding.length > 0).length;
  }

  async close() {
    /* every write is already flushed */
  }
}

/* ---------------------------------------------------------- sqlite backend */

class SqliteBackend {
  constructor(storePath, DatabaseSync) {
    this.kind = 'sqlite';
    this.path = storePath;
    this.DatabaseSync = DatabaseSync;
    this.db = null;
    this.stmts = new Map();
  }

  async init() {
    if (this.db) return;
    await fsp.mkdir(path.dirname(this.path), { recursive: true });
    const db = new this.DatabaseSync(this.path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    for (const sql of SQLITE_SCHEMA) db.exec(sql);
    // Migration: add new columns if missing
    for (const m of MIGRATIONS) {
      try { db.exec(m.ddl); } catch { /* column already exists */ }
    }
    this.db = db;
    this.stmts = new Map();
  }

  _db() {
    if (!this.db) throw new Error('dsh-memory: sqlite store is not open (call init() first)');
    return this.db;
  }

  /** Run a parameterized write (INSERT/UPDATE/DELETE). */
  run(sql, params = []) {
    return this._db().prepare(sql).run(...params);
  }

  /** Run a parameterized query, return all rows. */
  all(sql, params = []) {
    return this._db().prepare(sql).all(...params);
  }

  /** Execute raw SQL (DDL / no params). */
  exec(sql) {
    return this._db().exec(sql);
  }

  _prep(sql) {
    let stmt = this.stmts.get(sql);
    if (!stmt) {
      stmt = this._db().prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  async snapshot() {
    const facts = this._db().prepare('SELECT id, content, category, tags, trust, source, createdAt, updatedAt, searchCount, helpfulCount, accessCount, lastHitAt, muted, bodyStr, sumStr, kwStr, permanent, archived, superseded, supersededBy, hash FROM facts').all().map(normalizeFactRow);
    const entities = this._db().prepare('SELECT id, name, kind, factCount, createdAt, updatedAt FROM entities').all().map(normalizeEntityRow);
    const factEntities = this._db().prepare('SELECT factId, entityId FROM fact_entities').all()
      .map((row) => ({ factId: String(row.factId), entityId: String(row.entityId) }));
    const relations = this._db().prepare('SELECT id, fromName, toName, relation, factId, createdAt FROM relations').all().map(normalizeRelationRow);
    const feedbacks = this._db().prepare('SELECT id, factId, vote, query, createdAt FROM feedbacks').all()
      .map((row) => ({ ...row }));
    const meta = {};
    for (const row of this._db().prepare('SELECT key, value FROM meta').all()) {
      meta[String(row.key)] = decodeMeta(row.value);
    }
    return { facts, entities, factEntities, relations, feedbacks, meta };
  }

  async getFactRow(id) {
    const row = this._prep('SELECT id, content, category, tags, trust, source, createdAt, updatedAt, searchCount, helpfulCount, accessCount, lastHitAt, muted, bodyStr, sumStr, kwStr, permanent, archived, superseded, supersededBy, hash FROM facts WHERE id = ?').get(id);
    return row ? normalizeFactRow(row) : null;
  }

  async putFact(row) {
    this._prep('INSERT INTO facts (id, content, category, tags, trust, source, createdAt, updatedAt, searchCount, helpfulCount, accessCount, lastHitAt, muted, bodyStr, sumStr, kwStr, permanent, archived, superseded, supersededBy, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, category = excluded.category, tags = excluded.tags, trust = excluded.trust, source = excluded.source, updatedAt = excluded.updatedAt, searchCount = excluded.searchCount, helpfulCount = excluded.helpfulCount, accessCount = excluded.accessCount, lastHitAt = excluded.lastHitAt, muted = excluded.muted, bodyStr = excluded.bodyStr, sumStr = excluded.sumStr, kwStr = excluded.kwStr, permanent = excluded.permanent, archived = excluded.archived, superseded = excluded.superseded, supersededBy = excluded.supersededBy')
      .run(row.id, row.content, row.category, JSON.stringify(row.tags), row.trust, row.source, row.createdAt, row.updatedAt, row.searchCount, row.helpfulCount, row.accessCount || 0, row.lastHitAt || 0, row.muted || 0, row.bodyStr ?? 1.0, row.sumStr ?? 1.0, row.kwStr ?? 1.0, row.permanent || 0, row.archived || 0, row.superseded || 0, row.supersededBy ?? null, row.hash);
  }

  async deleteFact(id) {
    const result = this._prep('DELETE FROM facts WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  async getEntityRow(id) {
    const row = this._prep('SELECT id, name, kind, factCount, createdAt, updatedAt FROM entities WHERE id = ?').get(id);
    return row ? normalizeEntityRow(row) : null;
  }

  async putEntity(row) {
    this._prep('INSERT INTO entities (id, name, kind, factCount, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, factCount = excluded.factCount, updatedAt = excluded.updatedAt')
      .run(row.id, row.name, row.kind, row.factCount, row.createdAt, row.updatedAt);
  }

  async deleteEntity(id) {
    this._prep('DELETE FROM entities WHERE id = ?').run(id);
  }

  async linkFactEntity(factId, entityId) {
    this._prep('INSERT OR IGNORE INTO fact_entities (factId, entityId) VALUES (?, ?)').run(factId, entityId);
  }

  async unlinkFactEntity(factId, entityId) {
    this._prep('DELETE FROM fact_entities WHERE factId = ? AND entityId = ?').run(factId, entityId);
  }

  async clearFactEntities(factId) {
    this._prep('DELETE FROM fact_entities WHERE factId = ?').run(factId);
  }

  async setMeta(key, value) {
    this._prep('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, encodeMeta(value));
  }

  // ------------------------------------------------------- embedding (Phase 2.0)
  async updateEmbedding(id, vec /* Float32Array | null */, model) {
    const blob = vec ? Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength) : null;
    this._prep('UPDATE facts SET embedding = ?, embedModel = ? WHERE id = ?').run(blob, model, String(id));
  }

  async listFactsNeedingEmbedding(currentModel = '') {
    const rows = currentModel
      ? this._prep("SELECT id, content FROM facts WHERE archived = 0 AND (embedding IS NULL OR embedModel IS NULL OR embedModel != ?)").all(currentModel)
      : this._prep("SELECT id, content FROM facts WHERE archived = 0 AND (embedding IS NULL OR embedModel IS NULL)").all();
    return rows.map((row) => ({ id: String(row.id), content: String(row.content ?? '') }));
  }

  async getFactEmbedding(id) {
    const row = this._prep('SELECT embedding FROM facts WHERE id = ?').get(String(id));
    if (!row || !row.embedding) return null;
    const buf = Buffer.from(row.embedding);
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }

  async listAllEmbeddings() {
    return this._prep('SELECT id, embedding FROM facts WHERE embedding IS NOT NULL AND archived = 0').all()
      .map((row) => {
        const buf = Buffer.from(row.embedding);
        return { id: String(row.id), vec: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) };
      });
  }

  async countEmbeddings() {
    const row = this._prep('SELECT COUNT(*) as n FROM facts WHERE embedding IS NOT NULL AND archived = 0').get();
    return Number(row?.n ?? 0);
  }

  async close() {
    const db = this.db;
    this.db = null;
    this.stmts = new Map();
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
  }
}

/* -------------------------------------------------------------- sqlite probe */

let sqliteModule;
let sqliteProbed = false;

async function probeSqlite(logger) {
  if (!sqliteProbed) {
    sqliteProbed = true;
    try {
      const mod = await import('node:sqlite');
      sqliteModule = mod && typeof mod.DatabaseSync === 'function' ? mod : null;
    } catch {
      sqliteModule = null;
    }
    if (!sqliteModule) logger.warn('dsh-memory: node:sqlite is unavailable; using the JSON store');
  }
  return sqliteModule;
}

/* ------------------------------------------------------------------- logger */

function makeLogger(raw) {
  const noop = () => {};
  if (!isPlainObject(raw)) return { info: noop, warn: noop, error: noop };
  const wrap = (fn) => {
    if (typeof fn !== 'function') return noop;
    return (...args) => {
      try { fn.apply(raw, args); } catch { /* never let logging break the store */ }
    };
  };
  return { info: wrap(raw.info), warn: wrap(raw.warn), error: wrap(raw.error) };
}

/* -------------------------------------------------------------------- Store */

class Store {
  constructor(options) {
    this.cfg = options.cfg;
    this.backendKind = options.backendKind;
    this.path = options.storePath;
    this.logger = options.logger;
    this.now = options.now;
    this.backend = options.backendKind === 'sqlite'
      ? new SqliteBackend(options.storePath, options.DatabaseSync)
      : new JsonBackend(options.storePath, options.logger);
    this._initPromise = null;
    this._chain = Promise.resolve();
    this._lastTs = 0;
  }

  _serial(fn) {
    // The JSON backend's run()/exec() mutate memory synchronously (they must, to keep
    // the SQLite-shaped `const result = backend.run(...)` contract), so the write is
    // flushed once when the serialised job settles. Without this, archival and vote
    // adjustments would live in memory only and vanish on restart.
    const flushIfDirty = async () => {
      const backend = this.backend;
      // SQLite commits inside run(); only the JSON backend defers the write.
      if (backend.kind !== 'json' || !backend._dirty) return;
      backend._dirty = false;
      try {
        await backend._flush();
      } catch { /* next successful write will retry */ }
    };
    const run = this._chain.then(fn, fn).then((value) => flushIfDirty().then(() => value));
    this._chain = run.then(() => undefined, () => undefined);
    return run;
  }

  _now() {
    try {
      const value = Number(this.now());
      if (Number.isFinite(value)) return Math.trunc(value);
    } catch { /* fall through to wall clock */ }
    return Date.now();
  }

  _nextTs() {
    const value = this._now();
    this._lastTs = value > this._lastTs ? value : this._lastTs + 1;
    return this._lastTs;
  }

  async init() {
    if (!this._initPromise) {
      this._initPromise = this._doInit().catch((err) => {
        this._initPromise = null;
        throw err;
      });
    }
    return this._initPromise;
  }

  async _doInit() {
    await this.backend.init();
    const snapshot = await this.backend.snapshot();
    const snapshotAt = Number(snapshot.meta.snapshotAt);
    if (!Number.isFinite(snapshotAt) || snapshotAt <= 0) {
      await this.backend.setMeta('snapshotAt', this._now());
    }
    if (Number(snapshot.meta.schemaVersion) !== SCHEMA_VERSION) {
      await this.backend.setMeta('schemaVersion', SCHEMA_VERSION);
    }
    let maxTs = 0;
    for (const fact of snapshot.facts) maxTs = Math.max(maxTs, fact.createdAt, fact.updatedAt);
    for (const entity of snapshot.entities) maxTs = Math.max(maxTs, entity.createdAt, entity.updatedAt);
    this._lastTs = maxTs;
    return this;
  }

  async stats() {
    await this.init();
    const snapshot = await this.backend.snapshot();
    // Retrievable facts only: archived rows are kept on disk for audits and exports but
    // must not inflate the counts the panel and the model's instructions show.
    const live = snapshot.facts.filter((f) => !(f.archived || 0));
    const counts = new Map();
    for (const fact of live) counts.set(fact.category, (counts.get(fact.category) || 0) + 1);
    const categories = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (b.count - a.count) || compareStrings(a.name, b.name));
    const sources = [...new Set(live.map((fact) => fact.source))].sort(compareStrings);
    const autoExtract = isPlainObject(this.cfg) && this.cfg.autoExtract !== undefined
      ? Boolean(this.cfg.autoExtract)
      : false;
    return {
      backend: this.backendKind,
      path: this.path,
      facts: live.length,
      archived: snapshot.facts.length - live.length,
      entities: snapshot.entities.length,
      relations: snapshot.relations.length,
      categories,
      sources,
      snapshotAt: toInt(snapshot.meta.snapshotAt),
      autoExtract,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  async queryFacts(opts = {}) {
    await this.init();
    const snapshot = await this.backend.snapshot();
    return queryFactsCore(snapshot, opts);
  }

  async getFact(id) {
    await this.init();
    const wanted = String(id);
    const snapshot = await this.backend.snapshot();
    const found = mapFacts(snapshot).find((fact) => fact.id === wanted);
    return found || null;
  }

  /** Batch fetch by ids — avoids N+1 in embedding recall. */
  async getFactsByIds(ids) {
    await this.init();
    const wanted = new Set(ids.map(String));
    const snapshot = await this.backend.snapshot();
    return mapFacts(snapshot).filter((f) => wanted.has(f.id));
  }

  async upsertFact(input = {}) {
    return this._serial(async () => {
      await this.init();
      if (!isPlainObject(input)) throw new Error('dsh-memory: upsertFact(input) requires an object');
      const content = typeof input.content === 'string' ? input.content : String(input.content == null ? '' : input.content);
      if (content.trim() === '') throw new Error('dsh-memory: upsertFact requires non-empty content');
      const hash = hashContent(content);
      const id = factIdFor(hash);
      const now = this._nextTs();
      const existing = await this.backend.getFactRow(id);
      const row = {
        id,
        content,
        category: normalizeCategory(input.category),
        tags: normalizeTags(input.tags),
        trust: normalizeTrust(input.trust),
        source: normalizeSource(input.source),
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
        searchCount: existing ? existing.searchCount : 0,
        helpfulCount: existing ? existing.helpfulCount : 0,
        // Lifecycle columns must survive a content re-upsert: accessCount feeds the
        // β=2 recall cap and the permanent promotion, muted feeds the recall filter,
        // and permanent shields a fact from trust decay. Dropping them reset every
        // fact's recall state each time the same content was written again.
        accessCount: existing ? (existing.accessCount || 0) : 0,
        lastHitAt: existing ? (existing.lastHitAt || 0) : 0,
        muted: existing ? (existing.muted || 0) : 0,
        permanent: existing ? (existing.permanent || 0) : 0,
        bodyStr: existing ? (existing.bodyStr ?? 1.0) : 1.0,
        sumStr: existing ? (existing.sumStr ?? 1.0) : 1.0,
        kwStr: existing ? (existing.kwStr ?? 1.0) : 1.0,
        // Re-recording archived content revives it: an explicit write is fresh evidence
        // that the fact still matters.
        archived: 0,
        // A retired fact does NOT come back just because the same sentence was written
        // again — the user has to state the correction, not repeat the old wording. Only
        // setFactSuperseded(id, false) restores it.
        superseded: existing ? (existing.superseded || 0) : 0,
        supersededBy: existing ? (existing.supersededBy ?? null) : null,
        hash,
      };
      await this.backend.putFact(row);
      // Bitemporal history: a NEW fact is a new revision; a content change to an existing
      // one closes the previous revision. Same-content re-upserts do not create noise.
      const contentChanged = !existing || String(existing.content ?? '') !== String(row.content ?? '');
      if (contentChanged) {
        await this._recordVersionUnsafe(row, now, existing ? 'content-updated' : 'created');
      }
      await this._syncEntities(id, extractEntities(content), now);
      const snapshot = await this.backend.snapshot();
      const found = mapFacts(snapshot).find((fact) => fact.id === id);
      return found || factFromRow(row, []);
    });
  }

  async _syncEntities(factId, names, now) {
    const snapshot = await this.backend.snapshot();
    const byName = new Map();
    for (const entity of snapshot.entities) {
      const key = entity.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, entity);
    }
    const wanted = new Set();
    for (const name of names) {
      const key = name.toLowerCase();
      let entity = byName.get(key);
      if (!entity) {
        entity = { id: entityIdFor(name), name, kind: 'topic', factCount: 0, createdAt: now, updatedAt: now };
        await this.backend.putEntity(entity);
        byName.set(key, entity);
      }
      wanted.add(entity.id);
    }
    const existing = new Set(snapshot.factEntities.filter((link) => link.factId === factId).map((link) => link.entityId));
    for (const entityId of wanted) {
      if (!existing.has(entityId)) await this.backend.linkFactEntity(factId, entityId);
    }
    for (const entityId of existing) {
      if (!wanted.has(entityId)) await this.backend.unlinkFactEntity(factId, entityId);
    }
    await this._recountEntities(now);
  }

  async _recountEntities(now) {
    const snapshot = await this.backend.snapshot();
    const counts = new Map();
    for (const link of snapshot.factEntities) counts.set(link.entityId, (counts.get(link.entityId) || 0) + 1);
    for (const entity of snapshot.entities) {
      const count = counts.get(entity.id) || 0;
      if (count === 0) await this.backend.deleteEntity(entity.id);
      else if (entity.factCount !== count) await this.backend.putEntity({ ...entity, factCount: count, updatedAt: now });
    }
  }

  async deleteFact(id) {
    return this._serial(async () => {
      await this.init();
      const removed = await this.backend.deleteFact(String(id));
      if (removed) {
        await this.backend.clearFactEntities(String(id));
        await this._recountEntities(this._now());
      }
      return removed;
    });
  }

  async bumpFact(id, field) {
    if (field !== 'searchCount' && field !== 'helpfulCount') return null;
    return this._serial(async () => {
      await this.init();
      const existing = await this.backend.getFactRow(String(id));
      if (!existing) return null;
      const row = { ...existing, [field]: toCount(existing[field]) + 1 };
      await this.backend.putFact(row);
      const snapshot = await this.backend.snapshot();
      const found = mapFacts(snapshot).find((fact) => fact.id === row.id);
      return found || null;
    });
  }

  async setFactTrust(id, trust) {
    return this._serial(async () => {
      await this.init();
      const existing = await this.backend.getFactRow(String(id));
      if (!existing) return null;
      const t = Math.max(0, Math.min(1, Number(trust) || 0));
      const row = { ...existing, trust: t };
      await this.backend.putFact(row);
      const snapshot = await this.backend.snapshot();
      const found = mapFacts(snapshot).find((fact) => fact.id === row.id);
      return found || null;
    });
  }

  /**
   * Recall hit: count it and stamp the time.
   *
   * HISTORY: `accessCount` used to stop counting at 2 (a "β=2" cap carried over from the
   * reference design). That made the counter useless for the only question worth asking —
   * "is this memory actually used?" — because a fact recalled twice on the day it was
   * written and a fact recalled twice every week for a year looked identical. Decay's
   * usage-awareness (lib/decay.js) cannot work without a real number here.
   *
   * The counter now grows without a cap, but the STORED value saturates (see USAGE_SATURATION)
   * so the column stays bounded and old rows never overflow.
   */
  async bumpAccessCount(id) {
    return this._serial(async () => {
      await this.init();
      const existing = await this.backend.getFactRow(String(id));
      if (!existing) return null;
      const current = existing.accessCount || 0;
      const row = {
        ...existing,
        accessCount: current >= USAGE_SATURATION ? USAGE_SATURATION : current + 1,
        lastHitAt: this._now(),
      };
      await this.backend.putFact(row);
      const snapshot = await this.backend.snapshot();
      const found = mapFacts(snapshot).find((fact) => fact.id === row.id);
      return found || null;
    });
  }

  /** Promote a fact to permanent (exempt from decay / trust-adjustment) or revoke it. */
  async setFactPermanent(id, permanent = true) {
    return this._serial(async () => {
      await this.init();
      const existing = await this.backend.getFactRow(String(id));
      if (!existing) return null;
      const row = { ...existing, permanent: permanent ? 1 : 0 };
      await this.backend.putFact(row);
      const snapshot = await this.backend.snapshot();
      const found = mapFacts(snapshot).find((fact) => fact.id === row.id);
      return found || null;
    });
  }

  /** Mark fact as muted (user said "don't bring this up again") — skip in recall, not deleted. */
  async setFactMuted(id, muted = true) {
    return this._serial(async () => {
      await this.init();
      const existing = await this.backend.getFactRow(String(id));
      if (!existing) return null;
      const row = { ...existing, muted: muted ? 1 : 0 };
      await this.backend.putFact(row);
      const snapshot = await this.backend.snapshot();
      const found = mapFacts(snapshot).find((fact) => fact.id === row.id);
      return found || null;
    });
  }

  /** Get recent facts ordered by updatedAt desc, for dedup window. */
  async listRecentFacts(limit = 60) {
    await this.init();
    const snapshot = await this.backend.snapshot();
    return mapFacts(snapshot)
      .filter((f) => !f.archived && !f.muted)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  async listEntities(opts = {}) {
    await this.init();
    const snapshot = await this.backend.snapshot();
    const q = typeof opts.q === 'string' ? opts.q.trim().toLowerCase() : '';
    const limit = clampInt(opts.limit, DEFAULT_LIMIT, 0, MAX_LIMIT);
    let list = snapshot.entities.map(entityFromRow);
    if (q !== '') list = list.filter((entity) => entity.name.toLowerCase().includes(q));
    list.sort((a, b) => (b.factCount - a.factCount) || compareStrings(a.name, b.name) || compareIds(a, b));
    return list.slice(0, limit);
  }

  async listRelations(opts = {}) {
    await this.init();
    const snapshot = await this.backend.snapshot();
    const limit = clampInt(opts.limit, DEFAULT_LIMIT, 0, MAX_LIMIT);
    return snapshot.relations
      .map(normalizeRelationRow)
      .sort((a, b) => (b.createdAt - a.createdAt) || compareIds(a, b))
      .slice(0, limit);
  }

  /**
   * Write one revision row and close the previous one.
   *
   * Called from inside an existing `_serial` job (never on its own), so it must not
   * re-enter the chain.
   */
  async _recordVersionUnsafe(row, now, reason) {
    try {
      // Close the open revision for this fact.
      this.backend.run(
        'UPDATE fact_versions SET validTo = ? WHERE factId = ? AND validTo IS NULL',
        [now, String(row.id)],
      );
      this.backend.run(
        'INSERT INTO fact_versions (id, factId, content, category, tags, trust, source, validFrom, validTo, recordedAt, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          'ver_' + randomUUID(), String(row.id), String(row.content ?? ''),
          String(row.category ?? 'general'), JSON.stringify(row.tags ?? []),
          Number(row.trust ?? 0.6), String(row.source ?? 'manual'),
          now, null, now, reason == null ? null : String(reason),
        ],
      );
    } catch { /* history is a nicety; never let it break a write */ }
  }

  /**
   * Every revision of one fact, oldest first. This is what makes "以前是怎么定的" answerable
   * with the ACTUAL former wording, not just a pointer to the fact that replaced it.
   */
  async listFactVersions(id) {
    await this.init();
    const rows = this.backend.all(
      'SELECT id, factId, content, category, tags, trust, source, validFrom, validTo, recordedAt, reason FROM fact_versions WHERE factId = ? ORDER BY validFrom ASC',
      [String(id)],
    );
    return (Array.isArray(rows) ? rows : []).map((r) => {
      let tags = [];
      try { tags = JSON.parse(r.tags ?? '[]'); } catch { /* keep [] */ }
      return {
        id: String(r.id),
        factId: String(r.factId),
        content: String(r.content ?? ''),
        category: String(r.category ?? 'general'),
        tags: Array.isArray(tags) ? tags : [],
        trust: Number(r.trust ?? 0),
        source: String(r.source ?? ''),
        validFrom: Number(r.validFrom) || 0,
        validTo: r.validTo == null ? null : Number(r.validTo),
        recordedAt: Number(r.recordedAt) || 0,
        reason: r.reason == null ? null : String(r.reason),
      };
    });
  }

  /** What did we believe about this fact at a given instant? */
  async factAsOf(id, at) {
    const versions = await this.listFactVersions(id);
    const when = Number(at) || Date.now();
    let found = null;
    for (const v of versions) {
      if (v.validFrom <= when && (v.validTo == null || v.validTo > when)) { found = v; break; }
    }
    return found;
  }

  async touch() {
    return this._serial(async () => {
      await this.init();
      const now = this._now();
      await this.backend.setMeta('snapshotAt', now);
      return now;
    });
  }

  /**
   * Read/write arbitrary JSON in the `meta` table.
   *
   * Used for small pieces of plugin state that are not facts: the follow-up queue, the
   * consolidation watermark. Keeping them in meta means no schema migration and they travel
   * with export/import automatically.
   */
  async getMeta(key, fallback = null) {
    await this.init();
    const snapshot = await this.backend.snapshot();
    const value = snapshot?.meta?.[String(key)];
    return value == null ? fallback : value;
  }

  async putMeta(key, value) {
    return this._serial(async () => {
      await this.init();
      await this.backend.setMeta(String(key), value);
      return value;
    });
  }

  // ------------------------------------------------------- embedding passthrough
  async updateEmbedding(id, vec, model) {
    await this.init();
    return this.backend.updateEmbedding(id, vec, model);
  }

  async listFactsNeedingEmbedding(currentModel = '') {
    await this.init();
    return this.backend.listFactsNeedingEmbedding(currentModel);
  }

  async getFactEmbedding(id) {
    await this.init();
    return this.backend.getFactEmbedding(id);
  }

  async listAllEmbeddings() {
    await this.init();
    return this.backend.listAllEmbeddings();
  }

  async countEmbeddings() {
    await this.init();
    return this.backend.countEmbeddings();
  }

  // ------------------------------------------------------- events (情景记忆)
  async addEvent({ sessionId, content, emotion = 'neutral', importance = 0.5, factId = null }) {
    await this.init();
    const id = 'event_' + randomUUID();
    const ts = this._now();
    await this._serial(async () => {
      // run(), not exec(): SqliteBackend.exec(sql) takes no parameters, so events were
      // never actually written on the SQLite backend.
      await this.backend.run(
        'INSERT INTO events (id, sessionId, timestamp, content, emotion, importance, factId) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, sessionId || null, ts, String(content).slice(0, 500), emotion, importance, factId]
      );
    });
    return { id, sessionId, timestamp: ts, content, emotion, importance, factId };
  }

  async listEvents({ limit = 50, sessionId = null } = {}) {
    await this.init();
    let sql = 'SELECT id, sessionId, timestamp, content, emotion, importance, factId FROM events';
    const params = [];
    if (sessionId) { sql += ' WHERE sessionId = ?'; params.push(sessionId); }
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);
    return this.backend.all(sql, params);
  }

  // ------------------------------------------------------- edges (关系图)
  /**
   * Write one edge. Public and self-serialising, so call it from OUTSIDE a `_serial`
   * block only. `markContradiction` below needs an edge inside its own serialised job,
   * so the raw insert is factored out as `_writeEdgeUnsafe`.
   */
  async addEdge(fromId, toId, type) {
    await this.init();
    await this._serial(() => this._writeEdgeUnsafe(fromId, toId, type));
  }

  /** Non-serialising edge write: only call from inside an existing `_serial` job. */
  async _writeEdgeUnsafe(fromId, toId, type) {
    const id = 'edge_' + randomUUID();
    const ts = this._now();
    // Use run(), not exec(): SqliteBackend.exec(sql) takes no parameters, so the original
    // exec-with-params silently dropped every edge on the SQLite backend.
    await this.backend.run(
      'INSERT OR IGNORE INTO edges (id, fromId, toId, type, createdAt) VALUES (?, ?, ?, ?, ?)',
      [id, fromId, toId, type, ts]
    );
    return id;
  }

  async listEdges(factId) {
    await this.init();
    return this.backend.all(
      'SELECT id, fromId, toId, type, createdAt FROM edges WHERE fromId = ? OR toId = ? ORDER BY createdAt DESC',
      [factId, factId]
    );
  }

  // ------------------------------------------------------- archive
  /**
   * Archive facts that are BOTH old AND unused — never merely old.
   *
   * Archival used to run on the same multipled decay the recall path used, which
   * (a) silently retired 4-day-old facts and (b) could never fire in practice because
   * nothing called it. It now shares lib/decay.js with the recall ranking, requires an
   * explicit staleness threshold, and is invoked from the host's periodic maintenance
   * pass. Archived rows stay in the database (and in exports) — they are excluded from
   * retrieval, not destroyed.
   */
  async archiveOldFacts({ minAgeDays = ARCHIVE_MIN_AGE_DAYS, maxTrust = ARCHIVE_MAX_TRUST } = {}) {
    await this.init();
    return this._serial(async () => {
      const rows = this.backend.all(
        "SELECT id, trust, createdAt, permanent, source, accessCount, archived FROM facts WHERE archived = 0"
      );
      const now = Date.now();
      let archived = 0;
      const ids = [];
      for (const row of rows) {
        if (row.permanent === 1) continue;
        if (row.source === 'user') continue;
        // Any historical recall keeps a fact alive: being used is evidence it matters.
        if ((row.accessCount || 0) > 0) continue;
        const ageDays = ageInDays(row.createdAt, now);
        if (ageDays < minAgeDays) continue;
        if ((row.trust ?? 0.5) > maxTrust) continue;
        this.backend.run('UPDATE facts SET archived = 1 WHERE id = ?', [row.id]);
        ids.push(row.id);
        archived += 1;
      }
      return { archived, total: rows.length, ids };
    });
  }

  /** Hard-delete stale session facts: low trust + old + never accessed. */
  async cleanupStaleFacts(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    await this.init();
    return this._serial(async () => {
      const cutoff = Date.now() - maxAgeMs;
      const result = this.backend.run(
        "DELETE FROM facts WHERE archived = 0 AND permanent = 0 AND trust < 0.15 AND accessCount = 0 AND createdAt < ?",
        [cutoff]
      );
      const deleted = Number(result?.changes) || 0;
      // Keep the entity graph consistent: a hard delete would otherwise leave
      // fact_entities rows and entity factCounts pointing at facts that no longer exist.
      if (deleted > 0) {
        try { await this._recountEntities(this._now()); } catch { /* best effort */ }
      }
      return { deleted };
    });
  }

  /**
   * Retire a fact because a later statement replaced it.
   *
   * HISTORY: this used to multiply trust by 0.3 and stop there, which left the corrected
   * belief in the recall pool — so "改用 24550 端口" would be contradicted, down-weighted,
   * and then recited again from an older fact a week later. A superseded fact is now marked
   * `superseded = 1` and excluded from retrieval by default; it stays on disk (and in the
   * transcript) so "以前是怎么定的" remains answerable via `includeSuperseded`.
   */
  async markContradiction(oldId, newId) {
    await this.init();
    await this._serial(async () => {
      // Keep the trust penalty: if the fact is ever surfaced again it should look weak.
      this.backend.run('UPDATE facts SET trust = trust * 0.3 WHERE id = ? AND permanent = 0', [oldId]);
      this.backend.run('UPDATE facts SET superseded = 1, supersededBy = ? WHERE id = ? AND permanent = 0', [String(newId), oldId]);
      // Close the open revision so the history shows when this belief stopped being held.
      const now = this._now();
      try {
        this.backend.run(
          'UPDATE fact_versions SET validTo = ?, reason = ? WHERE factId = ? AND validTo IS NULL',
          [now, 'superseded-by:' + String(newId), String(oldId)],
        );
      } catch { /* history optional */ }
      // Inline (non-serialising) edge write: calling the public addEdge() here would
      // re-enter _serial while the current job still holds the chain and deadlock.
      await this._writeEdgeUnsafe(oldId, newId, 'contradicts');
    });
  }

  /** Explicitly retire (or restore) a fact without recording a contradiction. */
  async setFactSuperseded(id, superseded = true, supersededBy = null) {
    return this._serial(async () => {
      await this.init();
      const existing = await this.backend.getFactRow(String(id));
      if (!existing) return null;
      const row = {
        ...existing,
        superseded: superseded ? 1 : 0,
        supersededBy: superseded ? (supersededBy == null ? existing.supersededBy ?? null : String(supersededBy)) : null,
      };
      await this.backend.putFact(row);
      const snapshot = await this.backend.snapshot();
      return mapFacts(snapshot).find((fact) => fact.id === row.id) || null;
    });
  }

  // ------------------------------------------------------- feedbacks
  async addFeedback(factId, vote, query = '') {
    await this.init();
    const id = 'fb_' + randomUUID();
    const ts = this._now();
    await this._serial(async () => {
      this.backend.run('INSERT INTO feedbacks (id, factId, vote, query, createdAt) VALUES (?, ?, ?, ?, ?)',
        [id, String(factId), vote, String(query || ''), ts]);
      // Adjust trust: up +0.05, down -0.15 (clamp 0..1)
      const adj = vote === 'up' ? 0.05 : -0.15;
      this.backend.run('UPDATE facts SET trust = MAX(0, MIN(1, trust + ?)) WHERE id = ? AND permanent = 0',
        [adj, String(factId)]);
    });
    return { id, factId, vote, query };
  }

  async close() {
    try {
      await this.backend.close();
    } finally {
      this._initPromise = null;
    }
  }
}

/* ---------------------------------------------------------------- openStore */

/**
 * @param {object} cfg  resolveMemoryConfig() output. cfg.home is required unless an
 *                      explicit storePath is supplied.
 * @param {object} [options] { logger, backend, storePath, now }
 * @returns {Promise<Store>}
 */
export async function openStore(cfg, options = {}) {
  if (!isPlainObject(cfg)) throw new Error('dsh-memory: openStore(cfg) requires a config object');
  const opts = isPlainObject(options) ? options : {};
  const logger = makeLogger(opts.logger);
  const home = typeof cfg.home === 'string' && cfg.home.trim() !== '' ? cfg.home : null;
  const explicitPath = typeof opts.storePath === 'string' && opts.storePath.trim() !== '' ? opts.storePath : null;
  if (!home && !explicitPath) {
    throw new Error('dsh-memory: cfg.home is required by lib/store.js (the memory home was not resolved)');
  }

  let backendKind = opts.backend === 'sqlite' || opts.backend === 'json'
    ? opts.backend
    : (cfg.backend === 'sqlite' || cfg.backend === 'json' ? cfg.backend : null);

  let DatabaseSync = null;
  if (backendKind !== 'json') {
    const mod = await probeSqlite(logger);
    if (mod) {
      DatabaseSync = mod.DatabaseSync;
      if (!backendKind) backendKind = 'sqlite';
    } else if (!backendKind) {
      backendKind = 'json';
    }
  }
  if (backendKind === 'sqlite' && !DatabaseSync) {
    logger.warn('dsh-memory: sqlite was requested but is unavailable; falling back to the JSON store');
    backendKind = 'json';
  }

  const configuredPath = typeof cfg.storePath === 'string' && cfg.storePath.trim() !== '' ? cfg.storePath : null;
  const storePath = path.resolve(explicitPath || configuredPath || path.join(home, backendKind === 'sqlite' ? 'memory_store.db' : 'memory_store.json'));

  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  return new Store({ cfg, backendKind, storePath, DatabaseSync, logger, now });
}
