/**
 * Request handlers for @local/dsh-memory.
 *
 * Pure functions over an injected data layer, so every route can be exercised
 * without a server:
 *
 *   const api = createApi({ cfg, store, md, logger });
 *   await api.overview({});
 *
 * `md` is the lib/md.js module namespace and `store` an opened lib/store.js
 * store. Every handler is defensive: a broken store or an unreadable session
 * corpus degrades to a documented empty payload instead of throwing, because a
 * throw here would turn the whole 记忆 page into an error screen.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { runtimeEnv } from "./config.js";

export const PROVIDER_ID = "holographic";
export const PROVIDER_LABEL = "Holographic memory";

/**
 * The "holographic" half of the store: every fact is projected into an
 * HRR vector (lib/hrr.js) and a text query is scored by cosine similarity
 * against those projections. The store keeps ownership of *filtering* —
 * category, minimum trust, paging — and the vector layer only decides *order*.
 *
 * Ranking rule, deliberate and stable: facts the store matched by keyword always
 * rank above facts found by vectors alone, because a literal match is precise
 * evidence and a vector match is a guess. Within each group the order is by HRR
 * score descending, with the store's own order breaking ties.
 *
 * This is what makes Chinese search work at all: Chinese has no word boundaries,
 * so the store's substring test misses a fact that says 显存 when the query says
 * 显卡内存. The vector projection still finds it.
 */
const HRR_MIN_SCORE = 0.05;
const HRR_MAX_CANDIDATES = 2000;


/* ------------------------------------------------------------------ helpers */

const asInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
};

const asFloat = (value, fallback) => {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : fallback;
};

const asText = (value) => (typeof value === "string" ? value.trim() : "");

function shortId(id) {
  const s = String(id ?? "");
  return s.length > 8 ? s.slice(0, 8) : s;
}

function emptyStats(cfg) {
  return {
    backend: cfg?.backend ?? "json",
    path: cfg?.storePath ?? "",
    facts: 0,
    entities: 0,
    relations: 0,
    categories: [],
    sources: [],
    snapshotAt: null,
    autoExtract: Boolean(cfg?.autoExtract),
    schemaVersion: 1,
  };
}

/* ------------------------------------------------------------------- factory */

export function createApi(deps) {
  const { cfg, logger, sessions } = deps;
  // Read the data layers through the holder on every call: they are loaded
  // asynchronously by the host half, long after this factory has returned.
  const getStore = () => deps.store ?? null;
  const getMd = () => deps.md ?? null;
  const getEmbedder = () => deps.getEmbedder ? deps.getEmbedder() : null;
  const log = logger ?? {};
  const warn = (message) => {
    try {
      log.warn?.(`[dsh-memory] ${message}`);
    } catch {
      /* a logger that throws must not take a route down */
    }
  };

  async function safeStats() {
    const store = getStore();
    if (!store) return emptyStats(cfg);
    try {
      return await store.stats();
    } catch (error) {
      warn(`store.stats failed: ${error?.message ?? error}`);
      return emptyStats(cfg);
    }
  }

  async function safeFiles() {
    const md = getMd();
    if (!md?.readMemoryFile) return [];
    const keys = md.FILES ? Object.keys(md.FILES) : ["agent", "user"];
    const out = [];
    for (const key of keys) {
      try {
        out.push(await md.readMemoryFile(cfg, key));
      } catch (error) {
        warn(`readMemoryFile(${key}) failed: ${error?.message ?? error}`);
        out.push({
          key,
          label: key,
          fileName: key === "user" ? "USER.md" : "MEMORY.md",
          path: path.join(cfg.home, key === "user" ? "USER.md" : "MEMORY.md"),
          exists: false,
          available: false,
          chars: 0,
          budget: key === "user" ? cfg.userBudget : cfg.agentBudget,
          percent: 0,
          mtime: null,
          entries: [],
          overBudget: false,
          error: String(error?.message ?? error),
        });
      }
    }
    return out;
  }

  function providerFrom(stats, files, shown) {
    const available = Boolean(getStore()) && stats.facts >= 0;
    return {
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      path: stats.path || cfg.storePath,
      backend: stats.backend || cfg.backend,
      configured: true,
      available,
      facts: stats.facts,
      shown,
      entities: stats.entities,
      relations: stats.relations,
      stores: available ? 1 : 0,
      banks: holographicModule() ? 1 : 0,
      categories: stats.categories ?? [],
      snapshotAt: stats.snapshotAt ?? null,
      markdownFiles: files.length,
      holographic: describeHolographic(),
    };
  }

  /* ------------------------------------------------------ holographic ranking */

  function holographicModule() {
    const hrr = deps.hrr ?? null;
    return hrr && typeof hrr.createIndex === "function" ? hrr : null;
  }

  function describeHolographic() {
    const hrr = holographicModule();
    if (!hrr) return { enabled: false, dim: 0, magic: "" };
    return { enabled: true, dim: hrr.DEFAULT_DIM, magic: hrr.MAGIC };
  }

  // Only one fact set is indexed at a time; the signature is the cheap thing we
  // can compare without walking every row's content.
  let indexCache = { signature: null, index: null };

  function buildIndex(hrr, facts) {
    const newest = facts.reduce((max, f) => Math.max(max, Number(f.updatedAt) || 0), 0);
    const signature = `${hrr.DEFAULT_DIM}|${facts.length}|${newest}`;
    if (indexCache.signature === signature) return indexCache.index;
    const index = hrr.createIndex({ dim: hrr.DEFAULT_DIM });
    for (const fact of facts) {
      index.add(fact.id, `${fact.content ?? ""} ${(fact.tags ?? []).join(" ")} ${fact.category ?? ""}`);
    }
    indexCache = { signature, index };
    return index;
  }

  /**
   * Re-rank `hits` (what the store matched by keyword) against the wider `pool`
   * (the same filters with the text filter removed). Returns null when there is
   * nothing to do, so the caller keeps the store's ordering.
   */
  function rankWithHolographic(query, hits, pool) {
    const hrr = holographicModule();
    if (!hrr || !query.q || pool.length === 0) return null;
    let scores;
    try {
      const index = buildIndex(hrr, pool);
      scores = new Map(index.search(query.q, Math.min(pool.length, HRR_MAX_CANDIDATES)).map((hit) => [hit.id, hit.score]));
    } catch (error) {
      warn(`holographic ranking failed: ${error?.message ?? error}`);
      return null;
    }
    const matched = new Set(hits.map((f) => f.id));
    const decorate = (fact, match) => ({ ...fact, match, score: Number((scores.get(fact.id) ?? 0).toFixed(4)) });
    const vectorOnly = pool
      .filter((f) => !matched.has(f.id) && (scores.get(f.id) ?? -1) >= HRR_MIN_SCORE)
      .map((f) => decorate(f, "holographic"))
      .sort((a, b) => b.score - a.score);
    return {
      facts: [...hits.map((f) => decorate(f, "keyword")), ...vectorOnly],
      holographic: {
        dim: hrr.DEFAULT_DIM,
        pool: pool.length,
        matched: hits.length,
        vectorOnly: vectorOnly.length,
      },
    };
  }

  /* ------------------------------------------------------------------ routes */

  let lastMarkdownMtime = 0;

  return {
    /** GET /api/dsh-memory/env */
    async env() {
      return { ok: true, ...runtimeEnv(cfg) };
    },

    /** GET /api/dsh-memory/overview */
    async overview(params = {}) {
      // Markdown mtime detection: if MEMORY.md changed externally, re-sync to store.
      // The plugin's own writer (lib/md.js) serialises entries as §-separated blocks,
      // while a hand-edited file often uses "- " bullets — accept both shapes, and only
      // pick up at most 50 entries per change so a huge paste cannot stall the route.
      try {
        if (cfg.home) {
          const memPath = `${cfg.home}/MEMORY.md`;
          const st = await stat(memPath).catch(() => null);
          if (st && st.mtimeMs > lastMarkdownMtime) {
            lastMarkdownMtime = st.mtimeMs;
            const s = getStore();
            if (s && typeof s.upsertFact === "function") {
              const text = await readFile(memPath, "utf8").catch(() => "");
              const chunkLines = text.split(/\r?\n/).filter((l) => l.trim().startsWith("- "));
              const bulletEntries = chunkLines.slice(0, 50).map((line) => line.replace(/^- /, "").trim()).filter(Boolean);
              const sepEntries = text
                .split(/^[ \t]*§[ \t]*$/m)
                .map((c) => c.trim())
                .filter((c) => c.length > 0 && !c.split(/\r?\n/).every((l) => l.trim().startsWith("- ")))
                .slice(0, 50);
              for (const content of [...bulletEntries, ...sepEntries]) {
                await s.upsertFact({ content, category: "user", trust: 0.9, source: "markdown" }).catch(() => {});
              }
            }
          }
        }
      } catch { /* mtime sync optional */ }

      const [stats, files] = await Promise.all([safeStats(), safeFiles()]);
      const store = getStore();
      let shown = 0;
      if (store) {
        try {
          const result = await store.queryFacts({ limit: asInt(params.limit, 200) });
          shown = result?.facts?.length ?? 0;
        } catch (error) {
          warn(`overview queryFacts failed: ${error?.message ?? error}`);
        }
      }
      const entries = files.reduce((sum, f) => sum + (f.entries?.length ?? 0), 0);
      const availableFiles = files.filter((f) => f.exists).length;

      // Embedding status
      const emb = getEmbedder();
      let embedding = { enabled: false, state: "unavailable", model: "", vectorCount: 0, dim: 0 };
      if (emb) {
        embedding.model = emb.MODEL_NAME || "";
        embedding.dim = emb.EMBED_DIM || 0;
        embedding.enabled = true;
        if (emb.isFailed()) embedding.state = "failed";
        else if (emb.isReady()) embedding.state = "ready";
        else embedding.state = "loading";
        try { embedding.vectorCount = emb.getVectorCount ? emb.getVectorCount() : 0; } catch { /* ignore */ }
      }

      return {
        ok: true,
        version: cfg.version,
        snapshotAt: stats.snapshotAt ?? null,
        builtin: { entries, files: files.length, available: availableFiles },
        providers: { enabled: 1, items: [providerFrom(stats, files, shown)] },
        facts: { total: stats.facts, shown },
        budgets: { agent: cfg.agentBudget, user: cfg.userBudget },
        holographic: describeHolographic(),
        embedding,
        home: cfg.home,
      };
    },

    /** GET /api/dsh-memory/builtin */
    async builtin() {
      const files = await safeFiles();
      return { ok: true, files, home: cfg.home };
    },

    /** GET /api/dsh-memory/facts */
    async facts(params = {}) {
      const query = {
        q: asText(params.q),
        category: asText(params.category) || "all",
        minTrust: asFloat(params.minTrust, 0),
        limit: Math.min(Math.max(asInt(params.limit, 200), 1), 2000),
        offset: Math.max(asInt(params.offset, 0), 0),
        sort: asText(params.sort) === "trust" ? "trust" : "recent",
      };
      const store = getStore();
      if (!store) {
        return { ok: true, total: 0, filtered: 0, categories: [], facts: [], note: "memory store unavailable" };
      }
      try {
        const result = await store.queryFacts(query);
        let rows = result?.facts ?? [];
        let holographicInfo = null;
        if (query.q) {
          // The same filters with the text filter dropped: the candidate set the
          // vector layer ranks over. Filtering stays the store's job.
          const pool = await store.queryFacts({ ...query, q: "", offset: 0, limit: HRR_MAX_CANDIDATES });
          const ranked = rankWithHolographic(query, rows, pool?.facts ?? []);
          if (ranked) {
            rows = ranked.facts;
            holographicInfo = ranked.holographic;
          }
        }
        const stats = await safeStats();
        return {
          ok: true,
          total: stats.facts,
          filtered: result?.filtered ?? 0,
          matched: rows.length,
          categories: stats.categories ?? [],
          facts: rows.slice(0, query.limit).map((fact) => ({ ...fact, shortId: shortId(fact.id) })),
          holographic: holographicInfo ?? describeHolographic(),
          query,
        };
      } catch (error) {
        warn(`facts failed: ${error?.message ?? error}`);
        return { ok: true, total: 0, filtered: 0, categories: [], facts: [], note: String(error?.message ?? error) };
      }
    },

    /** GET /api/dsh-memory/providers */
    async providers() {
      const [stats, files] = await Promise.all([safeStats(), safeFiles()]);
      const store = getStore();
      let shown = 0;
      if (store) {
        try {
          shown = (await store.queryFacts({ limit: 200 }))?.facts?.length ?? 0;
        } catch {
          /* provider still reports what it knows */
        }
      }
      return { ok: true, providers: [providerFrom(stats, files, shown)] };
    },

    /** GET /api/dsh-memory/sessions */
    async sessionSearch(params = {}) {
      return sessions.search({
        q: asText(params.q),
        source: asText(params.source) || "all",
        sort: asText(params.sort) === "oldest" ? "oldest" : "recent",
        limit: Math.min(Math.max(asInt(params.limit, 100), 1), 500),
      });
    },

    /** POST /api/dsh-memory/refresh */
    async refresh() {
      let snapshotAt = null;
      const store = getStore();
      if (store) {
        try {
          snapshotAt = await store.touch();
        } catch (error) {
          warn(`touch failed: ${error?.message ?? error}`);
        }
      }
      return { ok: true, snapshotAt: snapshotAt ?? Date.now() };
    },

    /** POST /api/dsh-memory/facts/:id/helpful */
    async markHelpful(id) {
      const store = getStore();
      if (!store) return { ok: false, error: "memory store unavailable" };
      try {
        const fact = await store.bumpFact(String(id), "helpfulCount");
        return fact ? { ok: true, fact } : { ok: false, error: "fact not found" };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },

    /** POST /api/dsh-memory/facts  (record a new fact) */
    async addFact(body = {}) {
      const content = asText(body.content);
      if (!content) return { ok: false, error: "content is required" };
      const store = getStore();
      if (!store) return { ok: false, error: "memory store unavailable" };
      try {
        const fact = await store.upsertFact({
          content,
          category: asText(body.category) || "general",
          tags: Array.isArray(body.tags) ? body.tags.map(asText).filter(Boolean) : [],
          trust: Number.isFinite(Number(body.trust)) ? Number(body.trust) : 0.6,
          source: asText(body.source) || "user",
        });
        return { ok: true, fact };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },

    /** POST /api/dsh-memory/builtin  (append or replace markdown entries) */
    async writeBuiltin(body = {}) {
      const key = asText(body.key);
      const md = getMd();
      if (!md?.writeMemoryEntries) return { ok: false, error: "markdown layer unavailable" };
      if (!md.FILES?.[key]) return { ok: false, error: "key must be 'agent' or 'user'" };
      try {
        if (Array.isArray(body.entries)) {
          const file = await md.writeMemoryEntries(cfg, key, body.entries.map(String));
          return { ok: true, file };
        }
        const text = asText(body.text);
        if (!text) return { ok: false, error: "text or entries is required" };
        const file = await md.addMemoryEntry(cfg, key, text);
        return { ok: true, file };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },

    /** GET /api/dsh-memory/export — 导出全部记忆为 JSON */
    async export() {
      const store = getStore();
      if (!store) return { ok: false, error: "store unavailable" };
      try {
        const out = { version: 1, exportedAt: Date.now(), tables: {} };
        // SQLite backend has all(); JSON backend has snapshot()
        if (typeof store.all === "function") {
          const tables = ["facts", "entities", "fact_entities", "relations", "events", "edges", "feedbacks", "meta"];
          for (const t of tables) {
            try {
              const rows = store.all(`SELECT * FROM ${t}`);
              // strip embedding blob — too big for JSON, recompute on import
              if (t === "facts") out.tables[t] = rows.map(({ embedding, embedModel, ...rest }) => rest);
              else out.tables[t] = rows;
            } catch { out.tables[t] = []; }
          }
        } else {
          const snap = await store.snapshot();
          out.tables.facts = (snap.facts || []).map(({ embedding, embedModel, ...rest }) => rest);
          out.tables.entities = snap.entities || [];
          out.tables.fact_entities = snap.factEntities || [];
          out.tables.relations = snap.relations || [];
        }
        out.counts = {
          facts: out.tables.facts?.length ?? 0,
          events: out.tables.events?.length ?? 0,
          edges: out.tables.edges?.length ?? 0,
          feedbacks: out.tables.feedbacks?.length ?? 0,
        };
        return { ok: true, ...out };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },

    /** POST /api/dsh-memory/import — 从 JSON 导入（upsert，不删现有） */
    async import(body = {}) {
      const store = getStore();
      if (!store) return { ok: false, error: "store unavailable" };
      const tables = body?.tables;
      if (!tables || !Array.isArray(tables.facts)) return { ok: false, error: "invalid export format" };
      let imported = 0;
      try {
        for (const f of tables.facts) {
          if (!f.content) continue;
          await store.upsertFact({
            content: f.content,
            category: f.category || "general",
            tags: typeof f.tags === "string" ? JSON.parse(f.tags) : (f.tags || []),
            trust: Number(f.trust) || 0.6,
            source: f.source || "import",
          });
          imported++;
        }
        return { ok: true, imported };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error), imported };
      }
    },
  };
}

/* ------------------------------------------------------------ session corpus */

/**
 * DSH keeps one zstd-compressed JSONL transcript per session at
 *   <dsh home>/sessions/<workspace-slug>/<session id>/session.v4.jsonl.zstd
 * whose first line is `{"type":"session","version":4,"id":...,"createdAt":...}`.
 * Node >= 23.8 exposes zstd through node:zlib; on a runtime without it we report
 * the corpus as unavailable rather than pretending there are no sessions.
 */
export function createSessionSearch({ cfg, logger } = {}) {
  const warn = (message) => {
    try {
      logger?.warn?.(`[dsh-memory] ${message}`);
    } catch {
      /* ignore */
    }
  };
  const sessionsRoot = path.join(path.dirname(cfg.home), "sessions");
  const hasZstd = typeof zlib.zstdDecompressSync === "function";
  const cache = new Map();

  async function collectTranscripts() {
    const found = [];
    let slugs;
    try {
      slugs = await readdir(sessionsRoot, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const slugDir = path.join(sessionsRoot, slug.name);
      let dirs;
      try {
        dirs = await readdir(slugDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const file = path.join(slugDir, dir.name, "session.v4.jsonl.zstd");
        if (!existsSync(file)) continue;
        found.push({ id: dir.name, file, slug: slug.name });
      }
    }
    return found;
  }

  async function loadTranscript(entry) {
    try {
      const info = await stat(entry.file);
      const cached = cache.get(entry.file);
      if (cached && cached.mtimeMs === info.mtimeMs) return cached;
      const compressed = await readFile(entry.file);
      // DSH appends a NEW independent zstd frame on every flush, so the on-disk file is a
      // concatenation of frames, not one stream. A single zstdDecompressSync() call stops at
      // the first frame (just the header line) and silently drops every later event — which
      // made session search return empty results for every real session. Scan frame magic
      // (0x28 B5 2F FD) and decode each frame independently, tolerating a torn final frame.
      const text = decompressZstdContainer(compressed);
      const record = parseTranscript(entry, text);
      cache.set(entry.file, { ...record, mtimeMs: info.mtimeMs });
      return record;
    } catch (error) {
      warn(`transcript ${entry.id} unreadable: ${error?.message ?? error}`);
      return null;
    }
  }

  return {
    available: hasZstd,
    root: sessionsRoot,
    async search({ q = "", source = "all", sort = "recent", limit = 100 } = {}) {
      if (!hasZstd) {
        return {
          ok: true,
          sources: [],
          sessions: [],
          note: "this runtime has no zstd decoder (node:zlib.zstdDecompressSync), session search is unavailable",
        };
      }
      const entries = await collectTranscripts();
      // A session may show up more than once (e.g. a sibling *.bak-* backup dir that also
      // carries a session.v4.jsonl.zstd). Collapse by session id, keeping the newest mtime.
      const byId = new Map();
      for (const e of entries) {
        const existing = byId.get(e.id);
        if (!existing) { byId.set(e.id, e); continue; }
        try {
          if (stat(e.file).mtimeMs > stat(existing.file).mtimeMs) byId.set(e.id, e);
        } catch { /* keep existing */ }
      }
      const records = (await Promise.all([...byId.values()].map(loadTranscript))).filter(Boolean);
      const needle = q.toLowerCase();
      const hits = [];
      for (const record of records) {
        if (source !== "all" && record.source !== source) continue;
        const matches = needle ? record.lines.filter((line) => line.toLowerCase().includes(needle)) : [];
        if (needle && matches.length === 0) continue;
        hits.push({
          id: record.id,
          title: record.title,
          source: record.source,
          cwd: record.cwd,
          parentSession: record.parentSession,
          events: record.events,
          updatedAt: record.updatedAt,
          snippet: (matches[0] ?? record.lines.find((line) => line.trim().length > 40) ?? record.title ?? "").slice(0, 400),
          matches: matches.length,
        });
      }
      hits.sort((a, b) => (sort === "oldest" ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt));
      const sources = [...new Set(records.map((r) => r.source))].sort();
      return { ok: true, sources, sessions: hits.slice(0, limit), scanned: records.length, root: sessionsRoot };
    },
  };
}

function parseTranscript(entry, text) {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  let header = {};
  try {
    header = JSON.parse(lines[0] ?? "{}");
  } catch {
    header = {};
  }
  const createdAt = Number.isFinite(header.createdAt) ? header.createdAt : 0;
  let updatedAt = createdAt;
  const texts = [];
  let title = "";

  for (let i = 1; i < lines.length; i += 1) {
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const at = Number(event?.at ?? event?.timestamp ?? event?.time ?? 0);
    if (Number.isFinite(at) && at > updatedAt) updatedAt = at;
    for (const value of extractStrings(event)) {
      texts.push(value);
      if (!title && value.trim().length >= 4 && value.trim().length <= 120) title = value.trim();
    }
  }

  const origin = String(header.origin ?? "desktop");
  return {
    id: String(header.id ?? entry.id),
    createdAt,
    updatedAt: updatedAt || createdAt || Date.now(),
    cwd: header.cwd ?? "",
    parentSession: header.parentSession ?? null,
    source: origin === "subagent" ? "subagent" : origin,
    events: Math.max(lines.length - 1, 0),
    title: title || entry.id,
    lines: texts,
  };
}

/** Recursively pull human-readable strings out of an event, skipping plumbing. */
const SKIP_KEYS = new Set(["id", "type", "role", "kind", "name", "version", "integrity", "hash", "sha", "seq"]);

/** zstd frame magic, little-endian uint32: bytes 28 B5 2F FD. */
const ZSTD_FRAME_MAGIC = 0xfd2fb528;

/**
 * Decode a DSH session file, which is a concatenation of independent zstd frames
 * (one per flush). Falls back to a single-shot decode for inputs that are just
 * one frame. A torn final frame (process killed mid-flush) contributes whatever
 * prefix was decoded successfully instead of throwing away the whole file.
 */
function decompressZstdContainer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return "";
  const starts = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(i) === ZSTD_FRAME_MAGIC) starts.push(i);
  }
  if (starts.length === 0) {
    // Not a zstd container at all — let the caller's catch handle it.
    return zlib.zstdDecompressSync(buffer).toString("utf8");
  }
  const parts = [];
  for (let k = 0; k < starts.length; k += 1) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buffer.length;
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(s, e)));
    } catch {
      // Torn/partial final frame: skip it rather than lose every earlier frame.
    }
  }
  return Buffer.concat(parts).toString("utf8");
}

function extractStrings(value, out = [], depth = 0) {
  if (out.length > 4000 || depth > 6 || value === null || value === undefined) return out;
  if (typeof value === "string") {
    if (value.length >= 2) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractStrings(item, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (SKIP_KEYS.has(key)) continue;
      extractStrings(item, out, depth + 1);
    }
  }
  return out;
}

export { shortId, extractStrings };
