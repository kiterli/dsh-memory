# `@local/dsh-memory` — build contract (v1)

Coordination artifact. Every file below has exactly one owner. Do not edit a file you
do not own; if the contract is wrong, message the Lead instead.

## Ownership

| Path | Owner |
|---|---|
| `package.json`, `cordis.patch.yml`, `index.js`, `lib/config.js`, `lib/api.js`, `CONTRACT.md` | Lead |
| `lib/md.js`, `lib/store.js`, `test/md.test.mjs`, `test/store.test.mjs` | mem-core |
| `client.js`, `dev/preview.html`, `dev/tokens.css`, `icon.svg`, `locale/zh.json`, `locale/en.json`, `test/client.contract.test.mjs` | mem-ui |
| `README.md` | Lead (final) |

Runtime: plain ESM, **zero npm dependencies**. Node 24 locally; the DSH host is Electron
(treat `node:sqlite` as optional). Python, if needed, is `py -3` — never `python`.

## Memory home

Resolved by `lib/config.js`:

```
home = config.home || process.env.DSH_MEMORY_HOME || <DSH_HOME|~/.dsh>/memories
```

Files inside it: `MEMORY.md`, `USER.md`, `.lock`, and the fact store
(`memory_store.db` when `node:sqlite` is available, otherwise `memory_store.json`).

## `lib/config.js` (Lead) — ESM named exports

```js
export function resolveMemoryConfig(input = {}) -> {
  home,            // absolute path, string
  agentBudget,     // number, default 2200
  userBudget,      // number, default 1375
  autoExtract,     // boolean, default false
  storePath,       // absolute path string (db OR json; decided lazily by store.js)
  backend,         // 'sqlite' | 'json'  (probed with a dynamic import of node:sqlite)
  version,         // plugin version string, read from package.json
}
```

## `lib/md.js` (mem-core) — ESM named exports

Entry delimiter is a line containing only `§`. All functions are async, never throw on a
missing file, and are safe to call concurrently (advisory `.lock` file, best-effort).

```js
export const ENTRY_SEP = '§';
export const FILES = {
  agent: { key: 'agent', fileName: 'MEMORY.md', label: 'Agent memory',  budgetKey: 'agentBudget' },
  user:  { key: 'user',  fileName: 'USER.md',   label: 'User profile',  budgetKey: 'userBudget'  },
};

// -> MemoryFile, see shape below. `available` is false when the file does not exist.
export async function readMemoryFile(cfg, key) -> MemoryFile
export async function writeMemoryEntries(cfg, key, entries) -> MemoryFile
export async function addMemoryEntry(cfg, key, text) -> MemoryFile
export async function removeMemoryEntry(cfg, key, index) -> MemoryFile
export async function overview(cfg) -> { entries, files, available }   // numbers across both files
```

`MemoryFile` (exact shape; the client and the API both depend on it):

```js
{
  key: 'agent',                  // 'agent' | 'user'
  label: 'Agent memory',         // FILES[key].label
  fileName: 'MEMORY.md',
  path: 'C:\\Users\\...\\memories\\MEMORY.md',
  exists: true,
  available: true,               // === exists
  chars: 1024,                   // characters of the *entries* joined by ENTRY_SEP
  budget: 2200,
  percent: 46.5,                 // 0..100, one decimal
  mtime: 1792914497532,          // ms epoch, or null
  entries: [ { index: 0, text: '...' } ],
  overBudget: false,
}
```

Parsing rules: split on a line that is exactly `§` (allow surrounding whitespace); trim
each entry; drop empty entries; a file that does not exist yields `entries: []`,
`chars: 0`, `exists: false`. Writing joins entries with `ENTRY_SEP` on its own line and
ends the file with a trailing newline. Do not reorder or rewrite entries you were not
asked to change.

## `lib/store.js` (mem-core) — ESM named exports

```js
export async function openStore(cfg, options = {}) -> Store
// options: { logger }  logger is optional, { info, warn, error } all optional.
```

`Store` (all methods async):

```js
await store.init()                      // create tables/files, idempotent
await store.stats()                     // -> StoreStats
await store.queryFacts(opts)            // -> { facts: Fact[], total, filtered }
await store.getFact(id)                 // -> Fact | null
await store.upsertFact(input)           // -> Fact   (dedupe on hash of normalized content)
await store.deleteFact(id)              // -> boolean
await store.bumpFact(id, field)         // field: 'searchCount' | 'helpfulCount' -> Fact | null
await store.listEntities(opts)          // { q, limit } -> Entity[]
await store.listRelations(opts)         // { limit } -> Relation[]
await store.touch()                     // refresh meta.snapshotAt -> ms
await store.close()
```

```js
StoreStats = {
  backend: 'sqlite',                 // or 'json'
  path: 'C:\\...\\memory_store.db',
  facts: 2, entities: 3, relations: 0,
  categories: [ { name: 'general', count: 2 } ],
  sources: [ 'auto' ],
  snapshotAt: 1792914497532,         // ms
  autoExtract: false,
  schemaVersion: 1,
}

Fact = {
  id: 'f1a2b3c4d5e6f708',
  content: 'Hermes home is D:\\hermes ...',
  category: 'general',
  tags: ['keywords', 'memory'],
  trust: 0.6,                        // 0..1
  source: 'manual',                  // 'manual' | 'agent' | 'user' | 'import' | 'auto'
  createdAt: 1792914497532,
  updatedAt: 1792914497532,
  searchCount: 1,
  helpfulCount: 0,
  entities: ['Hermes', 'MEMORY.md'], // derived from the fact_entities join
  hash: 'sha256-hex',                // sha256 of the normalized content
}

Entity = { id, name, kind: 'topic', factCount, createdAt, updatedAt }
Relation = { id, from, to, relation, factId, createdAt }
```

`queryFacts` options: `{ q, category, minTrust, limit = 200, offset = 0, sort = 'recent' }`.
`q` matches content, tags or category case-insensitively. `sort` is `'recent'`
(`updatedAt` desc) or `'trust'` (`trust` desc, then `updatedAt` desc).
`upsertFact` input: `{ content, category, tags, trust, source }`; an existing fact with the
same `hash` keeps its `id`, `createdAt`, `searchCount` and `helpfulCount`, and its
`updatedAt` is bumped.

Entity extraction: capitalised Latin words, quoted phrases, and `A-Z0-9-` tokens of length
>= 3, capped at 8 per fact — implement it in `store.js` so both backends agree.

Implement **one** logical schema on two backends behind a single API. SQLite path uses
`import('node:sqlite')`'s `DatabaseSync`; if that import fails, use the JSON file. The
JSON file must be written atomically (temp file + rename) and must survive a truncated or
absent file by starting empty. Tables (mirror them as arrays in JSON):
`facts`, `entities`, `fact_entities`, `relations`, `meta`.

## `lib/api.js` (Lead) — request handlers

Reads `cfg` + lazily-opened `store` + `lib/md.js`, returns the JSON bodies below. Pure
functions over an injected `{ cfg, store, md }` so tests can call them without a server.

```
GET  /api/dsh-memory/env      -> { ok, node, electron, platform, home, backend, storePath, version }
GET  /api/dsh-memory/overview -> { ok, version, snapshotAt, builtin:{entries,files,available},
                                   providers:{enabled,items:[Provider]}, facts:{total,shown}, budgets }
GET  /api/dsh-memory/builtin  -> { ok, files: [MemoryFile] }
GET  /api/dsh-memory/facts    -> { ok, total, filtered, categories:[{name,count}], facts:[Fact] }
                                   query: q, category, minTrust, limit
GET  /api/dsh-memory/providers-> { ok, providers: [Provider] }
GET  /api/dsh-memory/sessions -> { ok, sources:[string], sessions:[SessionHit] }
                                   query: q, source, sort ('recent'|'oldest')
POST /api/dsh-memory/refresh  -> { ok, snapshotAt }
```

```js
Provider = { id:'holographic', label:'Holographic memory', path, backend,
             configured:true, available:true, facts, shown, entities, relations,
             stores: 1, categories:[{name,count}], snapshotAt }
SessionHit = { id, title, source, updatedAt, snippet, matches }
```

`GET /api/dsh-memory/sessions` searches DSH's own session store. Keep it tolerant: if the
store cannot be read, return `{ ok: true, sources: [], sessions: [], note: '...' }` rather
than an error. Candidate locations: `C:\Users\13264\.dsh\sessions\`,
`C:\Users\13264\.dsh\dsh-session-archive\`, `C:\Users\13264\.dsh\storages\`.

## `client.js` (mem-ui) — the 记忆 page

Follow `dsh-craft-anything/client.js` exactly for the loader envelope:

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    ...
    return { inject: ['slots', 'locale'], apply(ctx) { /* styles, locale, slots */ } };
  },
});
```

**`inject` must list every host service the page reads.** DSH gates `ctx.<service>` behind the
declaration: reading an undeclared one does not return `undefined`, it throws a teaching error
through `rejectGuard`, which silently kills the surrounding `try` block. This is the single
biggest footgun in this plugin family.

- `'slots'` — required for the two registrations.
- `'locale'` — required for `ctx.locale.register()`. Without it, all `tt()` lookups fall back to
  the built-in dict (Chinese-first), so the page still works but loses host language switching.
- `'styles'` — **must NOT be declared and cannot be used.** The `styles` service exists only for
  the `harness` dynamic-package form, where it is passed as a `new Function` parameter. A
  `__ModuleLoader__.load({factory})` bundle receives only `require`, so the page appends its
  `<style>` to `document.head` **during factory evaluation** — that is the window
  `dsh-client-modules`' `claimStyles()` observes (`style:not([data-plugin])` diffed before/after
  the synchronous factory call). Injecting from `apply()` instead misses that window.

Slots: `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name:'sidebar.panellist', id:'dsh-memory', order: 41, label: () => tt('entry.label') }, Icon))` and
`ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'dsh-memory' }, Page))`.
The sidebar icon element must carry `'data-dsh-panel-entry': 'dsh-memory'`.

**Page layout — mirror the user's Hermes screenshot, in DSH's own design language.**
Use only `--dsw-alias-*` tokens (list below); never hard-code a hex colour except inside
the icon artwork. All user-visible text goes through the locale dict, with Chinese first.

1. **Header** — title `记忆`, a small `Holographic` provider badge, a one-line subtitle
   `本地记忆：Markdown 记忆文件 + Holographic 事实库`, and a read-only chip `只读`.
   Right side: `刷新` button.
2. **Four statistic cards**, in a responsive grid:
   `内置条目` → `{entries}` with sub-caption `MEMORY.md + USER.md`;
   `启用的记忆提供方` → `{enabled}` with sub-caption `Holographic`;
   `Holographic 事实` → `{facts.total}` with sub-caption `{facts.shown} 显示`;
   `快照更新时间` → the formatted timestamp with sub-caption `v{version}`.
3. **记忆筛选** panel — a search input (placeholder `内容、事实或标签...`), a category
   `<select>` (`全部分类` = all), a minimum-trust `<select>` (0, 0.3, 0.5, 0.75 — the
   reference panel's exact option set), a result
   limit `<select>` (50, 100, 500), and a green primary button `应用筛选 / 刷新`.
   Applying re-queries `/api/dsh-memory/facts` and re-renders the fact list below.
4. **内置记忆** panel — one card per `MemoryFile`: label, file name chip, an `可用`/`不可用`
   chip, `字符用量 {chars} / {budget} 字符`, `已用 {percent}%`, the modification time,
   a progress bar (green under 80%, amber to 95%, red above), the file path in monospace,
   then the entry list as numbered cards (`#{index+1}` + text). When there are no entries
   show `这个记忆文件还没有条目。`.
5. **已配置的记忆提供方** panel — a provider card with `已配置` + `可用` chips and the
   store path, four sub-counters (`事实`, `显示`, `实体`, `记忆库`), an `概览` toggle, and the
   filtered fact list. Each fact renders as: `事实 #{shortId}` + a category chip + a
   `信任度 {trust.toFixed(3)}` chip + `检索到 {searchCount}x` + `有帮助 {helpfulCount}x`,
   then the content, then tag chips, then `更新时间/创建时间`.
   Provide `有帮助` as a clickable chip that POSTs to `/api/dsh-memory/facts/{id}/helpful`
   when that route exists, degrading silently otherwise.
6. **会话搜索** panel — search input, a `来源` select (`全部来源` = all), a `排序方式`
   select (`最新优先` / `最早优先`), a `搜索会话` button, and the result list.

Fetch with `fetch(url, { credentials: 'same-origin' })`; show a non-blocking error strip on
failure; never crash the page on a missing field.

Available `--dsw-alias-*` tokens (use these names verbatim; mem-ui may add none):
`--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`,
`--dsw-alias-bg-layer-3`, `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`,
`--dsw-alias-label-tertiary`, `--dsw-alias-border-l1`, `--dsw-alias-border-l2`,
`--dsw-alias-brand-primary`, `--dsw-alias-state-success-primary`,
`--dsw-alias-state-warn-primary`, `--dsw-alias-state-error-primary`.

`dev/preview.html` must render the page **outside DSH**: stub `window.__ModuleLoader__`,
inject the tokens in `dev/tokens.css`, and drive it from an in-file mock of every API
response. This is how the page gets reviewed before DSH restarts.

## Verification each owner must run

- mem-core: `node dsh-memory/test/md.test.mjs` and `node dsh-memory/test/store.test.mjs` — both
  must be green, and `store.test.mjs` must prove the JSON backend and the SQLite backend produce
  identical `queryFacts` results for the same input.
  (`node --test dsh-memory/test/` fails on this machine with `spawn EPERM`; run the files directly —
  node:test still executes and reports in-process.)
- mem-ui: `node dev/render-preview.mjs` (or equivalent) must produce a static HTML snapshot
  without throwing, and `node --check client.js` must pass.
- Lead: `node --check index.js`, route handlers exercised against a temp home, then install
  into the profile and confirm the page appears in DSH.
