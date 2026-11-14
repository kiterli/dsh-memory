# 提交到 DSH 插件市场（awesome-dsh-plugin）

> 目标仓库：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
> 提交方式：只加一个文件 `data/plugins/kiterli__dsh-memory.yml`
> 合并后自动生成到 README 和市场索引，通常 1 天内

---

## 前置检查（提交前逐条确认）

| 项 | 要求 | 你当前状态 |
|---|---|---|
| `dsh.bundle` 清单 | 必须有（只写 `dsh.client` 会被拒） | ✅ `{"patch": "./cordis.patch.yml"}` |
| `cordis.patch.yml` | 仓库根目录存在 | ✅ |
| 真实代码 | 非占位、非纯 README | ✅ 13 万行 + 306 测试 |
| 仓库年龄 | ≥ 1 天（CI 自动检查） | ⏳ 2026-11-14 建，需到 11-15 |
| 活跃维护 | 定期扫描休眠仓库 | ✅ |
| 图标 | 可选，GitHub 托管位图 | ✅ `docs/icon-180.png` 180×180 |

**唯一未满足的是仓库年龄，等一天即可。**

---

## 第 1 步：Fork 目标仓库

打开 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin ，点右上角 **Fork**。

## 第 2 步：新增文件

在你 fork 的仓库里，进入 `data/plugins/` 目录，点 **Add file → Create new file**。

文件名（必须精确）：

```
kiterli__dsh-memory.yml
```

内容：

```yaml
url: https://github.com/kiterli/dsh-memory
name: kiterli/dsh-memory
category: memory
description:
  en: Local offline memory for DeepSeek Harness with Markdown memory files and a holographic vector fact store.
  zh: DeepSeek Harness 的本地离线记忆插件，Markdown 双层记忆加全息向量事实库。
icon: https://raw.githubusercontent.com/kiterli/dsh-memory/main/docs/icon-180.png
```

**注意**：
- 文件名用 **双下划线** 分隔 owner 和 repo
- `description.en` 结尾要有**英文句号**
- 描述里如果出现 `: `（冒号+空格）**必须加引号**，否则 YAML 解析失败
- `zh` 可选，不写维护者会补

## 第 3 步：提交 PR

Commit message 建议：

```
Add kiterli/dsh-memory to the plugin list
```

然后点 **Propose new file** → **Create pull request**。

PR 描述可以写：

```markdown
Adds dsh-memory — local offline memory for DeepSeek Harness.

- Two-layer memory: Markdown files (MEMORY.md / USER.md) + a holographic
  vector fact store (HRR, 1024-dim).
- Three-way recall: keyword / embedding / HRR, with exact hits taking hard
  precedence over fuzzy matches.
- Time decay with per-layer half-lives; auto-capture of preferences,
  decisions and corrections.
- Zero runtime npm dependencies; SQLite via built-in `node:sqlite`,
  degrading to atomically-written JSON when unavailable.
- 306 tests, CI green on Linux / Windows / macOS × Node 22 / 24.

Declares `dsh.bundle` in package.json with a `cordis.patch.yml`.
Repo is public and MIT licensed.
```

## 第 4 步：等

- CI 会自动检查仓库年龄（≥1 天）
- 维护者 review
- 合并后 README 与市场索引自动重新生成
- **你不需要运行任何脚本，也不要手工改 README**

---

## 常见拒稿原因（对照自查）

| 原因 | 你是否有此问题 |
|---|---|
| 只声明 `dsh.client`，没有 `dsh.bundle` | ❌ 没有，你是完整的 |
| 仓库创建不到 1 天 | ⚠️ **现在正好卡在这**，等 11-15 后提交 |
| 占位仓库 / 纯 README | ❌ 不是 |
| 描述 YAML 解析失败（冒号未加引号） | 按上面模板写就不会 |
| 一次性 PR 改多个插件 | ❌ 只提交一个 |

---

## 可选：发 npm 让安装更顺

市场收录后，用户点安装时执行的是 `dsh plugin add <源>`。

- **不发 npm**：用户装 `dsh plugin add github:kiterli/dsh-memory`，需要本地构建
- **发了 npm**：用户装 `dsh plugin add dsh-memory`，一条命令

要发 npm 的话：

```bash
cd dsh-memory
npm login
npm publish --access public
```

`package.json` 里已经准备好：`name: dsh-memory`、`files` 字段、`repository`、`license`、`engines`。

⚠️ 发布前确认 `.models/`（1GB）和 `node_modules/` 已在 `.gitignore` 里 —— 但 `npm publish` 看的是 `files` 字段，不是 `.gitignore`，所以没问题。
