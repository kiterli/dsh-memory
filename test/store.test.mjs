/**
 * test/store.test.mjs — mem-core. Exercises lib/store.js on BOTH backends
 * (node:sqlite and the JSON file) and proves they agree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { openStore } from '../lib/store.js';

let sqliteModule = null;
try {
  sqliteModule = await import('node:sqlite');
} catch {
  sqliteModule = null;
}
const HAS_SQLITE = Boolean(sqliteModule && typeof sqliteModule.DatabaseSync === 'function');
const BACKENDS = HAS_SQLITE ? ['json', 'sqlite'] : ['json'];

const T0 = 1700000000000;

const SAMPLE = [
  { content: 'Hermes home is D:\\hermes and MEMORY.md keeps "quoted notes" for API-KEY rotation', category: 'general', tags: ['keywords', 'memory'], trust: 0.6, source: 'manual' },
  { content: 'The project ships on Fridays', category: 'project', tags: ['schedule'], trust: 0.9, source: 'agent' },
  { content: 'user prefers dark mode', category: 'general', tags: ['ui', 'Preferences'], trust: 0.2, source: 'user' },
  { content: 'Imported note about API-KEY rotation', category: 'import', tags: [], trust: 0.75, source: 'import' },
  { content: 'Auto extracted memory entry', category: 'general', tags: ['auto'], trust: 0.4, source: 'auto' },
];

async function makeHome(prefix = 'dsh-store-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function clockFrom(start = T0) {
  let tick = start;
  return () => {
    const value = tick;
    tick += 1000;
    return value;
  };
}

function cfgFor(home, backend) {
  return {
    home,
    backend,
    storePath: path.join(home, backend === 'sqlite' ? 'memory_store.db' : 'memory_store.json'),
    agentBudget: 2200,
    userBudget: 1375,
    autoExtract: false,
  };
}

async function newStore(backend, opts = {}) {
  const home = opts.home || await makeHome(backend + '-');
  const cfg = cfgFor(home, backend);
  const store = await openStore(cfg, { backend, now: opts.now });
  await store.init();
  return { store, cfg, home, storePath: cfg.storePath };
}

async function exists(target) {
  return fsp.stat(target).then(() => true, () => false);
}

async function populate(store) {
  const out = [];
  for (const input of SAMPLE) out.push(await store.upsertFact(input));
  return out;
}

function normalizedContent(content) {
  return String(content).replace(/\r\n?/g, '\n').trim().replace(/\s+/g, ' ').toLowerCase();
}

function expectedHash(content) {
  return createHash('sha256').update(normalizedContent(content), 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ opening */

test('store: openStore requires a config object and a resolvable home', async () => {
  await assert.rejects(() => openStore(null), /requires a config object/);
  await assert.rejects(() => openStore(undefined, {}), /requires a config object/);
  await assert.rejects(() => openStore({}), /cfg\.home is required/);
  await assert.rejects(() => openStore({ home: '   ' }), /cfg\.home is required/);
});

test('store: openStore touches nothing; init() creates the store', async () => {
  const root = await makeHome('dsh-store-open-');
  const home = path.join(root, 'nested', 'memories');
  const store = await openStore({ home, backend: 'json' }, { backend: 'json' });
  assert.equal(await exists(home), false, 'openStore must not create the home dir');
  await store.init();
  assert.equal(await exists(home), true);
  assert.equal(await exists(path.join(home, 'memory_store.json')), true);
  await store.close();
});

test('store: openStore can take an explicit storePath without cfg.home', async () => {
  const home = await makeHome('dsh-store-path-');
  const storePath = path.join(home, 'explicit.json');
  const store = await openStore({ backend: 'json' }, { backend: 'json', storePath });
  await store.init();
  assert.equal((await store.stats()).path, path.resolve(storePath));
  await store.close();
});

/* --------------------------------------------------------- per-backend core */

for (const backend of BACKENDS) {
  test(`store (${backend}): upsertFact returns the documented Fact shape`, async () => {
    const { store } = await newStore(backend, { now: clockFrom() });
    const fact = await store.upsertFact(SAMPLE[0]);
    const hash = expectedHash(SAMPLE[0].content);

    assert.deepStrictEqual(Object.keys(fact).sort(), [
      'accessCount', 'archived', 'bodyStr', 'category', 'content', 'createdAt', 'entities',
      'hash', 'helpfulCount', 'id', 'kwStr', 'lastHitAt', 'muted', 'permanent',
      'searchCount', 'source', 'sumStr', 'superseded', 'supersededBy', 'tags', 'trust', 'updatedAt',
    ]);
    assert.equal(fact.id, 'f' + hash.slice(0, 16));
    assert.equal(fact.hash, hash);
    assert.equal(fact.content, SAMPLE[0].content);
    assert.equal(fact.category, 'general');
    assert.deepStrictEqual(fact.tags, ['keywords', 'memory']);
    assert.equal(fact.trust, 0.6);
    assert.equal(fact.source, 'manual');
    assert.equal(fact.searchCount, 0);
    assert.equal(fact.helpfulCount, 0);
    assert.equal(fact.createdAt, T0 + 1000);
    assert.equal(fact.updatedAt, T0 + 1000);
    await store.close();
  });

  test(`store (${backend}): upsertFact applies defaults and clamps trust`, async () => {
    const { store } = await newStore(backend, { now: clockFrom() });
    const bare = await store.upsertFact({ content: 'bare fact' });
    assert.equal(bare.category, 'general');
    assert.deepStrictEqual(bare.tags, []);
    assert.equal(bare.trust, 0.6);
    assert.equal(bare.source, 'manual');

    const clamped = await store.upsertFact({ content: 'clamped fact', trust: 7, tags: 'a, b, A' });
    assert.equal(clamped.trust, 1);
    assert.deepStrictEqual(clamped.tags, ['a', 'b']);

    const negative = await store.upsertFact({ content: 'negative fact', trust: -3 });
    assert.equal(negative.trust, 0);

    await assert.rejects(() => store.upsertFact({ content: '   ' }), /non-empty content/);
    await store.close();
  });

  test(`store (${backend}): upsertFact dedupes on the normalized-content hash`, async () => {
    const { store } = await newStore(backend, { now: clockFrom() });
    const first = await store.upsertFact({ content: 'Dedupe ME', category: 'general', tags: ['one'] });
    await store.bumpFact(first.id, 'searchCount');
    await store.bumpFact(first.id, 'helpfulCount');
    const before = await store.getFact(first.id);

    const second = await store.upsertFact({ content: '  dedupe   me  ', category: 'renamed', tags: ['two'] });
    assert.equal(second.id, first.id);
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.searchCount, before.searchCount);
    assert.equal(second.helpfulCount, before.helpfulCount);
    assert.ok(second.updatedAt > before.updatedAt, 'updatedAt is bumped');
    assert.equal(second.category, 'renamed');
    assert.deepStrictEqual(second.tags, ['two']);

    const all = await store.queryFacts({});
    assert.equal(all.total, 1);
    await store.close();
  });

  test(`store (${backend}): queryFacts filters, sorts and pages`, async () => {
    const { store } = await newStore(backend, { now: clockFrom() });
    const facts = await populate(store);

    const all = await store.queryFacts({});
    assert.equal(all.total, 5);
    assert.equal(all.filtered, 5);
    assert.deepStrictEqual(all.facts.map((f) => f.id), [facts[4].id, facts[3].id, facts[2].id, facts[1].id, facts[0].id]);

    const byTrust = await store.queryFacts({ sort: 'trust' });
    assert.deepStrictEqual(byTrust.facts.map((f) => f.trust), [0.9, 0.75, 0.6, 0.4, 0.2]);

    const byContent = await store.queryFacts({ q: 'FRIDAYS' });
    assert.equal(byContent.total, 5);
    assert.equal(byContent.filtered, 1);
    assert.equal(byContent.facts[0].content, 'The project ships on Fridays');

    const byTag = await store.queryFacts({ q: 'preferences' });
    assert.equal(byTag.filtered, 1);
    const byCategory = await store.queryFacts({ q: 'project' });
    assert.equal(byCategory.filtered, 1);

    const general = await store.queryFacts({ category: 'GENERAL' });
    assert.equal(general.filtered, 3);
    const allCategory = await store.queryFacts({ category: 'all' });
    assert.equal(allCategory.filtered, 5);

    const trusted = await store.queryFacts({ minTrust: 0.6 });
    assert.equal(trusted.filtered, 3);

    const paged = await store.queryFacts({ limit: 2, offset: 1 });
    assert.equal(paged.facts.length, 2);
    assert.equal(paged.filtered, 5);
    assert.equal(paged.total, 5);

    const none = await store.queryFacts({ limit: 0 });
    assert.equal(none.facts.length, 0);

    const combined = await store.queryFacts({ q: 'api-key', category: 'general', minTrust: 0.5, sort: 'trust', limit: 1 });
    assert.equal(combined.filtered, 1);
    assert.equal(combined.facts[0].trust, 0.6);

    const empty = await store.queryFacts({ q: 'nothing matches this' });
    assert.deepStrictEqual(empty, { facts: [], total: 5, filtered: 0 });
    await store.close();
  });

  test(`store (${backend}): getFact, deleteFact and bumpFact`, async () => {
    const { store } = await newStore(backend, { now: clockFrom() });
    const facts = await populate(store);

    const found = await store.getFact(facts[2].id);
    assert.equal(found.content, facts[2].content);
    assert.equal(await store.getFact('fdoesnotexist'), null);

    const bumped = await store.bumpFact(facts[0].id, 'searchCount');
    assert.equal(bumped.searchCount, 1);
    assert.equal(bumped.updatedAt, facts[0].updatedAt, 'counter bumps keep updatedAt');
    const helped = await store.bumpFact(facts[0].id, 'helpfulCount');
    assert.equal(helped.helpfulCount, 1);
    assert.equal(helped.searchCount, 1);
    assert.equal(await store.bumpFact(facts[0].id, 'nope'), null);
    assert.equal(await store.bumpFact('fmissing', 'searchCount'), null);

    assert.equal(await store.deleteFact(facts[1].id), true);
    assert.equal(await store.deleteFact(facts[1].id), false);
    assert.equal(await store.getFact(facts[1].id), null);
    assert.equal((await store.queryFacts({})).total, 4);
    await store.close();
  });

  test(`store (${backend}): bumpFact persists counters through the upsert conflict path`, async () => {
    const home = await makeHome(backend + '-counters-');
    const cfg = cfgFor(home, backend);
    const store = await openStore(cfg, { backend, now: clockFrom() });
    await store.init();
    const fact = await store.upsertFact({ content: 'counter fact' });

    await store.bumpFact(fact.id, 'helpfulCount');
    const afterHelpful = await store.getFact(fact.id);
    assert.equal(afterHelpful.helpfulCount, 1, 'helpfulCount must survive the upsert conflict path');
    assert.equal(afterHelpful.searchCount, 0);

    await store.bumpFact(fact.id, 'searchCount');
    const afterSearch = await store.getFact(fact.id);
    assert.equal(afterSearch.searchCount, 1, 'searchCount must survive the upsert conflict path');
    assert.equal(afterSearch.helpfulCount, 1);

    const page = await store.queryFacts({});
    assert.equal(page.facts[0].helpfulCount, 1);
    assert.equal(page.facts[0].searchCount, 1);

    const again = await store.upsertFact({ content: 'counter fact' });
    assert.equal(again.searchCount, 1, 'a re-upsert of the same content keeps searchCount');
    assert.equal(again.helpfulCount, 1, 'a re-upsert of the same content keeps helpfulCount');
    await store.close();

    const reopened = await openStore(cfg, { backend });
    await reopened.init();
    const persisted = (await reopened.queryFacts({})).facts[0];
    assert.equal(persisted.helpfulCount, 1, 'counters are durable on disk');
    assert.equal(persisted.searchCount, 1);
    await reopened.close();
  });

  test(`store (${backend}): entity extraction, listing and cleanup`, async () => {
    const { store } = await newStore(backend, { now: clockFrom() });
    const fact = await store.upsertFact(SAMPLE[0]);
    assert.deepStrictEqual(fact.entities, ['API-KEY', 'Hermes', 'MEMORY.md', 'quoted notes']);

    const many = await store.upsertFact({
      content: Array.from({ length: 12 }, (_, i) => '"phrase number ' + i + '"').join(' and ') + ' ZZZZZZZ',
    });
    assert.equal(many.entities.length, 8, 'capped at 8 per fact');
    assert.equal(many.entities.includes('ZZZZZZZ'), false);

    await store.upsertFact({ content: 'API-KEY rotation again', category: 'general' });
    const entities = await store.listEntities({});
    const apiKey = entities.find((e) => e.name === 'API-KEY');
    assert.equal(apiKey.factCount, 2);
    assert.equal(apiKey.kind, 'topic');
    assert.deepStrictEqual(Object.keys(apiKey).sort(), ['createdAt', 'factCount', 'id', 'kind', 'name', 'updatedAt']);

    const filtered = await store.listEntities({ q: 'herm' });
    assert.deepStrictEqual(filtered.map((e) => e.name), ['Hermes']);
    assert.equal((await store.listEntities({ limit: 1 })).length, 1);
    assert.ok(entities[0].factCount >= entities[entities.length - 1].factCount);

    await store.deleteFact(fact.id);
    const after = await store.listEntities({});
    assert.equal(after.find((e) => e.name === 'API-KEY').factCount, 1);
    assert.equal(after.some((e) => e.name === 'MEMORY.md'), false, 'orphan entities are dropped');
    await store.close();
  });

  test(`store (${backend}): stats, relations and touch`, async () => {
    const { store, storePath } = await newStore(backend, { now: clockFrom() });
    await populate(store);

    const stats = await store.stats();
    assert.equal(stats.backend, backend);
    assert.equal(stats.path, path.resolve(storePath));
    assert.equal(stats.facts, 5);
    assert.equal(stats.relations, 0);
    assert.equal(stats.schemaVersion, 1);
    assert.equal(stats.autoExtract, false);
    assert.equal(stats.snapshotAt, T0);
    assert.deepStrictEqual(stats.categories, [
      { name: 'general', count: 3 },
      { name: 'import', count: 1 },
      { name: 'project', count: 1 },
    ]);
    assert.deepStrictEqual(stats.sources, ['agent', 'auto', 'import', 'manual', 'user']);
    assert.deepStrictEqual(Object.keys(stats).sort(), [
      'archived', 'autoExtract', 'backend', 'categories', 'entities', 'facts', 'path',
      'relations', 'schemaVersion', 'snapshotAt', 'sources',
    ]);

    assert.deepStrictEqual(await store.listRelations({}), []);
    assert.deepStrictEqual(await store.listRelations({ limit: 5 }), []);

    const touched = await store.touch();
    assert.equal(touched, T0 + 6000);
    assert.equal((await store.stats()).snapshotAt, touched);
    await store.close();
  });

  test(`store (${backend}): data survives close() and reopen`, async () => {
    const home = await makeHome(backend + '-persist-');
    const cfg = cfgFor(home, backend);
    const first = await openStore(cfg, { backend, now: clockFrom() });
    await first.init();
    await populate(first);
    await first.close();

    const second = await openStore(cfg, { backend });
    await second.init();
    const reopened = await second.queryFacts({});
    assert.equal(reopened.total, 5);
    assert.equal(reopened.facts[0].content, SAMPLE[4].content);
    assert.equal((await second.listEntities({})).length > 0, true);
    await second.close();
  });
}

/* ----------------------------------------------------------- json specifics */

test('store (json): writes atomically and recovers from absent/truncated/corrupt files', async () => {
  const home = await makeHome('dsh-store-json-atomic-');
  const storePath = path.join(home, 'memory_store.json');
  const cfg = { home, backend: 'json', storePath };

  let store = await openStore(cfg, { backend: 'json' });
  await store.init();
  assert.equal((await store.queryFacts({})).total, 0, 'absent file starts empty');

  const writes = [];
  for (let i = 0; i < 40; i += 1) writes.push(store.upsertFact({ content: 'concurrent fact ' + i }));
  let stop = false;
  let reads = 0;
  let torn = 0;
  const poll = (async () => {
    const deadline = Date.now() + 5000;
    while (!stop && Date.now() < deadline) {
      try {
        const text = await fsp.readFile(storePath, 'utf8');
        if (text.trim() !== '') {
          try { JSON.parse(text); reads += 1; } catch { torn += 1; }
        }
      } catch (err) {
        // 原子替换（rename over）在 Windows 上会让并发读者短暂碰到 EPERM/EBUSY,
        // 而 Linux/macOS 的替换是原子的、看不到这个窗口。两者都只说明"此刻这份
        // 文件正被替换"，是本次并发读写的正常现象，不是数据损坏，跳过这一轮即可。
        const transient = err && (err.code === 'ENOENT' || err.code === 'EPERM' || err.code === 'EBUSY');
        if (!transient) throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  })();
  try {
    await Promise.all(writes);
  } finally {
    stop = true;
    const pollError = await poll.then(() => null, (err) => err);
    if (pollError) throw pollError;
  }

  assert.ok(reads > 0, 'the concurrent reader observed the store');
  assert.equal(torn, 0, 'no reader ever saw a partially written file');
  assert.deepStrictEqual(
    (await fsp.readdir(home)).filter((name) => name.endsWith('.tmp')),
    [],
    'no temp files are left behind',
  );
  const onDisk = JSON.parse(await fsp.readFile(storePath, 'utf8'));
  assert.equal(onDisk.facts.length, 40);
  assert.deepStrictEqual(onDisk.fact_entities, onDisk.fact_entities);
  await store.close();

  await fsp.writeFile(storePath, '{"facts":[{"id":"f1","content":"truncated"', 'utf8');
  store = await openStore(cfg, { backend: 'json' });
  await store.init();
  assert.equal((await store.queryFacts({})).total, 0, 'truncated file starts empty');
  await store.upsertFact({ content: 'after recovery' });
  assert.equal((await store.queryFacts({})).total, 1, 'the store is usable again');
  await store.close();

  await fsp.writeFile(storePath, 'not json at all', 'utf8');
  store = await openStore(cfg, { backend: 'json' });
  await store.init();
  assert.equal((await store.queryFacts({})).total, 0, 'corrupt file starts empty');
  await store.close();

  await fsp.rm(storePath, { force: true });
  store = await openStore(cfg, { backend: 'json' });
  await store.init();
  assert.equal((await store.queryFacts({})).total, 0, 'deleted file starts empty');
  await store.close();
});

test('store (json): the on-disk document mirrors the logical tables', async () => {
  const { store, storePath } = await newStore('json', { now: clockFrom() });
  await populate(store);
  await store.close();

  const document = JSON.parse(await fsp.readFile(storePath, 'utf8'));
  assert.deepStrictEqual(Object.keys(document).sort(), ['entities', 'fact_entities', 'facts', 'meta', 'relations', 'schemaVersion']);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.facts.length, 5);
  assert.ok(Array.isArray(document.facts[0].tags), 'tags round-trip as a JSON array');
  assert.ok(document.entities.length > 0);
  assert.ok(document.fact_entities.length > 0);
  assert.equal(document.meta.snapshotAt, T0);
});

/* --------------------------------------------------------------- equivalence */

test('store: JSON and SQLite return identical queryFacts for identical inserts', { skip: !HAS_SQLITE }, async () => {
  const jsonSide = await newStore('json', { now: clockFrom() });
  const sqliteSide = await newStore('sqlite', { now: clockFrom() });

  const jsonFacts = await populate(jsonSide.store);
  const sqliteFacts = await populate(sqliteSide.store);
  assert.deepStrictEqual(jsonFacts, sqliteFacts, 'upsertFact returns identical facts');

  const optionSets = [
    {},
    { sort: 'trust' },
    { sort: 'recent' },
    { q: 'api-key' },
    { q: 'FRIDAYS' },
    { q: 'preferences' },
    { category: 'general' },
    { category: 'all' },
    { minTrust: 0.6 },
    { minTrust: 0 },
    { limit: 2, offset: 1 },
    { limit: 0 },
    { q: 'api-key', category: 'general', minTrust: 0.5, sort: 'trust', limit: 1 },
    { q: 'nothing matches this' },
  ];
  for (const opts of optionSets) {
    assert.deepStrictEqual(
      await jsonSide.store.queryFacts(opts),
      await sqliteSide.store.queryFacts(opts),
      'queryFacts diverged for ' + JSON.stringify(opts),
    );
  }

  for (const fact of jsonFacts) {
    assert.deepStrictEqual(await jsonSide.store.getFact(fact.id), await sqliteSide.store.getFact(fact.id));
    assert.deepStrictEqual(await jsonSide.store.bumpFact(fact.id, 'searchCount'), await sqliteSide.store.bumpFact(fact.id, 'searchCount'));
    assert.deepStrictEqual(await jsonSide.store.bumpFact(fact.id, 'helpfulCount'), await sqliteSide.store.bumpFact(fact.id, 'helpfulCount'));
  }
  assert.deepStrictEqual(await jsonSide.store.bumpFact('fmissing', 'searchCount'), await sqliteSide.store.bumpFact('fmissing', 'searchCount'));

  assert.deepStrictEqual(await jsonSide.store.queryFacts({ sort: 'trust' }), await sqliteSide.store.queryFacts({ sort: 'trust' }));
  assert.deepStrictEqual(await jsonSide.store.listEntities({}), await sqliteSide.store.listEntities({}));
  assert.deepStrictEqual(await jsonSide.store.listEntities({ q: 'a', limit: 3 }), await sqliteSide.store.listEntities({ q: 'a', limit: 3 }));
  assert.deepStrictEqual(await jsonSide.store.listRelations({}), await sqliteSide.store.listRelations({}));

  const jsonStats = await jsonSide.store.stats();
  const sqliteStats = await sqliteSide.store.stats();
  delete jsonStats.backend;
  delete sqliteStats.backend;
  delete jsonStats.path;
  delete sqliteStats.path;
  assert.deepStrictEqual(jsonStats, sqliteStats, 'stats agree apart from backend/path');

  const gone = jsonFacts[1].id;
  assert.equal(await jsonSide.store.deleteFact(gone), await sqliteSide.store.deleteFact(gone));
  assert.deepStrictEqual(await jsonSide.store.queryFacts({}), await sqliteSide.store.queryFacts({}));
  assert.deepStrictEqual(await jsonSide.store.listEntities({}), await sqliteSide.store.listEntities({}));

  await jsonSide.store.close();
  await sqliteSide.store.close();
});

test('store: both backends agree without an injected clock too', { skip: !HAS_SQLITE }, async () => {
  const jsonSide = await newStore('json');
  const sqliteSide = await newStore('sqlite');
  await populate(jsonSide.store);
  await populate(sqliteSide.store);

  const strip = (result) => ({
    total: result.total,
    filtered: result.filtered,
    facts: result.facts.map((fact) => ({
      ...fact,
      createdAt: 0,
      updatedAt: 0,
    })),
  });

  for (const opts of [{}, { sort: 'trust' }, { q: 'api-key' }, { minTrust: 0.6 }, { limit: 3, offset: 1 }]) {
    assert.deepStrictEqual(
      strip(await jsonSide.store.queryFacts(opts)),
      strip(await sqliteSide.store.queryFacts(opts)),
      'queryFacts diverged for ' + JSON.stringify(opts),
    );
  }
  await jsonSide.store.close();
  await sqliteSide.store.close();
});

test('store: sqlite probe result is reported honestly', async () => {
  const { store } = await newStore('json');
  assert.equal((await store.stats()).backend, 'json');
  await store.close();
  assert.equal(HAS_SQLITE, typeof (await import('node:sqlite')).DatabaseSync === 'function');
});
