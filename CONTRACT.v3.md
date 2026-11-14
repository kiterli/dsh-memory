# `@local/dsh-memory` — 需求与实现契约（v3）

> 本文件是当前代码的基线契约，描述 dsh-memory 在 DSH 桌面端中的真实行为、接口与边界。
> v1 为初版两层记忆骨架；v2 补齐向量召回、三层衰减、矛盾检测、归档与事件流；v3 闭环
> 反馈交互（点赞/点踩）、修正 RESTful 路由匹配、统一前端设计令牌与文案。历史契约见 `CONTRACT.md`(v1)。

插件版本：`0.1.0`，纯 ESM，**零 npm 运行时依赖**。本地 Node 22 起跑测试；DSH host 为
Electron/Node 24，`node:sqlite` 按可选处理。

---

## 1. 分层与归属

| 层 | 文件 | 职责 |
|---|---|---|
| host 半端 | `index.js` | 插件装配、webServer 路由注册、bootstrap、agent 挂载、selfcheck |
| 配置 | `lib/config.js` | 记忆根目录与预算解析 |
| 数据层 | `lib/store.js`, `lib/md.js` | 事实库（SQLite/JSON 双后端）、Markdown 记忆文件 |
| API 适配 | `lib/api.js` | 纯函数请求处理器，注入 `{cfg, store, md, sessions, getEmbedder, hrr}` |
| Agent 层 | `lib/agent.js` | 四个模型工具、systemPrompt 指令、每步召回注入 |
| 向量/嵌入 | `lib/hrr.js`, `lib/embed.js`, `embed-worker.js`, `reflection.js`, `reflection-worker.js` | HRR 符号索引、嵌入 worker、反思回填 |
| 衰减/捕获 | `lib/decay.js`, `lib/autocapture.js`, `lib/failure.js`, `lib/mood.js`, `lib/compact.js` | 三层衰减唯一实现、回合末主动抽取、失败即记忆、情绪识别、档案预算合并 |
| 检索/体检 | `lib/recall.js`, `lib/health.js` | 精确优先硬配额、三态与收据、被覆盖即失效、死记忆体检 |
| 成长 | `lib/recipe.js`, `lib/consolidate.js` | 正面经验沉淀、同主题事实压缩成结论 |
| 运行时守卫 | `lib/budget.js`, `lib/merge.js`, `lib/followup.js` | 内存预算闸门、档案写入侧合并、未完成任务追踪 |
| 评测 | `lib/eval.js`, `tools/eval-recall.mjs`, `test/fixtures/*.json` | 三类查询分开统计、只按 paraphrase 评级、拒答率门禁 |
| 前端面板 | `client.js`, `locale/zh.json`, `locale/en.json`, `dev/*`, `icon.svg` | 记忆页面、样式注入、离线预览 |
| 测试 | `test/*.test.mjs` | 契约、数据层、路由端到端、样式注入 |

运行时约定：`node:sqlite` 不可用时退化为原子写 JSON 文件；Worker 加载失败必须降级可用，
不得拖垮主进程；任一处理器抛错只影响自身路由，页面其余区域保持存活。

**嵌入 worker 的启动门槛**（v3.2）：只有「store 存在 + SQLite 后端 + 未设
`DSH_MEMORY_NO_EMBED=1`」才启动。JSON 后端没有 embedding 列，启动 worker 只会加载模型
却无法存向量；`DSH_MEMORY_NO_EMBED=1` 用于测试——Node 22 下 Worker 的两个 MessagePort
在 `terminate()` 后仍存活，会让测试进程无法自然退出。selfcheck 的 `embedder.worker`
把「主动跳过」判为通过，只有「想要却启动失败」才判失败。

## 2. 记忆根目录

由 `lib/config.js` 解析：

```
home = config.home || process.env.DSH_MEMORY_HOME || <DSH_HOME|~/.dsh>/memories
```

目录内文件：`MEMORY.md`（Agent 记忆）、`USER.md`（用户画像）、`memory_store.db`（无
`node:sqlite` 时为 `memory_store.json`）、对应 `-wal/-shm`、`MEMORY.md` 并发 `.lock`。

预算默认：agent `2200` 字符，user `1375` 字符；可经配置覆盖。

## 3. 数据层契约

### 3.1 `lib/md.js`

条目分隔符为单独一行 `§`。所有函数异步，缺文件不抛错，并发安全（best-effort `.lock`）。

```js
export const ENTRY_SEP = '§';
export const FILES = {
  agent: { key:'agent', fileName:'MEMORY.md', label:'Agent memory',  budgetKey:'agentBudget' },
  user:  { key:'user',  fileName:'USER.md',   label:'User profile',  budgetKey:'userBudget'  },
};
export async function readMemoryFile(cfg, key) -> MemoryFile
export async function writeMemoryEntries(cfg, key, entries) -> MemoryFile
export async function addMemoryEntry(cfg, key, text) -> MemoryFile
export async function removeMemoryEntry(cfg, key, index) -> MemoryFile
export async function overview(cfg) -> { entries, files, available }
```

`MemoryFile` 形状（前端与 API 共同依赖）：

```js
{
  key: 'agent' | 'user',
  label, fileName, path,
  exists: true, available: true,
  chars,            // 条目按 ENTRY_SEP 拼接后的字符数
  budget, percent,  // 0..100，一位小数
  mtime: number | null,
  entries: [ { index, text } ],
  overBudget: false,
}
```

解析：按整行恰为 `§`（允许周围空白）切分；逐条 trim；丢弃空条目；不存在的文件返回
`entries: []`、`chars: 0`、`exists: false`。写入以 `ENTRY_SEP` 独占一行拼接，文件末尾留
尾随换行；未被要求改动的条目不得重排或改写。

### 3.2 `lib/store.js`

```js
export async function openStore(cfg, options = {}) -> Store   // options: { logger }
```

对外方法（全部异步）：

```js
await store.init()
await store.stats()                       // -> StoreStats
await store.queryFacts(opts)              // -> { facts: Fact[], total, filtered }
await store.getFact(id)
await store.getFactsByIds(ids)
await store.upsertFact(input)             // 按规范化内容 hash 去重
await store.deleteFact(id) -> boolean
await store.bumpFact(id, field)           // field: 'searchCount' | 'helpfulCount'
await store.setFactTrust(id, trust)
await store.bumpAccessCount(id)           // 召回命中计数，β=2 封顶
await store.setFactMuted(id, muted)
await store.listRecentFacts(limit = 60)
await store.listEntities(opts)            // { q, limit }
await store.listRelations(opts)           // { limit }
await store.touch()                       // 刷新 meta.snapshotAt
await store.addEvent({ sessionId, content, emotion, importance, factId })
await store.listEvents({ limit = 50, sessionId })
await store.addEdge(fromId, toId, type)
await store.listEdges(factId)
await store.archiveOldFacts()
await store.cleanupStaleFacts(maxAgeMs)
await store.markContradiction(oldId, newId)
await store.addFeedback(factId, vote, query = '')
// 嵌入通道（双后端一致）：
await store.updateEmbedding(id, vec, model)
await store.listFactsNeedingEmbedding(currentModel)
await store.getFactEmbedding(id)
await store.listAllEmbeddings()
await store.countEmbeddings()
await store.close()
```

`queryFacts` 选项：`{ q, category, minTrust, limit = 200, offset = 0, sort = 'recent' }`；
`q` 大小写不敏感匹配 content/tags/category；`sort` 为 `recent`（updatedAt desc）或 `trust`
（trust desc，再 updatedAt desc）。

`Fact` 形状：

```js
{
  id, content, category, tags: [],
  trust: 0..1,
  source: 'manual' | 'agent' | 'user' | 'import' | 'auto' | 'markdown',
  createdAt, updatedAt, searchCount, helpfulCount,
  entities: [],        // fact_entities 联表派生
  hash: 'sha256-hex',
}
```

`upsertFact` 同 hash 的既有事实保留 `id`、`createdAt`、`searchCount`、`helpfulCount`，
仅刷新 `updatedAt`。实体抽取：大写拉丁词、引号短语、`A-Z0-9-` 长度 ≥3 的 token，每条
事实上限 8 个，双后端实现必须一致。

**反馈与信任**：`addFeedback` 写 `feedbacks` 表；`vote === 'up'` 信任 `+0.05`，否则
`-0.15`，clamp 到 `0..1`；`permanent = 1` 的事实不参与信任调整。HTTP 层对 `/feedback`
做参数校验：缺 `factId` 或 `vote` 不为 `'up'|'down'` 回 **400**。

**召回缓存**：`retrieveFacts()` 有 5 分钟查询级缓存；`memory_record` / `memory_forget`
成功后立即整体失效（`invalidateRecallCache()`），保证「刚记住就能召回、刚忘掉就召回不到」。

**生命周期字段**：`upsertFact` 对同 hash 内容重写时保留
`accessCount / lastHitAt / muted / permanent / bodyStr / sumStr / kwStr`
（否则每次重复记录都会重置召回状态），但会把 `archived` 复位为 0（重新记录即复活）；
`setFactPermanent(id, bool)` 显式设置永久豁免。
`bumpAccessCount` 以 β=2 封顶，不再承载 permanent 晋升（该路径在 β=2 下不可达）。

**归档**：`archiveOldFacts({minAgeDays, maxTrust})` 只归档「至少 180 天 + 从未被召回
（`accessCount === 0`）+ `trust ≤ 0.5` + 非 permanent + `source !== 'user'`」的事实；
归档行留在库与导出中，`queryFacts` / `stats` 默认排除，`includeArchived: true` 可审计。

**表清单**（SQLite 建表，JSON 后端镜像为数组）：`facts`, `entities`, `fact_entities`,
`relations`, `events`, `edges`, `feedbacks`, `meta`。

双后端必须对同一输入产出一致的 `queryFacts` 结果；JSON 写入走临时文件 + 改名（原子），
截断或缺文件时空库起步。

## 4. Agent 层契约（`lib/agent.js`）

四个模型工具（前缀 `memory`）：

| 工具 | 作用 |
|---|---|
| `memory_record` | 持久化一条事实（content / category / tags / trust） |
| `memory_search` | 关键词 + HRR 向量混合检索 |
| `memory_list` | 列出记忆与分类计数 |
| `memory_forget` | 按 id 或最佳匹配删除 |

- 每个工具必须声明 `output: { schema, render, presentationMeta? }`；访问 `ctx.tools` /
  `ctx.webServer` / `ctx.systemPrompt` 前必须先在插件 `inject` 中声明，读未声明服务会抛
  teaching error 并静默中断周围 `try`。
- `ctx.systemPrompt.section` 注入指令：用户说「记住…/记一下…/remember that…/以后都…」
  或陈述持久偏好、决策、纠正、机器事实时，必须立即调 `memory_record`，只在文字里确认而
  不调工具，该记忆回合结束即丢失。
- `agent/pre-step`（prepend）每轮注入上下文：**Markdown 档案只在会话首轮注入**（变化慢，
  每轮重复会淹没对话），**相关事实每轮召回**——已注入过的 fact 按 id 去重不再重复，但换了
  话题的新事实仍会到达。注入消息带前缀 `[以下是我记得的事情，来自本地记忆，不是用户刚说的话]`。
  注入块 900 字 / 消息 1600 字硬预算。
- 注入的每条事实带相对时间（`3 天前`）与 trust 语气（很确定 / 记得 / 大概记得 / 隐约记得），
  让模型对不确定的记忆措辞保留余地，而不是把旧记忆当既成事实复述。
- 同一 `pre-step` 内含**主动捕获**：扫描上一轮用户发言，按持久性标记抽取未记录的事实
  （见 `lib/autocapture.js`），fire-and-forget，不阻塞回合。
- 检索共用 `retrieveFacts()`：关键词命中优先，不足时 HRR 向量在全库补齐；面板与模型看到
  的排序一致。HRR 索引由 host 半（index.js）构建一次并共享给工具与 recall 两条通道，
  record/forget 走增量 `add/remove`，宿主启动时后台全量 rebuild。
- **衰减只影响排序，不淘汰记忆**：`lib/decay.js` 是三层衰减的唯一实现（加权混合 + 0.35
  下限），召回下限 `0.12`；淘汰只能由 `archiveOldFacts` 依「旧 + 从未召回 + 低 trust +
  180 天」触发，且归档行保留在库与导出中。

## 5. HTTP API 契约

前缀 `/api/dsh-memory`。所有处理器先过 `guard`：非 loopback/不同源回 **403**，方法不符回
**405**；请求体上限 2MB，JSON 解析失败回 **400**。浏览器侧请求 `credentials: 'same-origin'`，
鉴权由 host 连接层 cookie 完成，插件路由自身不校验 token。

| 方法 | 路径 | 说明 / 请求体 | 响应 |
|---|---|---|---|
| GET | `/env` | 运行环境 | `{ ok, node, electron, platform, home, backend, storePath, version }` |
| GET | `/overview` | 总览（含 Markdown mtime 外部变更同步） | `{ ok, version, snapshotAt, builtin, providers, facts, budgets, holographic, embedding, home }` |
| GET | `/builtin` | 内置记忆文件 | `{ ok, files: [MemoryFile], home }` |
| POST | `/builtin` | 写 Markdown：`{ key:'agent'|'user', entries?:string[], text?:string }` | `{ ok, file }` |
| GET | `/facts` | 查询：`q, category, minTrust, limit, offset, sort` | `{ ok, total, filtered, matched, categories, facts:[Fact+shortId], holographic, query }` |
| POST | `/facts` | 新增事实：`{ content, category, tags, trust, source }` | `{ ok, fact }`；缺 content 回 `{ ok:false, error }` |
| POST | `/facts/{id}/helpful` | **RESTful 点赞**，路径参数，无 body | `{ ok, fact }`（`helpfulCount` +1）；未匹配子路径 **404** |
| POST | `/feedback` | 点踩/反馈：`{ factId, vote:'up'|'down', query? }` | `{ ok, id, factId, vote, query }` |
| GET | `/events` | 事件流，`limit` 默认 50（1..200 clamp） | `{ ok, events }` |
| GET | `/providers` | 提供方卡片 | `{ ok, providers: [Provider] }` |
| GET | `/sessions` | 会话检索：`q, source, sort('recent'|'oldest'), limit` | `{ ok, sources, sessions:[SessionHit], note? }`；读不到时宽容返回空 |
| POST | `/refresh` | 刷新快照时间 | `{ ok, snapshotAt }` |
| POST | `/helpful` | **legacy 兼容**：body `{ id }`，等价于 RESTful 点赞 | `{ ok, fact }` |
| GET | `/selfcheck` | 端到端自检（见 §7） | `{ ok, passed, total, checks[] }` |
| GET | `/export` | 全量导出 JSON（剥离 embedding blob） | `{ ok, version, exportedAt, tables, counts }` |
| POST | `/import` | 导入（upsert，不删现有）：`{ tables:{ facts:[...] } }` | `{ ok, imported }` |

```js
Provider  = { id:'holographic', label, path, backend, configured, available,
              facts, shown, entities, relations, stores, banks, categories,
              snapshotAt, markdownFiles, holographic:{ enabled, dim, magic } }
SessionHit= { id, title, source, updatedAt, snippet, matches }
```

### 5.1 路由匹配硬约束（踩坑点）

DSH webServer 只有两种路由类型，**无 `:id` 段或正则段**：

- `exact`：按 pathname 精确匹配，优先于 prefix。
- `prefix`：最长前缀命中，判定为 `pathname === prefix || pathname.startsWith(prefix + "/")`。

暴露 `/facts/{id}/helpful` 这类路径参数接口时，注册一条 `kind:"prefix"`、
`path:"/api/dsh-memory/facts"`（**path 不带尾斜杠**），在 handler 内用
`new URL(req.url).pathname` 正则 `/^\/api\/dsh-memory\/facts\/([^/]+)\/helpful$/` 提取 id，
不匹配回 404。

> 若 prefix 写成 `/facts/`（带尾斜杠），`prefix + "/"` 拼出双斜杠 `/facts//`，子路径永远
> 匹配不上，路由被静默跳过、落到 fallback 404。同 stem 上的 exact `/facts` 列表路由不受影响
> （两张表分开查重，匹配顺序先 exact 后 prefix）。

## 6. 前端面板契约（`client.js`）

Loader 信封对齐 `dsh-craft-anything/client.js`：

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    return { inject: ['slots', 'locale'], apply(ctx) { /* 样式、locale、slots */ } };
  },
});
```

- `inject` 只列 `['slots', 'locale']`。`'styles'` **禁止声明、禁止使用**：bundle 形态下样式
  在 factory 求值期追加到 `document.head`（`claimStyles()` 观察 `style:not([data-plugin])`
  的前后差），从 `apply()` 注入会错过该窗口。
- Slots：`sidebar.panellist` 注册侧栏入口（`order: 41`，图标元素带
  `data-dsh-panel-entry: 'dsh-memory'`）；`main` 注册主面板 Page。

### 6.1 页面区域

1. **Header**：标题「记忆」、Holographic 提供方徽标、副标题「本地记忆：Markdown 记忆文件 +
   Holographic 事实库」、只读 chip；右侧「刷新」。
2. **四张统计卡**：内置条目、启用提供方、Holographic 事实（总数/显示）、快照时间（副标题
   `v{version}`）。
3. **记忆筛选**：搜索框、分类下拉、最低信任度下拉（0 / 0.3 / 0.5 / 0.75）、结果上限下拉
   （50 / 100 / 500）、主按钮「应用筛选 / 刷新」；触发后重查 `/facts` 并重渲染列表。
4. **内置记忆**：每个 `MemoryFile` 一张卡——标签、文件名 chip、可用/不可用 chip、字符用量
   `{chars} / {budget}`、已用百分比、修改时间、进度条（<80% 绿，≤95% 琥珀，>95% 红）、
   等宽路径、编号条目列表；空态显示占位文案。
5. **记忆提供方**：提供方卡（已配置 + 可用 chip、路径、事实/显示/实体/库计数、概览开关），
   下方事实列表。每条事实：`事实 #{shortId}` + 分类 chip + `信任度 {trust.toFixed(3)}` chip +
   `检索到 {searchCount}x` + `有帮助 {helpfulCount}x`，正文、标签 chip、更新/创建时间。
6. **会话搜索**：搜索框、来源下拉、排序下拉（最新/最早）、搜索按钮、结果列表。
7. **事件时间线**：折叠/展开列表，标题与箭头走 locale 与线条图标，不内联硬编码字符。

### 6.2 反馈按钮交互

- **点赞（有帮助）**：线条上投票图标 + 文案 chip，`POST /api/dsh-memory/facts/{id}/helpful`，
  无 body；成功后本地乐观更新 `helpfulCount + 1`；非 2xx 静默降级，不弹错。
- **点踩（降权）**：线条下投票图标 + 文案 chip，`POST /api/dsh-memory/feedback`，body
  `{ factId, vote: 'down' }`；成功后本地 `trust - 0.15`（clamp 0）；非 2xx 静默。
- 计数后缀用 ASCII `x`（如 `有帮助 3x`），禁止 `×`；信任度三位小数。

### 6.3 设计令牌与文案

- 只允许引用白名单令牌：`--dsw-alias-bg-base`、`-bg-layer-1/2/3`、`-label-primary/secondary/
  tertiary`、`-border-l1/l2`、`-brand-primary`、`-state-success-primary`、`-state-warn-primary`、
  `-state-error-primary`；圆角用 `--dsw-radius-*`。除图标 artwork 外，代码内禁止 hex 颜色、
  禁止 `--vscode-*` 变量。
- 所有用户可见文案走 locale 字典，中文优先；zh/en 键必须一一对应。图标用 13px 线条 SVG，
  不用裸 emoji 充当主操作按钮。
- fetch 统一 `credentials: 'same-origin'`；字段缺失不得崩溃页面，失败显示非阻断错误条。
- `dev/preview.html` 可在 DSH 外离线渲染：stub `__ModuleLoader__`，`dev/tokens.css` 注入
  令牌，用内置 mock 驱动每个 API 响应。

## 7. 自检 `GET /selfcheck`

对正在运行的 host 做端到端探测，判定「记忆模块此刻是否真的在工作」：

- 配置 / Markdown 层 / Store 层 / store.stats / markdown.read；
- 真实 round-trip：写探针事实 → 查询命中 → 删除 → 确认清空；
- Holographic 健康：编码确定性、单位向量、中文换词排序合理；
- 会话扫描；`agent.tools` 与 `agent.recall` 两项——缺一即为空壳。

## 8. 验证命令

> 本机 `node --test <dir>` 会因沙箱 `spawn EPERM` 失败，直接跑单文件，`node:test` 在进程内
> 执行并报通过/失败。

```bash
node --check index.js client.js lib/*.js

node test/md.test.mjs              # 13
node test/store.test.mjs           # 26（JSON vs SQLite 一致性 + 原子写）
node test/hrr.test.mjs             # 15（确定性 / 中文检索 / 性能）
node test/routes.test.mjs          # 2（host 半端到端 + selfcheck）
node test/client.contract.test.mjs # 12（页面契约 + 区域 + 令牌）
node test/agent.test.mjs
node test/embed.test.mjs
node test/style-injection.test.mjs
node dev/render-preview.mjs        # 产出静态快照，不抛错
```

## 9. 已知限制 / 遗留

- 事实库尚无 `fact_versions` 双时态历史（Hermes 有）；当前为「每事实一行 + 计数」简化模型。
- 会话搜索读 `sessions/*/session.v4.jsonl.zstd`；运行时无 `zlib.zstdDecompressSync`
  （Node <23.8）时友好降级并注明。
- 嵌入 worker 受 16GB 内存约束，OOM 时回退到本地兜底编码，面板需如实标注嵌入就绪状态。
- JSON 后端不承载嵌入向量（`updateEmbedding` 等 5 个方法为 no-op），语义通道只在 SQLite
  后端可用；HRR 通道双后端均可。JSON 后端的维护类操作已按固定语句补实现（见 §10 v3.2），
  但它不是通用 SQL 引擎——新增维护 SQL 时必须同时补 JSON 分支。
- reflection-worker 的模型（distilgpt2）仅保留加载链路，抽取实际由规则模式驱动；其
  `PREFERENCE_PATTERNS` 输出未做句子化（「记住X」截断为片段），产出质量一般，属于
  已接受的实验特性。主动捕获（`lib/autocapture.js`）是更可靠的补充路径。
- 自动捕获是**规则式**的：它不认识语义等价、不跨轮归纳，宁可漏也不误记。要做到「每周把
  同实体的零散事实压缩成结论」还需要真正的巩固（consolidation）环节，目前未实现。
- `memory_record` 返回 `mergedInto` / `mergedReason` / `mergedScore` / `contradicts`，
  这些字段未全部在工具 output schema 中声明（模型可见性不受影响，属已接受的历史告警）。
- 尚未实现：检索通道权重的在线学习（`feedbacks` 只调整 fact trust，不调整 match 通道
  权重）、图谱一阶扩展、项目/主题作用域、面板直接增删事实。

## 10. 变更记录

- **v3.8（全部收尾：内存保护 / 档案合并 / 惦记 / 双时态 / JSON 语义 / 面板可编辑）**：
  - **内存预算保护**（`lib/budget.js`）：这轮实测把系统内存打到连 PowerShell 都起不来
    （`System.OutOfMemoryException`）。现在加载 embedder 前先判断：免费内存 ≥ 成本+余量，
    **且**在 ≤20GB 的机器上免费占比 ≥30%。成本从 900MB 校准到 **1400MB**——900MB 那版会
    放行 2233MB/14GB 的场景，而那正是崩溃现场；纯绝对值也不够，14GB 机器剩 2.2GB 看着够，
    实际只剩 16%。自检/面板会说明为什么没加载。
  - **档案写入侧合并不再无限膨胀**（`lib/merge.js`）：以前 `mirrorToBuiltin` 只追加，
    预算是**读取时**的限制，所以文件本身一直变长、只有最新几条会被注入。现在超预算时按
    主题合并同义条目——**保留新表述、把旧条目里新表述没有的从句补上**，从不改写、从不丢弃；
    仍放不下时如实报告 `needsMore`。
  - **惦记未完成的事**（`lib/followup.js`）：这是插件里唯一面向**未来**的行为。
    「先做到这里/还没做完/继续做/待办」开启，`做完了/搞定了/不用了` 关闭；一会话最多提一次，
    14 天过期，队列存 `meta.followups` 无需改 schema。题面提取要剥离信号词但保留主题——
    第一版把「今天先做到这里」整段吃掉、留下「做到这里」当主题，已修。
  - **双时态历史**（`fact_versions`）：每条事实每次内容变更写一行版本，带
    `validFrom/validTo/recordedAt/reason`。`listFactVersions(id)` 看全部修订，
    `factAsOf(id, t)` 回答「那个时刻我相信什么」。被推翻时关闭当前版本并记
    `superseded-by:<id>`。SQLite 建表 + JSON 后端等价实现双支持。
  - **JSON 后端补语义向量**：`updateEmbedding` 等五个方法原来是 no-op，无 `node:sqlite`
    的环境因此整档失去语义通道（而实测 HRR 无法跨同义词）。现在向量存在行内，随文件
    自然往返。
  - **面板可编辑** `POST /api/dsh-memory/edit`：`delete`（含同步清理 USER.md 镜像）、
    `permanent`、`mute`、`explain`（为什么可/不可被召回 + 版本历史）。此前修一条错记忆
    只能靠模型或 curl。
  - 新增 `test/budget.test.mjs`（11）、`test/merge.test.mjs`（17）、`test/followup.test.mjs`（20）。
  - 全套 **21 个套件**通过。
- **v3.7（评测集 + 字面锚点）**：
  - **新增评测体系**：`lib/eval.js`（评分）+ `tools/eval-recall.mjs`（运行器）+
    `test/fixtures/recall-paraphrase.json`（12 条手写真实问法）。在此之前所有测试只回答
    「机制有没有坏」，没有一个回答「真问题找不找得到正确答案」。
  - **三类查询分开统计，绝不合成一个数字**：`literal`（取事实原文的**连续片段**，
    只证明关键词通道没坏，是地板不是成绩）、`paraphrase`（用户真实问法，**真正的测量**）、
    `unanswerable`（库里没有的东西，测拒答）。评级只由 paraphrase 决定，拒答率 ≤0.5
    直接判 `over-eager`——「永远答点什么」的检索器不可靠，不是好。
  - **修掉一个自己造的假结论**：评测工具最初调 `recall()` 时没传 embedder 和 HRR，
    等于只测关键词通道却当成整个检索器，得出 paraphrase 0/10；且 `NO_EMBED=1` 时连
    HRR 也被跳过（HRR 是纯算术、不占内存、不需要模型）。修正后同一批查询变成 8/10。
    另有一处：字面查询最初把事实里**两个不相邻的词**拼起来，而 store 是子串匹配，
    必然查不到——11 条全废。现改为取原文连续片段并断言「必须是原文子串」。
  - **字面锚点约束（本次最重要的实质修复）**：实测本机 12 条事实下，HRR 对**相关**改写
    查询的 top 分 0.0937–0.1867，对**无关**查询 0.0445–0.1353，**两个分布几乎完全重叠**，
    任何分数阈值都分不开——旧的 0.05 阈值等于没拦，导致「我平时几点上班」会命中千问
    文生图流程。现要求联想通道（embedding / HRR）必须与查询**共享至少一个内容 token**
    （CJK 二元组 + 拉丁词，去停用词），否则不采信。效果：召回 0.8→0.7、MRR 0.524→0.617、
    **拒答率 0.5→1.0**、评级 over-eager→fair。用 0.1 召回换掉「对无关问题编答案」，这个
    取舍是刻意的。
  - **强字面锚点（最终形态）**：把「共享任意内容 token」升级为「共享**强** token」——
    拉丁词需 ≥3 字符（`ocr`/`pnpm`/`rtx`），CJK 二元组至少要有一个非功能字。实测这条
    阈值是分水岭：放宽到任意二元组时，「我平时几点上班」靠 `我平`/`时几` 之类噪声也能
    通过，召回冲到 1.0 而拒答率崩到 0；收紧后 6/6 相关/无关判定全对。
  - **锚点改为必需，不是可选**：中途一版写成「有锚点 **或** 分数过阈值」，等于把阈值
    重新放回来当主判据——而分数分布重叠的原因正是它不可用。现在无强锚点一律不采信，
    分数只用于**排列**已通过锚点的候选。
  - **HRR 自我抵消的修正**：HRR 是随机单位向量求和，文本里同一 token 出现多种形式
    （`OCR` / `dsh-ocr` / `RapidOCR`）会互相抵消——实测 OCR 那条事实对「OCR 是怎么跑的」
    的 HRR 得分是 **−0.008（负分）**，却被旧的 0.05 阈值挡掉。现在强锚点可以直接准入，
    并把有效分抬到 ≥0.3，避免它排在最后。
  - **排序改为相关性优先**：旧公式 `score*w + dynTrust*0.2` 让高信任但无关的旧事实压过
    正确答案——实测「这个插件装在哪个目录」把 HRR 全场最高（0.1867）的目标压到第 6 名，
    只因为另两条无关事实的 dynTrust 是 0.97/0.95。信任度降级为**平局裁决**
    （系数 0.02），不再能凌驾于明显更好的匹配。
  - **语义通道也要证据，但允许同义词桥**：实测 embedding 分数同样不可单独作判据——
    无关查询「我希望你怎么写代码注释」在五条无关事实上拿到 **0.457–0.485**，高于真正正确
    的同义命中（0.4259）。所以语义通道也要求证据，只是证据种类多一种：**同义词桥**
    （`语言↔中文`、`配置↔硬件`、`目录↔路径`…，显式表，不开「无条件相信向量」的口子）。
    桥接只采信**分数最高的那一个**候选——否则「语言」会给所有提到中文的事实开门。
  - **最终基线**（12 条事实，keyword + embedding + HRR 三通道全开）：paraphrase recall@5
    **1.0**、MRR **0.9**、拒答率 **1.0**、评级 **good**。调优轨迹（同一批 10 条查询）：
    0.0/poor（只有 keyword）→ 0.8/over-eager（+HRR 无锚点）→ 0.7/fair（+任意锚点）→
    1.0 但拒答 0（锚点放宽的**假象**）→ 0.9/good（+强锚点必需）→ **1.0/good**（+有证据的
    语义通道）。中间那次 1.0 是假的，靠 `我平`/`时几` 这类噪声二元组通过锚点。
  - **高频动词不算锚点**：锚点必须是**指代主题**的词。实测一个漏网的拒答探针——「中世纪
    手抄本使用的铁胆墨水配方」因为共享 `使用` 命中了「深度使用 DSH 插件开发」。`使用/需要/
    可以/通过/包括/问题` 这类动词在任何技术文本里都有，不指代任何东西，现整词列入
    `WEAK_TOKENS` 黑名单。字级别过滤无法表达「这是个动词」，只能整词排除。
  - **最终基线**（12 条事实，三通道全开）：
    paraphrase fixture：recall@5 **1.0**、MRR **0.9**、拒答 **2/2**、**good**；
    自动字面 fixture：字面 recall@5 **1.0**（MRR 0.833）、拒答探针 **6/6**。
  - 新增 `test/eval.test.mjs`（23 项）、`test/recall.test.mjs` 锚点与语义用例（+16 项）。
  - 全套 **262 项**通过（18 个套件）。
- **v3.6（从「堆积」到「成长」：使用度衰减 / 正面经验 / 巩固）**：
  - **解除 accessCount 的 β=2 封顶**：这个上限让计数无法回答唯一值得问的问题——
    「这条记忆到底有没有被用到」——因为「写下当天被召回两次」和「一年里每周被召回两次」
    看起来一模一样。现在持续累加（存储值在 1000 饱和，列仍是很小的整数）。
  - **使用度感知衰减**：`lib/decay.js` 新增 `usageFactor`。召回次数（对数曲线）+ 最近
    一次命中时间（90 天半衰）共同决定初始曲线的拉伸倍数，落在
    `[0.15, 1]`。实测同样 30 天龄的事实：从没召回 dynTrust=0.288，召回 10 次 0.334，
    召回 50 次（昨天）0.528，召回 50 次（半年前）回落到 0.298——**用过的东西衰减更慢，
    但不会永生**。
  - **正面经验 `auto:recipe`**：新增 `lib/recipe.js`。此前的自动捕获只记负面（坑、失败），
    跑通的好流程全靠人手动记——本机最有价值的那条千问文生图配方就是手工录的。现在
    满足三个条件即沉淀：≥2 次成功动作调用、整轮无失败、含可复现的具体参数（模型文件名 /
    Windows 路径 / 带 flag 的命令 / 多个 key=value）。trust 0.6，同会话按签名去重。
  - **巩固 `lib/consolidate.js`**：同一主题（同分类 + 内容词重叠 ≥0.35）累计 ≥4 条时压缩成
    一条结论，**结论由源事实原句拼装而非改写**（每一句都可回溯），源事实以
    `superseded` 退役**不删除**，并写 `consolidates` 边。每日定时执行，不在启动时跑
    （新进程不该在用户开口前就重写记忆）。真库试运行结果：12 条事实、0 组达阈值，
    未做任何改动。
  - 新增 `test/recipe.test.mjs`（17 项）与 `test/consolidate.test.mjs`（17 项）。
  - 全套 **218 项**通过。
- **v3.5（记忆不再撒谎：收据 / 三态 / 精确优先 / 被覆盖即失效 / 体检）**：
  - **收据与三态**：新增 `lib/recall.js`。`retrieveFacts` 返回的数组现在带
    `status`（`direct` / `related` / `none`）与 `receipt`（每条事实的命中通道、分数、
    信任度、年龄、是否已失效）。注入块在 `related` 时明确写「只有沾边的记忆，没有直接
    答案；别当成事实」，`none` 时写「记忆里没有直接相关内容，不要编造」。
    此前三种情况（精确命中 / 向量沾边 / 已被推翻）折叠成同一个数组，模型一律当事实复述。
  - **精确优先是硬配额，不是加权**：旧排序把通道按权重混合（keyword 1.0 / embedding
    0.7 / holo 0.3），高分模糊命中可能压过字面命中。现改为硬分带：精确命中先占位且
    **永不被挤出**（上限 `DIRECT_QUOTA=0.6`），联想通道只填空位。
  - **被推翻的事实出局**：`markContradiction` 此前只把 trust × 0.3 仍留在召回池里，于是
    「改用 24550 端口」被纠正后，一周后仍会从旧事实里背出错误答案。现在标记
    `superseded = 1` 并默认排除；`includeSuperseded: true` 才可查（保留「以前是怎么定的」
    的可答性）。`superseded/supersededBy` 已贯通 SQLite 建表、迁移、SELECT/INSERT、
    JSON 后端与 `upsertFact`（重复写同一句不会复活被推翻的结论）。
  - **死记忆体检**：新增 `lib/health.js`，纯统计无模型。四项发现：长期未被召回、
    矛盾双方仍同时生效、近似重复、永久标记但从未召回。接入 `/selfcheck` 的
    `memory.health` 项，**只报告不删除**。
  - 新增 `test/recall.test.mjs`（16 项）与 `test/health.test.mjs`（13 项）。
  - 全套 **184 项**通过。
- **v3.4（情绪真实流入 + 档案不再丢老偏好）**：
  - **情绪真的写进去了**：新增 `lib/mood.js`。此前 `events.emotion/importance` 只有
    `memory_record` 一个写入方，而模型调用时从不带情绪，所以「上次你有点烦」永远说不出来
    ——回注逻辑是死重。现在 `pre-step` 用规则词库识别**当前**这句里的情绪（frustrated /
    tired / anxious / happy / satisfied / confused）与重要性（上线/发布/回滚 = 0.9），
    写入事件流；同会话按「情绪+内容前缀」去重，一段持续的烦躁不会写二十条。
    刻意保守：普通技术对话一律返回 null（`帮我看下这个报错`、`接着推进`、`你好，小智`
    都不得推断情绪）——把「上次你有点烦」说给一个本来不烦的人，比不说更糟。
  - **档案不再静默丢弃老偏好**：新增 `lib/compact.js`。旧 `readProfileText()` 从最新往前
    取，装满就 `break`，于是**比该点更旧的条目永远进不了 prompt**（面板上还看得见，所以
    看起来没问题）。实测在 700 字符预算下，旧逻辑会整条丢掉「称呼=小智」「用简体中文」
    「专家风格」——恰恰是最底层的偏好。现改为**按主题分桶轮转**：每个主题至少保留一条，
    反复出现的主题多留几条，同主题内最新表述优先；实在放不下时返回一行
    「受预算限制，另有 N 条未注入：主题 a/b…」让损失可见而非消失。
  - 新增 `test/mood.test.mjs`（14 项）与 `test/compact.test.mjs`（14 项）。
  - 全套 **155 项**通过。
- **v3.3（有人味 + 自我成长）**：
  - **失败即记忆**：新增 `lib/failure.js`。在 `pre-step` 扫描上一轮的工具结果，把
    `message.isError === true` 的失败转成 `auto:failure` 事实（trust 0.55）。
    判定只用 `isError`——实测本机 361 条工具结果中 66 条**文本含**错误字样（读到的文件
    内容里有「错误」二字），而真实失败只有 6 条；文本匹配会把 60 条噪音写成教训。
    排除：用户中断 / 策略拒绝（`AbortError`、`cancelled`、approval denied）；排除语气词
    （`Error: something went wrong`）；要求错误里带具体主体（路径 / 已知命令 / 环境变量 /
    反引号标识符）。同会话按 `工具+类型+错误首行` 去重，同一堵墙只记一次。
  - **情绪回注**：`events` 表的 `emotion` / `importance` 此前只写不读，现在会话首轮会取
    最近 7 天内情绪非中性或重要度 ≥0.75 的一条，注入一句「上次聊到「…」时你有点烦。」。
    刻意安静：最多一行，没有情绪就不出现。
  - **人设**：`config.assistantName`（默认「小智」）注入为记忆指令的第一行，并写明
    「用户提到「小智」就是在叫你，你应以该身份说话」；指令新增一整段口吻规范——沿用注入
    块的时间与语气、不逐条罗列记忆、不背书、被纠正时先认错改口、按对方状态调整长短与
    情绪承接。
  - 新增 `test/failure.test.mjs`（14 项）锁住「abort 不算失败 / 只有 isError 算失败 /
    同墙只记一次 / 工具名从 tool-call 解析」。
  - 全套 **127 项**通过。
- **v3.2（记忆存活与人性化）**：
  - **三层衰减重算**：新增 `lib/decay.js` 作为唯一实现。旧公式把三层因子**连乘**
    （`0.5^(age/3.5)·0.5^(age/4.8)·0.5^(age/7.1)`），等效半衰期仅 **1.58 天**，叠加
    `dynTrust >= 0.2` 硬阈值后，**第 4 天起所有非 permanent 事实对模型彻底不可见**
    （自动召回与 `memory_search` 共用该函数）。现改为三层**加权算术混合**（权重
    0.5/0.3/0.2，和为 1），并把结果压缩到 `[DECAY_FLOOR=0.35, 1]`：衰减只影响排序，
    不再淘汰。召回下限降到 `0.12`，一年旧事实仍可检索。契约新增 `recall.decay` 自检项
    直接断言「7 天仍可用 / 1 年仍可查 / 半衰期在 2–14 天之间 / 曲线单调」。
  - **去重不再丢内容**：旧逻辑「与最近 60 条共享 ≥2 实词即判为同一件事」后**直接返回**，
    新内容既不落库也不写 MEMORY.md，只给旧事实 trust +0.1 —— 两件不同的事情（同一子系统
    的两条事实）会静默丢失第二条，而工具仍报成功。现要求近重复（Jaccard ≥ 0.8 或
    embedding cosine ≥ 0.92）才合并，**新内容始终写入**，合并只做 `addEdge(related)` +
    提权，返回值新增 `mergedReason` / `mergedScore` 告知模型。
  - **矛盾检测放宽**：旧规则要求否定词 + cosine ≥ 0.85 且在被去重路径挡掉之后才检查，
    实际几乎不触发；现独立检查（cosine ≥ 0.8 + 否定词），阈值 `0.8`，并把边接在新旧
    事实之间（此前 `new:<timestamp>` 是错误的目标 id）。
  - **召回改为每轮**：旧的 `injectedThisSession` 使整个会话只注入一次，会话后半段换话题
    后完全失明，且首轮档案为空会永久打上标记。现每轮都召回，用 `injectedFactIds` 只去重
    已注入的 **fact**（不是「本会话不再注入」）；档案仅在首轮注入（它变化慢，每轮重复
    3.5k 字会淹没对话）。注入块有 900 字 / 整条消息 1600 字硬预算。
  - **注入语气人性化**：每条事实带相对时间（「3 天前」）与 trust 语气（很确定 / 记得 /
    大概记得 / 隐约记得），前缀改为「以下是我记得的事情……不是用户刚说的话」。
  - **主动捕获**：新增 `lib/autocapture.js`。在 `pre-step` 里扫描**上一轮**用户发言，
    按规则（explicit / standing / preference / environment / correction / pitfall）
    抽取持久事实，trust 0.55–0.8、`source='agent-auto'`、`category='auto:*'`。保守设计：
    必须含持久性标记、长度 8–240、屏蔽密钥、幂等（同内容不重复）。无新钩子依赖——上一轮
    在第 N 轮开始时处理，所以即便某轮崩溃也能补捕。
  - **归档接线**：`archiveOldFacts` 此前无调用方且 `archived` 从未被查询排除（`factFromRow`
    不输出该字段）。现共享衰减模块、要求「旧 + 从未被召回 + trust ≤ 0.5 + 至少 180 天」
    才归档，`queryFacts` / `stats` 默认排除归档，boot 与每日定时执行，dispose 清 timer。
    归档可被重新记录复活。
  - **JSON 后端补齐维护接口**：`archiveOldFacts` / `cleanupStaleFacts` / `markContradiction`
    / `addFeedback` 都调用 `backend.all/run`，而 JSON 后端**没有这两个方法** —— 无
    `node:sqlite` 时这些维护动作与「点赞/点踩」全线抛错。现为 JSON 后端实现这 6 条固定
    SQL 的等价操作（未知语句显式抛错而非静默成功），并补 `_dirty` + `_serial` 收尾落盘。
  - **archived 字段全链路**：`normalizeFactRow` / `factFromRow` / SQLite `snapshot` /
    `getFactRow` / `putFact` 全部纳入 `archived`，否则重启即复活已归档事实。
  - 自检新增 `recall.decay` 与 `recall.perTurn` 两项回归探针。
  - **嵌入 worker 启动门槛**：仅 store 存在 + SQLite 后端 + 未设 `DSH_MEMORY_NO_EMBED=1`
    才启动；修复 `dispose()` 与异步 `start()` 的竞态（此前 worker 及其两个 MessagePort
    在 dispose 后仍存活，导致进程无法退出）；`embedder.worker` 自检把主动跳过判为通过。
  - 测试侧：`routes`/`agent` 测试自行设置 `DSH_MEMORY_NO_EMBED=1`；`store` 契约断言
    纳入 `archived` 字段；`agent` 测试的注入前缀断言跟随新文案。全套 113 项通过。
  - **自动捕获只收完整句**：初版把规则的两个锚点之间当事实（`/不能(.{4,120})会/`），
    真实运行中产出残句「裸 spawn venv python main.py——缺 activate.bat 设置的环境时进程」。
    现除 `explicit`（「记住：」之后本来就是待记内容）外，规则仅用于**判定**持久性，
    事实取整句；另加残句兜底（以「的/，/时进程」结尾直接丢弃）。新增
    `test/autocapture.test.mjs`（15 项）锁死该行为。
  - 新增 `test/decay.test.mjs`（15 项），把「7 天可用 / 1 年可查 / 单调递减 / 半衰期 ≥3 天 /
    permanent 豁免 / 地板不破」写成断言，防止 1.58 天那类退化再次静默发生。
- **v3.1（审查修复）**：
  - 修复 `mountRecall` 引用未定义 `hrrIndex` 的 ReferenceError——自动召回的「相关事实」
    通道此前每次都抛错静默降级为只注入档案。
  - index.js 构建共享 HRR 索引（rebuild + 增量 add/remove），工具与 recall 共用。
  - `upsertFact` 重写保留 `accessCount/muted/permanent/bodyStr/sumStr/kwStr`；补
    `randomUUID` 导入（events/edges/feedbacks id 生成此前会抛 ReferenceError）。
  - `bumpAccessCount` 移除 β=2 下不可达的 permanent 晋升；新增 `setFactPermanent`。
  - record/forget 后失效召回缓存；recall 注入标记与内容判断解耦（首轮空档案不再让
    同会话后续轮反复注入）；recall 两个注册的 disposer 合并，避免 context 泄漏。
  - `/events` 支持 `limit`（1..200）；`/feedback` 缺 `factId`/非法 `vote` 回 400。
  - `/overview` 的 MEMORY.md 外部变更回灌同时识别 `§` 条目与 `- ` bullet。
  - package.json：`node-llama-cpp` 降为 devDependencies（仅 dl-model.mjs 使用，运行时
    依赖只有 `@huggingface/transformers`）。
- **v3**：闭环反馈交互（点赞/点踩）、修正 RESTful 路由匹配、统一前端设计令牌与文案。
- **v2**：向量召回、三层衰减、矛盾检测、归档与事件流。
- **v1**：两层记忆骨架（Markdown + Holographic 事实库）。
