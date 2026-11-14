/**
 * Agent interface for @local/dsh-memory — the half that makes memory actually work.
 *
 * The panel (client.js) is read-only display. Without this file, nothing ever writes to the
 * store and nothing ever reaches the model's context: the store stays empty and the agent
 * never recalls. Two surfaces are needed, and they are independent:
 *
 *   1. WRITE — tools the model can call to record facts and edit the markdown files.
 *      (`ctx.tools.register`)
 *   2. RECALL — automatic injection of the memory profile into the prompt on every step.
 *      (`ctx.on('agent/pre-step', …)` and `ctx.systemPrompt.section`)
 *
 * Both are cheap: the store is already opened by index.js and passed in here.
 */

/* ------------------------------------------------------------------ helpers */

import { randomUUID } from "node:crypto";
import { captureTurn } from "./autocapture.js";
import { captureFailures } from "./failure.js";
import { recordMood } from "./mood.js";
import { captureRecipe } from "./recipe.js";
import { selectWithinBudget, describeOmission } from "./compact.js";
import {
  dynamicTrust,
  relativeAge,
  trustTone,
  RECALL_MIN_DYN_TRUST,
} from "./decay.js";
import { recall, statusLine } from "./recall.js";

const clip = (text, max) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};

/** Tools are namespaced so they cannot collide with built-ins. */
export const TOOL_PREFIX = "memory";

export function toolNames() {
  return {
    record: `${TOOL_PREFIX}_record`,
    search: `${TOOL_PREFIX}_search`,
    list: `${TOOL_PREFIX}_list`,
    forget: `${TOOL_PREFIX}_forget`,
  };
}

/* --------------------------------------------------------------- prompt text */

/**
 * The instructions section. Without it the model does not know the tools exist or when to
 * use them — a tool the model never calls is the same as no tool at all. This is why
 * `systemPrompt.section` matters as much as `tools.register`.
 */
export function instructionsText(stats) {
  const n = Number(stats?.facts) || 0;
  const name = String(stats?.name ?? "").trim() || "小智";
  return [
    "## Local memory (dsh-memory)",
    "",
    // Identity first: a name is what turns "the assistant" into someone the user talks to.
    `**你的名字是「${name}」**。用户给你起了这个名字，提到「${name}」就是在叫你，`,
    `你也应当以「${name}」的身份和口吻说话。`,
    "",
    `You have a persistent local memory store holding **${n}** fact(s), plus two markdown`,
    "files (`MEMORY.md` for agent knowledge, `USER.md` for the user profile). It survives",
    "across sessions and is stored on this machine only.",
    "",
    "**像人一样说话，而不是像数据库。** These rules are about tone, and they matter as much",
    "as the tools:",
    "- 注入给你的记忆带着时间（「3 天前」）和语气（「我记得」/「大概记得」）。请自然地沿用这种",
    "  确定性：确定的事就直说，不确定的事就说「我记得好像是…，你确认下」，**不要**把隐约记得的",
    "  东西讲得像事实，也不要每次复述「根据我的记忆」这种机器腔。",
    "- 不要逐条罗列记忆。像人一样把相关的几件事揉进一句话里；用户没问起就别主动背书。",
    "- 用户纠正你时，先说清「我记错了，改过来」，再记住新的；不要含糊过去。",
    "- 记住用户当下的状态：他赶时间就短说，他烦躁就先接住情绪再给方案。",
    "",
    "**When the user says to remember something** — \"记住…\", \"记一下…\", \"remember that…\",",
    "\"以后都…\", or states a durable preference, decision, correction or machine fact — call",
    "`memory_record` immediately. Do not just acknowledge it in prose: an unrecorded " +
      "\"记住\" is lost at the end of the turn.",
    "",
    "**Proactively record durable decisions and hard-won debugging lessons** — not only when",
    "the user explicitly says \"记住\". After you finish a non-trivial investigation, fix, or",
    "architecture decision, call `memory_record` so the next session does not re-derive it.",
    "Good triggers: a bug you root-caused, a framework contract you learned the hard way,",
    "a file format you decoded, a path/endpoint that must not be touched again, a config",
    "quirk. One fact per call, written as a standalone sentence a future agent can act on.",
    "",
    "Use `memory_search` before assuming you lack a fact: the store may already hold a",
    "preference or a decision from an earlier session. Use `memory_list` to audit what is",
    "stored. Use `memory_forget` only when the user asks you to forget something.",
    "",
    "Rules:",
    "- Record **durable** facts, not turn-local detail. \"User prefers Chinese replies\" is",
    "  durable; \"the file I just edited is x.ts\" is not.",
    "- One fact per call, written as a standalone sentence that is still meaningful without",
    "  this conversation's context.",
    "- Put the kind in `category` (e.g. `偏好` / `环境` / `决策` / `流程`) and a few short",
    "  `tags`. Set `trust` high for things the user stated directly, lower for inferences.",
    "- Never record secrets, credentials, tokens or one-off transient data.",
  ].join("\n");
}

/* -------------------------------------------------------- tool output helpers */

// Every tool must declare `output: { schema, render }`. `render` turns the structured value
// into content blocks for the transcript, so the user sees a compact line instead of JSON.
const textOut = (detail) => [{ type: "text", text: detail }];

const recordOutput = {
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      content: { type: "string" },
      category: { type: "string" },
      created: { type: "boolean", description: "true when a new fact was added, false when an existing one was updated" },
      total: { type: "number" },
      builtin: {
        type: "object",
        description: "Where the fact was mirrored in the built-in markdown memory (the 内置记忆 panel).",
        properties: {
          file: { type: "string" },
          key: { type: "string" },
          written: { type: "boolean" },
          duplicate: { type: "boolean" },
          entries: { type: "number" },
          chars: { type: "number" },
          budget: { type: "number" },
          percent: { type: "number" },
          overBudget: { type: "boolean" },
        },
        required: ["file", "key", "written"],
        additionalProperties: false,
      },
    },
    required: ["id", "created", "total"],
    additionalProperties: false,
  },
  render: (args, value) => {
    const where = value?.builtin && value.builtin.written ? ` → ${value.builtin.file}` : "";
    return textOut(
      `${value?.created ? "已记住" : "已更新"} · ${clip(value?.content, 120)}  (共 ${value?.total ?? "?"} 条${where})`,
    );
  },
};

const searchOutput = {
  schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      count: { type: "number" },
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            category: { type: "string" },
            trust: { type: "number" },
            score: { type: "number" },
            match: { type: "string" },
          },
          required: ["id", "content"],
          additionalProperties: true,
        },
      },
    },
    required: ["query", "count", "facts"],
    additionalProperties: false,
  },
  render: (args, value) => {
    const facts = Array.isArray(value?.facts) ? value.facts : [];
    if (facts.length === 0) return textOut(`记忆中没有匹配「${value?.query ?? ""}」的内容。`);
    const lines = facts.map((f, i) => `${i + 1}. [${f.category ?? "general"}] ${clip(f.content, 200)}`);
    return textOut(`找到 ${facts.length} 条相关记忆：\n${lines.join("\n")}`);
  },
};

const listOutput = {
  schema: {
    type: "object",
    properties: {
      total: { type: "number" },
      categories: { type: "array", items: { type: "string" } },
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            category: { type: "string" },
            trust: { type: "number" },
          },
          required: ["id", "content"],
          additionalProperties: true,
        },
      },
    },
    required: ["total", "facts"],
    additionalProperties: false,
  },
  render: (args, value) => {
    const facts = Array.isArray(value?.facts) ? value.facts : [];
    if (facts.length === 0) return textOut("记忆库是空的。");
    const lines = facts.map((f, i) => `${i + 1}. [${f.category ?? "general"}] ${clip(f.content, 160)}`);
    return textOut(`共 ${value?.total ?? facts.length} 条记忆：\n${lines.join("\n")}`);
  },
};

const forgetOutput = {
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      removed: { type: "boolean" },
      total: { type: "number" },
      builtinRemoved: { type: "number", description: "Markdown mirror lines removed from MEMORY.md/USER.md" },
    },
    required: ["removed", "total"],
    additionalProperties: false,
  },
  render: (args, value) => textOut(
    value?.removed
      ? `已删除记忆${value?.id ? " " + value.id : ""}${value?.builtinRemoved ? "（并从内置记忆移除）" : ""}。`
      : "没有找到要删除的记忆。",
  ),
};

/**
 * Shared retrieval used by BOTH the search tool and automatic recall.
 *
 * Three parallel channels:
 *   1. Keyword match (same category first, then relaxed)
 *   2. Embedding semantic search (Worker Thread, bge-small-zh) — cross-wording match
 *   3. HRR holographic — exact keyword hit fallback
 * Results are merged, deduplicated, and filtered (muted / dynTrust < 0.2).
 * Recall = review: hits async-bump accessCount (beta=2 cap).
 *
 * @returns {Promise<Array>} facts, best first
 */
// Recall cache: same query within 5min returns cached result (skip expensive embedding search)
const _recallCache = new Map();
const RECALL_CACHE_TTL = 5 * 60 * 1000;

/** Character budgets for the injected memory block (facts) and the whole message. */
const MEMORY_BLOCK_BUDGET = 900;
const MEMORY_MESSAGE_BUDGET = 1600;

/**
 * Invalidate the recall cache after any write (record / forget / feedback / upsert).
 * Without this a freshly recorded or freshly deleted fact is invisible to recall for
 * up to 5 minutes — "我让它记住，紧接着问却答不知道" 的直接原因。
 */
export function invalidateRecallCache(prefix = "") {
  if (!prefix) { _recallCache.clear(); return; }
  for (const key of [..._recallCache.keys()]) {
    if (String(key).startsWith(prefix)) _recallCache.delete(key);
  }
}

export async function retrieveFacts(ctx, store, query, opts = {}) {
  const q = String(query ?? "").trim();
  if (!store || !q) return [];

  const { limit = 8, category = "", minTrust = 0, embedder = null, hrrIndex = null } = opts;

  // Cache hit?
  const cacheKey = q + "|" + limit + "|" + category + "|" + minTrust;
  const cached = _recallCache.get(cacheKey);
  if (cached && (Date.now() - cached.time) < RECALL_CACHE_TTL) {
    return cached.results;
  }

  // The retrieval itself lives in lib/recall.js: exact hits claim their slots first,
  // associative channels only fill the remainder, superseded facts stay out of force,
  // and every returned fact carries a receipt. This wrapper only adds the cache and the
  // access-count bump, because those are agent-side concerns.
  const result = await recall({ store, query: q, limit, category, minTrust, embedder, hrrIndex });
  const results = result.facts;

  // Recall = review: async bump accessCount (beta=2: only first 2 hits)
  for (const f of results) {
    if (typeof store.bumpAccessCount === "function") {
      store.bumpAccessCount(String(f.id)).catch(() => { /* best effort */ });
    }
  }

  // Attach the retrieval verdict so callers can render status and receipts without a
  // second round-trip.
  results.status = result.status;
  results.receipt = result.receipt;
  results.directCount = result.directCount;
  if (result.relaxed) results.relaxed = true;

  // Write cache
  _recallCache.set(cacheKey, { time: Date.now(), results });
  // Evict old entries
  if (_recallCache.size > 100) {
    const oldest = _recallCache.keys().next().value;
    _recallCache.delete(oldest);
  }

  return results;
}

/* ------------------------------------------------------------------- factory */

/**
 * Mount the agent-facing surface.
 *
 * @param {object} deps
 * @param {object} deps.ctx          the plugin context (already injected)
 * @param {object} deps.cfg          resolved memory config
 * @param {object} deps.logger
 * @param {() => object|null} deps.getStore  late-bound; the store opens asynchronously
 * @param {() => object|null} deps.getMd     late-bound markdown module
 * @param {() => object|null} deps.getHrrIndex  late-bound shared HRR index from index.js
 * @returns {{ dispose: () => void }}
 */
export function mountAgentInterface({ ctx, cfg, logger, getStore, getMd, getEmbedder, getReflector, getHrrIndex }) {
  const log = logger ?? {};
  const names = toolNames();
  const disposers = [];

  // 常驻 HRR index：由 index.js 预构建并共享（同一实例同时供 memory_search 与
  // 自动 recall 使用，保证排序一致）。index.js 加载失败时为 null，各调用方按
  // "HRR 可选" 降级，不影响关键词与 embedding 通道。
  const hrrIndex = typeof getHrrIndex === "function" ? getHrrIndex() : null;

  const warn = (message) => {
    try {
      log.warn?.(`[dsh-memory] ${message}`);
    } catch {
      /* logging must never break a tool call */
    }
  };

  /** Tool bodies run outside the route/config error handling, so guard each access. */
  const requireStore = () => {
    const store = getStore();
    if (!store) throw new Error("memory store is unavailable (see the 记忆 panel's self-check)");
    return store;
  };

  /* --------------------------------------------------- built-in markdown mirror */
  // The plugin keeps TWO stores, and they answer different questions:
  //
  //   MEMORY.md / USER.md  — small, hand-readable, always injected into the system prompt,
  //                          and the only thing the 内置记忆 panel shows.
  //   memory_store.db      — the large searchable index (keyword + holographic recall).
  //
  // A fact the user asked to remember belongs in both. Writing only to the index is why the
  // panel could show "0 条目" right after a successful memory_record.
  const USER_PROFILE_CATEGORY = /偏好|用户|习惯|身份|画像|persona|preference|user|identity|profile/i;

  /** Which markdown file a category belongs to. */
  const builtinKeyFor = (category) => (USER_PROFILE_CATEGORY.test(String(category ?? "").trim()) ? "user" : "agent");

  const describeBuiltin = (file, extra) => ({
    file: String(file?.fileName ?? ""),
    key: String(file?.key ?? ""),
    entries: Number(Array.isArray(file?.entries) ? file.entries.length : 0),
    chars: Number(file?.chars ?? 0),
    budget: Number(file?.budget ?? 0),
    percent: Number(file?.percent ?? 0),
    overBudget: Boolean(file?.overBudget),
    ...extra,
  });

  /**
   * Mirror a fact into MEMORY.md or USER.md, skipping an exact duplicate.
   *
   * When the write pushes the file OVER its budget, related entries are MERGED instead of
   * left to rot (lib/merge.js). Without this the file grows forever: the panel shows it far
   * over budget, only the newest entries are ever injected, and old preferences still sit in
   * the file looking authoritative while being invisible.
   *
   * Never throws: the fact is already in the index, so a markdown failure downgrades to a
   * warning and the tool still reports success.
   */
  const mirrorToBuiltin = async (content, category) => {
    const md = getMd();
    if (!md || typeof md.addMemoryEntry !== "function" || typeof md.readMemoryFile !== "function") return null;
    const key = builtinKeyFor(category);
    try {
      const before = await md.readMemoryFile(cfg, key);
      const already = (before?.entries ?? []).some((e) => String(e?.text ?? "").trim() === content);
      if (already) return describeBuiltin(before, { written: false, duplicate: true });

      let after = await md.addMemoryEntry(cfg, key, content);

      // Over budget after the append: merge same-subject entries to get back under it.
      if (after?.overBudget && typeof md.writeMemoryEntries === "function") {
        try {
          const { compactEntries } = await import("./merge.js");
          const texts = (after.entries ?? []).map((e) => String(e?.text ?? ""));
          const result = compactEntries(texts, { budget: after.budget });
          if (result.merged > 0) {
            after = await md.writeMemoryEntries(cfg, key, result.entries);
            if (result.merged > 0) {
              log.info?.(`[dsh-memory] merged ${result.merged} entr(ies) in ${after.fileName} to fit its budget (${result.before}→${result.after} chars)`);
            }
            if (result.needsMore && after?.overBudget) {
              warn(`${after.fileName} is still over budget after merging (${after.chars}/${after.budget}); consider forgetting something`);
            }
          }
        } catch (mergeError) {
          warn(`could not merge ${key} entries: ${mergeError?.message ?? mergeError}`);
        }
      } else if (after?.overBudget) {
        warn(`${after.fileName} is over its ${after.budget}-character budget (${after.chars}); the fact is still indexed`);
      }

      return describeBuiltin(after, { written: true, duplicate: false });
    } catch (error) {
      warn(`could not mirror into ${key === "user" ? "USER.md" : "MEMORY.md"}: ${error?.message ?? error}`);
      return null;
    }
  };

  /** Drop the markdown lines that mirrored a forgotten fact. Returns how many were removed. */
  const unmirrorFromBuiltin = async (content) => {
    const md = getMd();
    if (!md || typeof md.writeMemoryEntries !== "function" || typeof md.readMemoryFile !== "function") return 0;
    const wanted = String(content ?? "").trim();
    if (!wanted) return 0;
    let removed = 0;
    for (const key of ["agent", "user"]) {
      try {
        const file = await md.readMemoryFile(cfg, key);
        const texts = (file?.entries ?? []).map((e) => String(e?.text ?? ""));
        const keep = texts.filter((t) => t.trim() !== wanted);
        if (keep.length === texts.length) continue;
        await md.writeMemoryEntries(cfg, key, keep);
        removed += texts.length - keep.length;
      } catch (error) {
        // The other file may still hold the mirror; keep going.
        warn(`could not unmirror from ${key}: ${error?.message ?? error}`);
      }
    }
    return removed;
  };

  const recordTool = {
    name: names.record,
    description:
      "Store one durable fact in the user's local memory. Call this whenever the user says to remember " +
      "something, or states a durable preference/decision/environment fact. Write the content as a " +
      "standalone sentence that will still make sense in a future session.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The fact, as one self-contained sentence. No pronouns referring to this conversation.",
        },
        category: {
          type: "string",
          description: "Short kind label, e.g. 偏好 (preference), 环境 (environment), 决策 (decision), 流程 (process).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "A few short keywords for later retrieval.",
        },
        trust: {
          type: "number",
          description: "0..1 confidence. Use high (0.8-1) for what the user stated directly, lower for inference.",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
    output: recordOutput,
    async execute(args) {
      const content = String(args?.content ?? "").trim();
      if (!content) throw new Error("content must be a non-empty string");
      const store = requireStore();
      const before = await store.stats();

      // 停用词集合：字面粘连比较时剔除
      const STOP_WORDS = new Set(["今天", "这个", "那个", "就是", "然后", "其实", "真的", "很", "都", "也", "还", "在", "是", "了", "的", "我", "你", "他", "她", "它", "这", "那", "啊", "呢", "吧", "嘛", "哦", "嗯"]);
      const extractWords = (text) => String(text ?? "")
        .toLowerCase()
        .match(/[\u4e00-\u9fa5]{2,}|[a-z0-9]{3,}/g)
        ?.filter((w) => !STOP_WORDS.has(w)) ?? [];

      // ------------------------------------------------------------------
      // Near-duplicate detection.
      //
      // HISTORY / why this is written the way it is: the previous logic merged a new
      // fact into an existing one whenever they shared >= 2 content words, and then
      // returned early WITHOUT ever writing the new text to the store or to
      // MEMORY.md. Two unrelated facts about the same subsystem share words easily
      // ("DSH 插件源码在 …" vs "DSH 插件的 client.js 在 …"), so the second fact was
      // silently destroyed while memory_record still reported success.
      //
      // The rule now:
      //   1. a near-duplicate must be NEARLY identical (Jaccard >= 0.8 of content
      //      words, or embedding cosine >= 0.92), not merely related;
      //   2. the new content is ALWAYS written — merging only links and boosts, it
      //      never replaces or discards;
      //   3. the merge is reported back to the model (mergedInto + relatedTo) so it
      //      knows the fact was folded into an existing one.
      // ------------------------------------------------------------------
      const embedder = typeof getEmbedder === "function" ? getEmbedder() : null;
      const recentFacts = typeof store.listRecentFacts === "function"
        ? await store.listRecentFacts(60)
        : [];
      const recentIds = new Set(recentFacts.map((f) => String(f.id)));

      let nearDuplicate = null; // { fact, kind, score }

      // (a) literal: Jaccard similarity over content words.
      const newWords = new Set(extractWords(content));
      if (newWords.size > 0) {
        for (const f of recentFacts) {
          const existingWords = new Set(extractWords(f.content));
          if (existingWords.size === 0) continue;
          let shared = 0;
          for (const w of existingWords) if (newWords.has(w)) shared += 1;
          const union = newWords.size + existingWords.size - shared;
          const jaccard = union > 0 ? shared / union : 0;
          if (jaccard >= 0.8) {
            nearDuplicate = { fact: f, kind: "literal", score: Number(jaccard.toFixed(3)) };
            break;
          }
        }
      }

      // (b) semantic: only a very high cosine counts as "the same fact".
      if (!nearDuplicate && embedder && !embedder.isFailed() && recentFacts.length > 0) {
        try {
          const sims = await embedder.search(content, 5);
          for (const r of sims) {
            if (r.score < 0.92) break; // descending order: nothing below will qualify
            if (!recentIds.has(String(r.id))) continue;
            const existing = await store.getFact(r.id);
            if (existing) {
              nearDuplicate = { fact: existing, kind: "semantic", score: Number(r.score.toFixed(3)) };
              break;
            }
          }
        } catch { /* semantic check optional */ }
      }

      // Contradiction: an explicit correction of a closely related existing fact.
      let contradiction = null;
      if (embedder && !embedder.isFailed() && recentFacts.length > 0) {
        try {
          const CONTRADICTION_NEG = /(不是|不要|不用|取消|改回|换成|不再|别用|放弃|推翻|应该是|其实是)/;
          if (CONTRADICTION_NEG.test(content)) {
            const sims = await embedder.search(content, 3);
            for (const r of sims) {
              if (r.score < 0.8) break;
              if (!recentIds.has(String(r.id))) continue;
              if (nearDuplicate && String(nearDuplicate.fact.id) === String(r.id)) continue;
              const existing = await store.getFact(r.id);
              if (existing && !existing.permanent) {
                contradiction = { fact: existing, score: Number(r.score.toFixed(3)) };
                break;
              }
            }
          }
        } catch { /* contradiction optional */ }
      }

      // The new content is ALWAYS persisted; dedup never costs us data.
      const fact = await store.upsertFact({
        content,
        category: String(args?.category ?? "").trim() || "general",
        tags: Array.isArray(args?.tags) ? args.tags.map((t) => String(t).trim()).filter(Boolean) : [],
        trust: Number.isFinite(Number(args?.trust)) ? Math.max(0, Math.min(1, Number(args.trust))) : 0.8,
        source: "agent",
      });

      // Merge = link + reinforce, never replace.
      let mergedInto = null;
      if (nearDuplicate && fact?.id && String(nearDuplicate.fact.id) !== String(fact.id)) {
        mergedInto = String(nearDuplicate.fact.id);
        const boosted = Math.min(1, (nearDuplicate.fact.trust ?? 0.5) + 0.1);
        await store.setFactTrust(mergedInto, boosted).catch(() => {});
        if (typeof store.addEdge === "function") {
          await store.addEdge(mergedInto, String(fact.id), "related").catch(() => {});
        }
        log.info?.(`[dsh-memory] near-duplicate (${nearDuplicate.kind} ${nearDuplicate.score}): linked ${fact.id} -> ${mergedInto}`);
      }

      if (contradiction && fact?.id) {
        await store.markContradiction(String(contradiction.fact.id), String(fact.id)).catch(() => {});
        log.info?.(`[dsh-memory] contradiction: old id=${contradiction.fact.id} trust×0.3 (linked to new ${fact.id}, cosine=${contradiction.score})`);
      }

      const after = await store.stats();
      refreshFactCount();
      invalidateRecallCache();

      // Record event (情景记忆) + trigger reflection every 10 events
      try {
        if (typeof store.addEvent === "function") {
          await store.addEvent({
            sessionId: args?.sessionId || null,
            content,
            emotion: args?.emotion || "neutral",
            importance: Number(args?.importance) || 0.5,
            factId: fact?.id || null,
          });
          const evts = await store.listEvents({ limit: 100 });
          if (evts.length > 0 && evts.length % 10 === 0) {
            const reflector = typeof getReflector === "function" ? getReflector() : null;
            if (reflector && !reflector.isFailed()) {
              const existing = (await store.listRecentFacts(20)).map(f => f.content);
              reflector.reflect(evts.slice(-20), existing).then((suggestions) => {
                for (const s of suggestions) {
                  if (s && s.content) {
                    store.upsertFact({
                      content: s.content,
                      category: s.category || "general",
                      trust: s.trust || 0.5,
                      source: "reflection",
                    }).catch(() => {});
                  }
                }
                if (suggestions.length) log.info?.(`[dsh-memory] reflection: extracted ${suggestions.length} facts`);
              }).catch(() => {});
            }
          }
        }
      } catch { /* event optional */ }

      // 增量更新常驻 HRR index
      if (hrrIndex && fact?.id) {
        hrrIndex.add(String(fact.id), `${fact.content ?? ""} ${(fact.tags ?? []).join(" ")} ${fact.category ?? ""}`);
      }

      // Async: compute embedding and notify worker (non-blocking).
      // Always embed the NEW fact — a near-duplicate is a separate stored fact now, so
      // skipping its vector would make it invisible to the semantic channel.
      if (embedder && fact?.id) {
        embedder.embed(content).then((vec) => {
          if (!vec) return;
          store.updateEmbedding(fact.id, vec, embedder.MODEL_NAME).then(() => {
            embedder.upsertNotify(fact.id, vec);
          }).catch(() => { /* best effort */ });
        }).catch(() => { /* best effort */ });
      }

      // Also write the human-readable copy the 内置记忆 panel reads and the model always sees.
      // The new content is mirrored even when it was linked to a near-duplicate: the whole
      // point of the dedup fix is that a near-duplicate never loses text.
      const builtin = await mirrorToBuiltin(content, String(fact?.category ?? "general"));
      return {
        id: String(fact?.id ?? ""),
        content,
        category: String(fact?.category ?? "general"),
        created: after.facts > before.facts,
        ...(mergedInto ? { mergedInto, mergedReason: nearDuplicate?.kind, mergedScore: nearDuplicate?.score } : {}),
        ...(contradiction ? { contradicts: String(contradiction.fact.id) } : {}),
        total: after.facts,
        ...(builtin ? { builtin } : {}),
      };
    },
  };

  const searchTool = {
    name: names.search,
    description:
      "Search the user's local memory. Use this before assuming you do not know a preference, decision or " +
      "machine fact — the store may hold it from an earlier session. Supports Chinese: matching is keyword " +
      "plus holographic vector similarity, so different wording still finds it.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, in natural language." },
        limit: { type: "number", description: "How many facts to return (default 8)." },
        category: { type: "string", description: "Optional exact category filter." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: searchOutput,
    async execute(args) {
      const query = String(args?.query ?? "").trim();
      if (!query) throw new Error("query must be a non-empty string");
      const store = requireStore();
      const limit = Number.isFinite(Number(args?.limit)) ? Math.max(1, Math.min(50, Number(args.limit))) : 8;

      const facts = await retrieveFacts(ctx, store, query, {
        limit,
        category: String(args?.category ?? "").trim(),
        minTrust: 0,
        embedder: typeof getEmbedder === "function" ? getEmbedder() : null,
        hrrIndex,
      });

      return {
        query,
        count: facts.length,
        facts: facts.map((f) => ({
          id: String(f.id),
          content: String(f.content ?? ""),
          category: String(f.category ?? "general"),
          trust: Number(f.trust ?? 0),
          score: Number(f.score ?? 0),
          match: String(f.match ?? "keyword"),
        })),
      };
    },
  };

  const listTool = {
    name: names.list,
    description: "List what is currently stored in the user's local memory, with counts by category.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many facts to show (default 20)." },
        category: { type: "string", description: "Optional exact category filter." },
      },
      additionalProperties: false,
    },
    output: listOutput,
    async execute(args) {
      const store = requireStore();
      const limit = Number.isFinite(Number(args?.limit)) ? Math.max(1, Math.min(100, Number(args.limit))) : 20;
      const stats = await store.stats();
      const res = await store.queryFacts({
        q: "",
        category: String(args?.category ?? "").trim(),
        limit,
        minTrust: 0,
      });
      return {
        total: Number(stats?.facts ?? 0),
        categories: Array.isArray(stats?.categories) ? stats.categories.map((c) => String(c?.name ?? "")).filter(Boolean) : [],
        facts: (Array.isArray(res?.facts) ? res.facts : []).map((f) => ({
          id: String(f.id),
          content: String(f.content ?? ""),
          category: String(f.category ?? "general"),
          trust: Number(f.trust ?? 0),
        })),
      };
    },
  };

  const forgetTool = {
    name: names.forget,
    description: "Delete one fact from memory by id, or delete the single best match for a query. Only when the user asks to forget something.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Exact fact id (from memory_search / memory_list)." },
        query: { type: "string", description: "Alternatively: a query whose single best match should be deleted." },
      },
      additionalProperties: false,
    },
    output: forgetOutput,
    async execute(args) {
      const store = requireStore();
      let id = String(args?.id ?? "").trim();
      if (!id) {
        const query = String(args?.query ?? "").trim();
        if (!query) throw new Error("either id or query is required");
        const res = await store.queryFacts({ q: query, limit: 1, minTrust: 0 });
        const hit = (Array.isArray(res?.facts) ? res.facts : [])[0];
        if (!hit) return { removed: false, total: (await store.stats())?.facts ?? 0 };
        id = String(hit.id);
      }
      // Read the content BEFORE deleting so the markdown mirror can be cleared too.
      let mirroredContent = "";
      try {
        const fact = typeof store.getFact === "function" ? await store.getFact(id) : null;
        if (fact && fact.content) mirroredContent = String(fact.content);
      } catch { /* fall through: only the index will be cleaned */ }

      const removed = await store.deleteFact(id);
      refreshFactCount();
      invalidateRecallCache();

      // 从常驻 HRR index 删除
      if (hrrIndex && removed) hrrIndex.remove(id);

      // Notify worker to drop the vector
      const embedder = typeof getEmbedder === "function" ? getEmbedder() : null;
      if (embedder && removed) embedder.deleteNotify(id);

      let builtinRemoved = 0;
      if (removed && mirroredContent) {
        try { builtinRemoved = await unmirrorFromBuiltin(mirroredContent); } catch { /* index delete already succeeded */ }
      }
      return {
        id,
        removed: Boolean(removed),
        total: Number((await store.stats())?.facts ?? 0),
        ...(builtinRemoved ? { builtinRemoved } : {}),
      };
    },
  };

  /* ------------------------------------------------------------ registration */

  // The instruction section's `text` function is called SYNCHRONOUSLY by the host's
  // system-prompt assembler (it does not await the return value), so we cannot read the
  // store (async) inside it. Instead we keep a cached fact count, refreshed on bootstrap
  // and after every write, and return that from the section's sync text function.
  let cachedFactCount = 0;
  const refreshFactCount = async () => {
    try {
      const s = getStore();
      if (s) cachedFactCount = Number((await s.stats())?.facts) || 0;
    } catch { /* keep last known count */ }
  };
  refreshFactCount();

  const tools = [recordTool, searchTool, listTool, forgetTool];
  for (const tool of tools) {
    try {
      const dispose = ctx.tools.register(tool);
      if (typeof dispose === "function") disposers.push(dispose);
    } catch (error) {
      // A tool that cannot register must not take the panel down with it.
      warn(`tool ${tool.name} failed to register: ${error?.message ?? error}`);
    }
  }

  // The instruction section: tells the model the tools exist and when to call them.
  try {
    if (ctx.systemPrompt && typeof ctx.systemPrompt.section === "function") {
      const order = typeof ctx.systemPrompt.getSectionOrder === "function"
        ? ctx.systemPrompt.getSectionOrder("TOOL_SESSION_QUERY")
        : 2300;
      const dispose = ctx.systemPrompt.section({
        name: "tool:dsh-memory",
        order: Number.isFinite(order) ? order + 5 : 2305,
        text: () => {
          // Sync return only — the assembler does not await this. cachedFactCount is kept
          // warm by refreshFactCount() below.
          try {
            return instructionsText({ facts: cachedFactCount, name: cfg?.assistantName });
          } catch {
            return instructionsText({ facts: cachedFactCount });
          }
        },
      });
      if (typeof dispose === "function") disposers.push(dispose);
    }
  } catch (error) {
    warn(`instruction section failed: ${error?.message ?? error}`);
  }

  return {
    dispose() {
      for (const d of disposers) {
        try {
          if (typeof d === "function") d();
        } catch {
          /* already gone */
        }
      }
    },
    /**
     * Exposed for the panel's delete action: removing a fact from the index must also remove
     * the human-readable copy, or USER.md keeps asserting something the store no longer holds.
     */
    unmirror(content) {
      return unmirrorFromBuiltin(content);
    },
  };
}

/* -------------------------------------------------------- automatic recall */

/**
 * Build the per-step memory injection.
 *
 * Two things are appended to the turn's messages on every step:
 *   - the USER.md / MEMORY.md profile (the durable, hand-curated part), and
 *   - the top few facts most relevant to what the user just said.
 *
 * This is the difference between "a memory store exists" and "the assistant remembers".
 * Registered with `{ prepend: true }` so it runs after every other contributor has had its
 * say and appends last, matching the reference implementation's ordering discipline.
 *
 * @returns {() => void} disposer
 */
export function mountRecall({ ctx, cfg, logger, getStore, getMd, getEmbedder, getHrrIndex }) {
  const log = logger ?? {};
  const warn = (m) => { try { log.warn?.(`[dsh-memory] ${m}`); } catch { /* ignore */ } };
  // The persistent HRR index lives in index.js and is shared with the agent tools so
  // recall ranks identically to what memory_search returns. Late-bound: it may still be
  // null during the async bootstrap.
  const hrrIndex = typeof getHrrIndex === "function" ? getHrrIndex() : null;

  // 本会话已注入过的 fact id：只用于防止同一事实每轮重复出现，不用于「只注入一次」。
  // 召回本身每轮都跑，所以会话后半段换了话题也能取回不同的事实。
  const injectedFactIds = new Set();
  // 本会话已自动捕获的内容（小写）：避免逐轮重复扫描同一句。
  const capturedContents = new Set();
  // 本会话已记录的失败签名（工具+错误类型+首行）：同一堵墙只记一次。
  const capturedFailures = new Set();
  // 本会话已记录的情绪（情绪+内容前缀）：一段持续的烦躁不该写二十条事件。
  const capturedMoods = new Set();
  // 本会话已记录的流程签名：同一套步骤不重复沉淀。
  const capturedRecipes = new Set();
  // 档案（USER.md/MEMORY.md）是否已在本会话注入过：只在首轮注入，避免每轮重复。
  let profileInjected = false;
  let currentSessionId = null;

  // The host's system-prompt assembler calls a context's `text` function SYNCHRONOUSLY and
  // does NOT await it (see dsh-system-prompt resolveContext). Returning a Promise here makes
  // `renderContextSections` call `text.indexOf("{{")` on a Promise and crash every turn with
  // "text.indexOf is not a function". So we keep the profile in a cache, refreshed asynchronously
  // on mount and on every pre-step, and return the cache from the sync text function.
  let cachedProfile = "";

  const readProfileText = async () => {
    const md = getMd();
    if (!md?.readMemoryFile) return "";
    const parts = [];
    for (const key of ["user", "agent"]) {
      try {
        const file = await md.readMemoryFile(cfg, key);
        if (!file?.exists) continue;
        const entries = Array.isArray(file.entries) ? file.entries : [];
        if (entries.length === 0) continue;

        // Budget selection is topic-aware (lib/compact.js). The previous code took the
        // newest entries that fit and `break`-ed, which silently hid every older entry —
        // so a user's earliest preferences vanished from the prompt while still showing
        // in the panel. Now every topic keeps at least one entry, and whatever is left
        // out is stated in one line instead of disappearing.
        const budget = key === "user" ? cfg.userBudget : cfg.agentBudget;
        const texts = entries.map((e) => (typeof e === "string" ? e : e?.text ?? ""));
        const selection = selectWithinBudget(texts, { budget });
        if (selection.kept.length === 0) continue;

        const label = key === "user" ? "What you know about the user" : "Long-term notes";
        const body = selection.kept.map((e) => "- " + e).join("\n");
        const omission = describeOmission(selection);
        parts.push(`${label}:\n${body}${omission ? "\n" + omission : ""}`);
      } catch (error) {
        warn(`profile read failed (${key}): ${error?.message ?? error}`);
      }
    }
    return parts.join("\n\n");
  };

  const lastUserText = (messages) => {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      const role = m?.role ?? m?.type;
      if (role !== "user") continue;
      const content = m.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const text = content.filter((c) => c && c.type === "text").map((c) => c.text).join(" ");
        if (text) return text;
      }
    }
    return "";
  };

  const relevantFacts = async (messages) => {
    const store = getStore();
    if (!store) return [];
    const query = lastUserText(messages).trim();
    if (!query || query.length < 2) return [];
    try {
      return await retrieveFacts(ctx, store, clip(query, 600), {
        limit: 6,
        minTrust: 0,
        embedder: typeof getEmbedder === "function" ? getEmbedder() : null,
        hrrIndex,
      });
    } catch (error) {
      warn(`recall query failed: ${error?.message ?? error}`);
      return [];
    }
  };

  /**
   * Render the injected memory block.
   *
   * Two deliberate choices make this read like something a person remembers rather
   * than a database dump:
   *
   *  - every fact carries how long ago it was learned ("3 天前"), because recency is
   *    part of what a memory MEANS; and
   *  - the wording is hedged by trust ("我记得" / "大概记得" / "隐约记得"), so the
   *    model does not recite an uncertain memory as established fact.
   *
   * The profile (USER.md / MEMORY.md) is emitted only on the first turn of a session:
   * it changes slowly, and repeating 3.5k characters of it every turn would bury the
   * conversation. Facts are incremental — a fact already injected this session is not
   * repeated, but a NEW relevant fact can still arrive later in the conversation.
   */
  const renderMemoryBlock = (profile, facts, seenIds, includeProfile, mood = "", followup = "") => {
    const sections = [];
    if (includeProfile && profile) sections.push(profile);
    if (followup) sections.push(followup);
    if (mood) sections.push(mood);
    if (facts.length > 0) {
      const lines = [];
      let chars = 0;
      for (const f of facts) {
        const id = String(f.id ?? "");
        if (id && seenIds.has(id)) continue;
        const tone = trustTone(f.trust ?? 0.5);
        const age = f.age ?? relativeAge(f.createdAt);
        const category = f.category && f.category !== "general" ? `（${f.category}）` : "";
        // The retrieval channel is part of the receipt: an exact hit and a fuzzy vector
        // hit are NOT equally trustworthy, and the model should be able to tell.
        const via = f.match === "keyword" ? "" : f.match === "embedding" ? "［语义联想］" : f.match === "holographic" ? "［全息联想］" : "";
        const line = `- ${tone}，${age}${category}${via}：${f.content}`;
        if (chars + line.length > MEMORY_BLOCK_BUDGET && lines.length > 0) break;
        chars += line.length;
        lines.push(line);
        if (id) seenIds.add(id);
      }
      if (lines.length > 0) {
        // State the verdict BEFORE the facts so the model cannot miss it: "only related"
        // has to be read as "not necessarily the answer", not as an answer.
        const verdict = statusLine(facts.status ?? "direct", lines.length);
        sections.push(
          "以下是我记得的相关事情（供参考，不必复述，除非用户问起）：" +
          (verdict ? "\n" + verdict : "") +
          "\n" + lines.join("\n"),
        );
      }
    } else if (facts.status === "none" && facts.length === 0 && !includeProfile) {
      // Nothing to inject this turn — say nothing (a "I remembered nothing" line every
      // turn would be worse than silence). The status only matters alongside facts.
    }
    return sections.join("\n\n");
  };

  /**
   * A short "what was going on last time" line, built from the event stream.
   *
   * The events table already records emotion + importance on every memory_record, but
   * until now nothing ever read them back into the prompt — the assistant could recall
   * WHAT happened and not HOW the user was while it happened. That is the difference
   * between a database and someone who was there.
   *
   * Deliberately quiet: at most one line, only for the last few days, and only when the
   * event carries an actual feeling or high importance. A neutral, unimportant event
   * adds nothing a human would say out loud.
   */
  const moodLine = async () => {
    const store = getStore();
    if (!store?.listEvents) return "";
    try {
      const events = await store.listEvents({ limit: 12 });
      if (!Array.isArray(events) || events.length === 0) return "";

      const now = Date.now();
      const DAY = 24 * 60 * 60 * 1000;
      const recent = events.filter((e) => {
        const age = now - Number(e?.timestamp ?? 0);
        return age >= 0 && age <= 7 * DAY;
      });
      if (recent.length === 0) return "";

      // Prefer an event that actually says something about the person.
      const withFeeling = recent.find((e) => e?.emotion && e.emotion !== "neutral");
      const intense = recent.find((e) => Number(e?.importance ?? 0) >= 0.75);
      const pick = withFeeling ?? intense;
      if (!pick) return "";

      const EMOTION_WORD = {
        happy: "心情不错",
        satisfied: "挺满意",
        excited: "很兴奋",
        tired: "有点累",
        frustrated: "有点烦",
        angry: "不太高兴",
        sad: "情绪不高",
        anxious: "有点着急",
        confused: "有点困惑",
      };
      const feeling = String(pick.emotion);
      const phrase = EMOTION_WORD[feeling] ?? feeling;
      const summary = clip(pick.content, 60);
      // "上次" is intentionally vague: a person would not cite a timestamp either.
      return `上次聊到「${summary}」时你${phrase}。`;
    } catch {
      return "";
    }
  };

  /**
   * Keep the open-obligation queue and return the one line to inject, if any.
   *
   * The queue lives in `meta.followups` so it survives a restart without a schema change.
   * Only ONE obligation is raised per session, and only after it has been quiet for a while —
   * see lib/followup.js for why the signals must be explicit.
   */
  const FOLLOWUP_META_KEY = "followups";
  const raisedFollowupsThisSession = new Set();

  const trackFollowup = async ({ store, messages, logger, sessionId }) => {
    if (!store || typeof store.getMeta !== "function") return "";
    const { detectFollowup, createFollowupQueue, followupLine } = await import("./followup.js");

    const stored = (await store.getMeta(FOLLOWUP_META_KEY, [])) ?? [];
    const queue = createFollowupQueue(Array.isArray(stored) ? stored : []);
    const now = Date.now();

    // 1. Learn from the PREVIOUS turn (same unit of work as the other capture passes).
    const { previousUserText } = await import("./autocapture.js");
    const prev = previousUserText(Array.isArray(messages) ? messages : []);
    const detected = prev ? detectFollowup(prev) : null;
    if (detected) {
      const state = queue.apply(detected, { now, sessionId });
      if (state) {
        try { logger?.info?.(`[dsh-memory] follow-up ${detected.action}: ${state.topic ?? state.text}`); } catch { /* optional */ }
        await store.putMeta(FOLLOWUP_META_KEY, queue.all());
      }
      return ""; // don't both record and raise in the same turn
    }

    // 2. Raise at most one, once per session.
    queue.prune(now);
    const next = queue.take(now);
    if (!next) {
      await store.putMeta(FOLLOWUP_META_KEY, queue.all());
      return "";
    }
    if (raisedFollowupsThisSession.has(sessionId)) {
      await store.putMeta(FOLLOWUP_META_KEY, queue.all());
      return "";
    }
    raisedFollowupsThisSession.add(sessionId);
    await store.putMeta(FOLLOWUP_META_KEY, queue.all());
    return followupLine(next);
  };

  const message = (text) => ({
    // The session layer validates every persisted message strictly: it requires a non-empty
    // string `id` ("identified message"), `content` as an ARRAY of content blocks (a bare
    // string is rejected as "invalid content"), and `source.kind` as a non-empty string.
    // Getting any of these wrong corrupts the session jsonl — the next resume throws
    // "session event at seq N lacks an identified message" and the whole history fails to load.
    id: `msg_${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text: `[以下是我记得的事情，来自本地记忆，不是用户刚说的话]\n${text}` }],
    // We are NOT a runtime-context provider; any kind other than "runtime-context" makes the
    // agent loop append us verbatim instead of treating us as the project's runtime context.
    source: { kind: "dsh-memory", form: "injected" },
  });

  let dispose = null;
  try {
    dispose = ctx.on("agent/pre-step", async ({ agent, messages, signal, session }, next) => {
      const decision = await next();
      if (decision?.kind !== "enter" || signal?.aborted) return decision;

      // 检测 session 变化：换会话时清空「已注入 id」，让新会话重新拿到上下文。
      const sid = session?.id ?? messages?.[0]?.sessionId ?? "default";
      const isNewSession = sid !== currentSessionId;
      if (isNewSession) {
        currentSessionId = sid;
        injectedFactIds.clear();
        capturedContents.clear();
        capturedFailures.clear();
        capturedMoods.clear();
        capturedRecipes.clear();
        profileInjected = false;
        cachedProfile = "";
      }

      const [profile, facts] = await Promise.all([
        readProfileText().catch(() => ""),
        relevantFacts(decision.messages ?? messages).catch(() => []),
      ]);

      // Proactive capture: the turn that just finished is scanned for durable facts
      // the model chose not to record. Fire-and-forget so it never delays the turn,
      // and only the previous turn is scanned (see lib/autocapture.js).
      try {
        captureTurn({
          store: getStore(),
          messages: decision.messages ?? messages,
          logger,
          sessionId: sid,
          skip: capturedContents,
        }).then((written) => {
          for (const w of written) capturedContents.add(String(w.content).toLowerCase());
        }).catch(() => { /* capture is best effort */ });
      } catch { /* capture is best effort */ }
      // Same pass, different signal: tool results the runtime marked as failed become
      // "don't do that again" lessons (lib/failure.js). Only `isError === true` counts —
      // aborting and text-matching are both excluded, for the reasons documented there.
      try {
        captureFailures({
          store: getStore(),
          messages: decision.messages ?? messages,
          logger,
          skip: capturedFailures,
        }).then((written) => {
          if (written.length > 0) invalidateRecallCache();
        }).catch(() => { /* capture is best effort */ });
      } catch { /* capture is best effort */ }
      // And how the user sounded, so the next session can open with "上次你有点烦"
      // instead of pretending the conversation was purely technical (lib/mood.js).
      try {
        recordMood({
          store: getStore(),
          messages: decision.messages ?? messages,
          logger,
          sessionId: sid,
          skip: capturedMoods,
        }).catch(() => { /* mood is best effort */ });
      } catch { /* mood is best effort */ }
      // Finally, the positive side: a turn that ran several tool calls without a single
      // failure, and produced concrete specifics, is a procedure worth repeating
      // (lib/recipe.js). The store learned from walls; this learns from what worked.
      try {
        captureRecipe({
          store: getStore(),
          messages: decision.messages ?? messages,
          logger,
          skip: capturedRecipes,
        }).then((written) => {
          if (written) invalidateRecallCache();
        }).catch(() => { /* recipe is best effort */ });
      } catch { /* recipe is best effort */ }
      // And whether something was left UNFINISHED (lib/followup.js). This is the one thing
      // here that looks at the future instead of the past: "上次那个还没收尾，接着弄吗".
      let followup = "";
      try {
        followup = await trackFollowup({ store: getStore(), messages: decision.messages ?? messages, logger, sessionId: sid });
      } catch { /* follow-up is best effort */ }
      // 每轮都召回、每轮都可能注入。已注入过的 fact 只是不再重复，而不是「本会话不再注入」。
      // 档案只在会话第一轮注入：它变化很慢，每轮重复 3.5k 字符会把对话埋掉。
      const firstTurn = isNewSession || !profileInjected;
      // Mood is only meaningful at the start of a conversation ("上次你有点烦"),
      // so it rides along with the profile on the first turn rather than every turn.
      const mood = firstTurn ? await moodLine().catch(() => "") : "";
      const block = renderMemoryBlock(profile, Array.isArray(facts) ? facts : [], injectedFactIds, firstTurn, mood, followup);      if (firstTurn && profile) profileInjected = true;
      // cachedProfile 始终跟上最新档案（systemPrompt.context 同步读取它）。
      cachedProfile = profile || cachedProfile;
      if (!block) return decision;

      // 消息内注入同样受硬预算约束，避免长会话把上下文吃掉。
      const budgeted = block.length > MEMORY_MESSAGE_BUDGET
        ? block.slice(0, MEMORY_MESSAGE_BUDGET) + "\n…（其余记忆未列出）"
        : block;
      return { ...decision, messages: [...decision.messages, message(budgeted)] };
    }, { prepend: true });
  } catch (error) {
    warn(`recall hook failed: ${error?.message ?? error}`);
  }

  // The section variant is a fallback for surfaces where message injection is filtered out.
  try {
    if (ctx.systemPrompt && typeof ctx.systemPrompt.context === "function") {
      const order = typeof ctx.systemPrompt.getContextOrder === "function"
        ? ctx.systemPrompt.getContextOrder("WEB_SURFACE")
        : 210;
      // Warm the cache asynchronously so the very first turn already has something to show.
      readProfileText().then((t) => { cachedProfile = t; }).catch(() => { /* empty */ });
      const d = ctx.systemPrompt.context({
        name: "dsh-memory:profile",
        order: Number.isFinite(order) ? order + 5 : 215,
        text: () => cachedProfile,
      });
      // Keep BOTH disposers: the pre-step hook and the context section must each be
      // unwound, otherwise a plugin reload leaves a stale listener writing into a dead
      // cache. (The previous `dispose ?? d` leaked the context registration.)
      const sectionDispose = typeof d === "function" ? d : null;
      if (sectionDispose) {
        const prevDispose = dispose;
        dispose = () => {
          try { if (typeof prevDispose === "function") prevDispose(); } catch { /* gone */ }
          try { sectionDispose(); } catch { /* gone */ }
        };
      }
    }
  } catch (error) {
    warn(`profile context section failed: ${error?.message ?? error}`);
  }

  return () => {
    try {
      if (typeof dispose === "function") dispose();
    } catch {
      /* already gone */
    }
  };
}
