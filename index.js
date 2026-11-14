/**
 * Host half of dsh-memory.
 *
 * Owns the HTTP surface the 记忆 page talks to, and wires the two data layers
 * together: `lib/md.js` (MEMORY.md / USER.md) and `lib/store.js` (the
 * holographic fact store). Both are loaded lazily and defensively - a broken
 * data layer costs us one route, not the plugin.
 *
 * Route registration is synchronous (inside `ctx.effect`) so cordis can tear the
 * plugin down cleanly; the data layer is awaited inside each handler instead.
 */
import { PROVIDER_ID, createApi, createSessionSearch } from "./lib/api.js";
import { resolveMemoryConfig } from "./lib/config.js";
import { mountAgentInterface, mountRecall, invalidateRecallCache } from "./lib/agent.js";
import { createEmbedder } from "./lib/embed.js";
import { createReflector } from "./lib/reflection.js";
import path from "node:path";
import os from "node:os";

export const name = "dsh-memory";
// `webServer` serves the panel; `tools` registers the memory tools the model can call;
// `systemPrompt` places the instructions section and the profile context. All three are
// required for memory to actually work rather than merely be displayed.
export const inject = ["webServer", "tools", "systemPrompt"];

/** Loopback-or-paired access fence, same shape as the dsh-web plugin family. */
function isAllowed(request) {
  const host = request.headers?.host ?? "";
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(hostUrl.hostname)) return false;
  if (request.headers?.["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers?.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

const MAX_BODY = 2 * 1024 * 1024;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console;
  const cfg = resolveMemoryConfig(config);
  const sessions = createSessionSearch({ cfg, logger });

  const state = { md: null, store: null, hrr: null, hrrIndex: null, errors: [], ready: null, agent: null, recall: null, embedder: null, reflector: null };
  // Daily archival timer; cleared on teardown so a plugin reload does not leak it.
  let archiveTimer = null;
  // Daily consolidation timer; same lifecycle.
  let consolidateTimer = null;
  // Why the embedder was not started (null = it was started). Read by selfcheck so an
  // intentional opt-out is distinguished from a startup failure.
  let embedSkipReason = null;

  async function bootstrap() {
    try {
      state.hrr = await import("./lib/hrr.js");
      // Share the holographic layer with the agent tool so search ranks identically to the panel.
      try { ctx.provide?.("memoryHolographic", state.hrr); } catch { /* optional */ }
      // One resident HRR index, built once and shared by memory_search AND automatic
      // recall. Both consumers see the same vectors, so tool output and prompt injection
      // can never disagree about ranking.
      state.hrrIndex = state.hrr.createIndex({ dim: state.hrr.DEFAULT_DIM });
      // Seed the index from the store in the background (store opens a few lines below).
      const storeRef = state;
      (async () => {
        for (let i = 0; i < 60; i += 1) {
          const s = storeRef.store;
          if (s && storeRef.hrrIndex) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        const s = storeRef.store;
        const idx = storeRef.hrrIndex;
        if (!s || !idx) return;
        try {
          const res = await s.queryFacts({ q: "", limit: 2000 });
          const items = (res?.facts ?? []).map((f) => ({
            id: String(f.id),
            text: `${f.content ?? ""} ${(f.tags ?? []).join(" ")} ${f.category ?? ""}`,
          }));
          idx.rebuild(items);
          logger.info?.(`[dsh-memory] HRR index rebuilt: ${items.length} facts`);
        } catch { /* best effort; incremental add() still works for new facts */ }
      })();
    } catch (error) {
      state.errors.push(`lib/hrr.js: ${error?.message ?? error}`);
      logger.warn?.(`[dsh-memory] holographic layer unavailable: ${error?.message ?? error}`);
    }
    try {
      state.md = await import("./lib/md.js");
    } catch (error) {
      state.errors.push(`lib/md.js: ${error?.message ?? error}`);
      logger.warn?.(`[dsh-memory] markdown layer unavailable: ${error?.message ?? error}`);
    }
    try {
      const { openStore } = await import("./lib/store.js");
      const store = await openStore(cfg, { logger });
      await store.init();
      state.store = store;
    } catch (error) {
      state.errors.push(`lib/store.js: ${error?.message ?? error}`);
      logger.warn?.(`[dsh-memory] fact store unavailable: ${error?.message ?? error}`);
    }

    // Embedding worker (optional, degrades to HRR-only on failure).
    //
    // THREE gates before spawning a Worker thread:
    //   1. a store must exist,
    //   2. the JSON backend must not be in use (it has no embedding columns),
    //   3. there must be enough RAM — see lib/budget.js. Loading the ONNX model on a busy
    //      16 GB machine once exhausted physical memory hard enough that PowerShell could
    //      not start. An optional ranking improvement must never be able to do that.
    const skipReason = !state.store
      ? "no store"
      : cfg.backend !== "sqlite"
        ? "json backend"
        : process.env.DSH_MEMORY_NO_EMBED === "1"
          ? "DSH_MEMORY_NO_EMBED=1"
          : null;

    let budgetVerdict = null;
    if (!skipReason) {
      try {
        const { canLoadEmbedder, describeBudget } = await import("./lib/budget.js");
        budgetVerdict = canLoadEmbedder();
        if (!budgetVerdict.allowed) {
          embedSkipReason = budgetVerdict.reason;
          logger.warn?.(`[dsh-memory] embedder not loaded — ${describeBudget(budgetVerdict)}; using keyword + HRR`);
        }
      } catch { /* budget check optional; proceed as before */ }
    }

    const finalSkip = skipReason ?? (budgetVerdict && !budgetVerdict.allowed ? budgetVerdict.reason : null);
    embedSkipReason = finalSkip;

    if (finalSkip) {
      logger.info?.(`[dsh-memory] embedder skipped (${finalSkip}); HRR-only`);
    } else {
      try {
        const cacheDir = path.join(os.homedir(), ".dsh", "memory-models");
        state.embedder = createEmbedder({
          dbPath: cfg.storePath,
          cacheDir,
          hfMirror: "https://hf-mirror.com",
          logger,
        });
        // Background: load vectors from SQLite into worker
        state.embedder.loadVectors().catch(() => { /* will retry on first search */ });

        // Background: backfill missing embeddings
        (async () => {
          // 等模型加载
          for (let i = 0; i < 30; i++) {
            if (state.embedder.isReady()) break;
            await new Promise((r) => setTimeout(r, 1000));
          }
          if (!state.embedder.isReady()) return;
          try {
            const missing = await state.store.listFactsNeedingEmbedding(state.embedder.MODEL_NAME);
            logger.info?.(`[dsh-memory] backfilling embeddings: ${missing.length} facts`);
            for (const f of missing) {
              if (!state.embedder || state.embedder.isFailed()) break;
              const vec = await state.embedder.embedLowPriority(f.content);
              if (vec) {
                await state.store.updateEmbedding(f.id, vec, state.embedder.MODEL_NAME);
                state.embedder.upsertNotify(f.id, vec);
              }
              await new Promise((r) => setTimeout(r, 50)); // 限速
            }
            logger.info?.("[dsh-memory] embedding backfill done");
          } catch (error) {
            logger.warn?.(`[dsh-memory] backfill failed: ${error?.message ?? error}`);
          }
        })();
        logger.info?.("[dsh-memory] embedder worker started");
      } catch (error) {
        state.errors.push(`lib/embed.js: ${error?.message ?? error}`);
        logger.warn?.(`[dsh-memory] embedder unavailable, using HRR only: ${error?.message ?? error}`);
      }
    }

    // Cleanup stale session facts on boot
    try {
      const result = await state.store.cleanupStaleFacts();
      if (result.deleted > 0) logger.info?.(`[dsh-memory] cleaned up ${result.deleted} stale facts`);
    } catch { /* cleanup optional */ }

    // Archival, wired at last: old AND never-recalled AND low-trust facts are retired
    // from retrieval (rows are kept, so exports and audits still see them). Runs once
    // on boot and then daily. It deliberately does NOT depend on age alone — see
    // lib/decay.js.
    try {
      if (state.store && typeof state.store.archiveOldFacts === "function") {
        const runArchive = async () => {
          try {
            const res = await state.store.archiveOldFacts();
            if (res.archived > 0) {
              logger.info?.(`[dsh-memory] archived ${res.archived} stale fact(s) of ${res.total}`);
              invalidateRecallCache();
            }
          } catch { /* archival is optional */ }
        };
        await runArchive();
        const timer = setInterval(runArchive, 24 * 60 * 60 * 1000);
        timer.unref?.();
        archiveTimer = timer;
      }
    } catch { /* archival optional */ }

    // Consolidation: compress groups of related facts into one conclusion and retire the
    // sources (kept on disk, out of force). This is the difference between a store that
    // accumulates and one that grows — see lib/consolidate.js. Runs daily, never on boot
    // (a fresh process should not rewrite the user's memory before they have said anything).
    try {
      if (state.store && typeof state.store.setFactSuperseded === "function") {
        const runConsolidate = async () => {
          try {
            const all = await state.store.queryFacts({ q: "", limit: 5000 });
            const { consolidate } = await import("./lib/consolidate.js");
            const res = await consolidate({ store: state.store, facts: all?.facts ?? [], logger });
            if (res.consolidated > 0) {
              logger.info?.(`[dsh-memory] consolidation: ${res.consolidated} conclusion(s), ${res.retired} source(s) retired`);
              invalidateRecallCache();
            }
          } catch { /* consolidation is optional */ }
        };
        const timer = setInterval(runConsolidate, 24 * 60 * 60 * 1000);
        timer.unref?.();
        consolidateTimer = timer;
      }
    } catch { /* consolidation optional */ }

    // Reflection worker (Phase 3): lazy, started on first reflect() call.
    // Qwen2.5-1.5B-Instruct ~1GB, loaded on demand so plugin boot stays fast.
    try {
      state.reflector = createReflector({
        dbPath: cfg.storePath,
        cacheDir: cfg.modelCacheDir || path.join(os.homedir(), '.dsh', 'memory-models'),
        hfMirror: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
        logger,
      });
      logger.info?.("[dsh-memory] reflector ready (lazy start)");
    } catch (error) {
      logger.warn?.(`[dsh-memory] reflector unavailable: ${error?.message ?? error}`);
    }

    logger.info?.(`[dsh-memory] ready: home=${cfg.home} backend=${cfg.backend} version=${cfg.version}`);

    // Agent surface. Mounted after the data layer settles so the tools have a live store;
    // failures here are logged, never fatal — the panel must survive a broken tool.
    try {
      state.agent = mountAgentInterface({
        ctx,
        cfg,
        logger,
        getStore: () => state.store,
        getMd: () => state.md,
        getEmbedder: () => state.embedder,
        getReflector: () => state.reflector,
        getHrrIndex: () => state.hrrIndex,
      });
      logger.info?.("[dsh-memory] agent tools registered");
    } catch (error) {
      state.errors.push(`agent tools: ${error?.message ?? error}`);
      logger.warn?.(`[dsh-memory] agent tools failed: ${error?.message ?? error}`);
    }
    try {
      state.recall = mountRecall({ ctx, cfg, logger, getStore: () => state.store, getMd: () => state.md, getEmbedder: () => state.embedder, getHrrIndex: () => state.hrrIndex });
      logger.info?.("[dsh-memory] automatic recall mounted");
    } catch (error) {
      state.errors.push(`agent recall: ${error?.message ?? error}`);
      logger.warn?.(`[dsh-memory] recall failed: ${error?.message ?? error}`);
    }
    return state;
  }

  state.ready = bootstrap();

  // `state` doubles as the data-layer holder: api.js reads state.store / state.md
  // on every call, so passing the object itself (not a snapshot) is what makes
  // the lazy bootstrap visible to the handlers.
  const api = createApi({
    cfg,
    logger,
    sessions,
    get store() {
      return state.store;
    },
    get md() {
      return state.md;
    },
    get hrr() {
      return state.hrr;
    },
    getEmbedder: () => state.embedder,
  });

  /** Await the data layer, then hand the resolved pieces to the real handler. */
  async function withData(method) {
    await state.ready;
    return api[method];
  }

  const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  const writeJson = (res, status, body) => {
    res.writeHead(status, jsonHeaders);
    res.end(JSON.stringify(body));
  };
  const paramsOf = (req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    return Object.fromEntries(url.searchParams.entries());
  };

  const guard = (req, res, method) => {
    if (!isAllowed(req)) {
      writeJson(res, 403, { ok: false, error: "forbidden: loopback-only" });
      return false;
    }
    if (method && req.method !== method) {
      writeJson(res, 405, { ok: false, error: `method not allowed: use ${method}` });
      return false;
    }
    return true;
  };

  const routes = [
    {
      kind: "exact",
      path: "/api/dsh-memory/env",
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        const handler = await withData("env");
        writeJson(res, 200, await handler(paramsOf(req)));
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-memory/overview",
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        const handler = await withData("overview");
        writeJson(res, 200, await handler(paramsOf(req)));
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-memory/builtin",
      handler: async (req, res) => {
        await state.ready;
        if (req.method === "POST") {
          if (!guard(req, res, null)) return;
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            return writeJson(res, 400, { ok: false, error: String(error?.message ?? error) });
          }
          return writeJson(res, 200, await api.writeBuiltin(body));
        }
        if (!guard(req, res, "GET")) return;
        writeJson(res, 200, await api.builtin(paramsOf(req)));
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-memory/feedback",
      handler: async (req, res) => {
        await state.ready;
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "POST only" });
        if (!guard(req, res, null)) return;
        let body;
        try { body = await readBody(req); } catch (e) { return writeJson(res, 400, { ok: false, error: String(e?.message ?? e) }); }
        if (!body?.factId || typeof body.factId !== "string") {
          return writeJson(res, 400, { ok: false, error: "factId (string) is required" });
        }
        if (body.vote !== "up" && body.vote !== "down") {
          return writeJson(res, 400, { ok: false, error: "vote must be 'up' or 'down'" });
        }
        try {
          const result = await state.store.addFeedback(body.factId, body.vote, typeof body.query === "string" ? body.query : "");
          writeJson(res, 200, { ok: true, ...result });
        } catch (e) {
          writeJson(res, 500, { ok: false, error: String(e?.message ?? e) });
        }
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-memory/events",
      handler: async (req, res) => {
        await state.ready;
        if (!guard(req, res, "GET")) return;
        try {
          const limit = Math.min(Math.max(Number.parseInt(paramsOf(req).limit ?? "50", 10) || 50, 1), 200);
          const events = await state.store.listEvents({ limit });
          writeJson(res, 200, { ok: true, events });
        } catch (e) {
          writeJson(res, 500, { ok: false, error: String(e?.message ?? e) });
        }
      },
    },
    {
      // Editable panel — mutating routes.
      //
      // The panel used to be read-only: fixing a wrong memory or pinning a good one required
      // the model or curl. These three cover the actions a person actually wants when looking
      // at a fact: delete it, protect it from decay, or find out WHY it was recalled.
      kind: "exact",
      path: "/api/dsh-memory/edit",
      handler: async (req, res) => {
        await state.ready;
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "POST only" });
        if (!guard(req, res, null)) return;
        let body;
        try { body = await readBody(req); } catch (e) { return writeJson(res, 400, { ok: false, error: String(e?.message ?? e) }); }

        const id = typeof body?.id === "string" ? body.id.trim() : "";
        const action = typeof body?.action === "string" ? body.action : "";
        if (!id) return writeJson(res, 400, { ok: false, error: "id (string) is required" });
        if (!state.store) return writeJson(res, 503, { ok: false, error: "store unavailable" });

        try {
          switch (action) {
            case "delete": {
              const fact = await state.store.getFact(id);
              const removed = await state.store.deleteFact(id);
              // Keep the markdown mirror honest: a deleted fact must not linger in USER.md.
              if (removed && fact?.content && state.agent?.unmirror) {
                try { await state.agent.unmirror(fact.content); } catch { /* best effort */ }
              }
              invalidateRecallCache();
              return writeJson(res, 200, { ok: true, action, id, removed });
            }
            case "permanent": {
              const on = body?.value !== false;
              const fact = await state.store.setFactPermanent(id, on);
              if (!fact) return writeJson(res, 404, { ok: false, error: "fact not found" });
              invalidateRecallCache();
              return writeJson(res, 200, { ok: true, action, id, permanent: Boolean(fact.permanent), fact });
            }
            case "mute": {
              const on = body?.value !== false;
              const fact = await state.store.setFactMuted(id, on);
              if (!fact) return writeJson(res, 404, { ok: false, error: "fact not found" });
              invalidateRecallCache();
              return writeJson(res, 200, { ok: true, action, id, muted: Boolean(fact.muted), fact });
            }
            case "explain": {
              // Why is (or isn't) this fact recallable? Pure diagnostics, no mutation.
              const fact = await state.store.getFact(id);
              if (!fact) return writeJson(res, 404, { ok: false, error: "fact not found" });
              const { dynamicTrust, relativeAge, RECALL_MIN_DYN_TRUST, flooredStrength, ageInDays } = await import("./lib/decay.js");
              const dyn = dynamicTrust(fact, Date.now());
              const versions = typeof state.store.listFactVersions === "function"
                ? await state.store.listFactVersions(id).catch(() => [])
                : [];
              const reasons = [];
              if (fact.muted) reasons.push("已静音：不会被召回");
              if (fact.superseded) reasons.push(`已被推翻（supersededBy=${fact.supersededBy ?? "?"}）：默认不召回`);
              if (fact.archived) reasons.push("已归档：不在检索池内");
              if (dyn < RECALL_MIN_DYN_TRUST) reasons.push(`动态信任度 ${dyn.toFixed(3)} 低于召回下限 ${RECALL_MIN_DYN_TRUST}`);
              if ((fact.accessCount || 0) === 0) reasons.push("从未被召回");
              if (reasons.length === 0) reasons.push("当前可被正常召回");
              return writeJson(res, 200, {
                ok: true,
                action,
                id,
                fact: {
                  id: fact.id, content: fact.content, category: fact.category,
                  trust: fact.trust, dynTrust: Number(dyn.toFixed(3)),
                  ageDays: Math.round(ageInDays(fact.createdAt) * 10) / 10,
                  age: relativeAge(fact.createdAt),
                  decayStrength: Number(flooredStrength(ageInDays(fact.createdAt)).toFixed(3)),
                  accessCount: fact.accessCount || 0,
                  permanent: Boolean(fact.permanent),
                  muted: Boolean(fact.muted),
                  superseded: Boolean(fact.superseded),
                  archived: Boolean(fact.archived),
                  match: "—",
                },
                reasons,
                versions: versions.map((v) => ({
                  content: v.content, validFrom: v.validFrom, validTo: v.validTo, reason: v.reason,
                })),
              });
            }
            default:
              return writeJson(res, 400, { ok: false, error: `unknown action "${action}" (delete|permanent|mute|explain)` });
          }
        } catch (e) {
          writeJson(res, 500, { ok: false, error: String(e?.message ?? e) });
        }
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-memory/facts",
      handler: async (req, res) => {
        await state.ready;
        if (req.method === "POST") {
          if (!guard(req, res, null)) return;
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            return writeJson(res, 400, { ok: false, error: String(error?.message ?? error) });
          }
          return writeJson(res, 200, await api.addFact(body));
        }
        if (!guard(req, res, "GET")) return;
        const handler = await withData("facts");
        writeJson(res, 200, await handler(paramsOf(req)));
      },
    },
    {
      // RESTful sub-route under /facts: POST /api/dsh-memory/facts/{id}/helpful.
      // The webServer router has no :id segment kind, so a longest-prefix route
      // owns the /facts subtree and parses the id out of the pathname itself.
      // NOTE: the prefix must NOT carry a trailing slash — match() tests
      // `startsWith(prefix + "/")`, so a trailing slash would yield a doubled
      // "//" and never match. The exact /facts route still wins for the list.
      kind: "prefix",
      path: "/api/dsh-memory/facts",
      handler: async (req, res) => {
        await state.ready;
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "POST only" });
        if (!guard(req, res, null)) return;
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const m = pathname.match(/^\/api\/dsh-memory\/facts\/([^/]+)\/helpful$/);
        if (!m) return writeJson(res, 404, { ok: false, error: "not found" });
        const id = decodeURIComponent(m[1]);
        const handler = await withData("markHelpful");
        writeJson(res, 200, await handler(id));
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-memory/providers",
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        const handler = await withData("providers");
        writeJson(res, 200, await handler(paramsOf(req)));
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-memory/sessions",
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        const handler = await withData("sessionSearch");
        writeJson(res, 200, await handler(paramsOf(req)));
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-memory/refresh",
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const handler = await withData("refresh");
        writeJson(res, 200, await handler(paramsOf(req)));
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-memory/helpful",
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return writeJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
        const handler = await withData("markHelpful");
        writeJson(res, 200, await handler(body.id));
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-memory/selfcheck",
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        writeJson(res, 200, await selfCheck());
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-memory/export",
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        const handler = await withData("export");
        writeJson(res, 200, await handler());
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-memory/import",
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        let body;
        try { body = await readBody(req); }
        catch (error) { return writeJson(res, 400, { ok: false, error: String(error?.message ?? error) }); }
        const handler = await withData("import");
        writeJson(res, 200, await handler(body));
      },
    },
  ];

  /**
   * End-to-end self check. Runs against the live host, so it answers the only
   * question that matters after an install: "is the memory module actually
   * working in DSH, right now?"
   */
  async function selfCheck() {
    await state.ready;
    const checks = [];
    const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail: detail === undefined ? null : detail });

    add("config.home", typeof cfg.home === "string" && cfg.home.length > 0, cfg.home);
    add("config.version", /^\d+\.\d+\.\d+/.test(cfg.version), cfg.version);
    add("markdown.layer", Boolean(state.md), state.errors.find((e) => e.startsWith("lib/md.js")) ?? "loaded");
    add("store.layer", Boolean(state.store), state.errors.find((e) => e.startsWith("lib/store.js")) ?? "loaded");
    // The agent surface is what makes memory USED rather than merely displayed. A store that
    // opens but exposes no tools and injects nothing is functionally an empty showcase, so
    // selfcheck fails loudly when either half is missing.
    add("agent.tools", Boolean(state.agent), state.errors.find((e) => e.startsWith("agent tools")) ?? "registered");
    add("agent.recall", Boolean(state.recall), state.errors.find((e) => e.startsWith("agent recall")) ?? "mounted");

    let stats = null;
    if (state.store) {
      try {
        stats = await state.store.stats();
        add("store.stats", Number.isFinite(stats.facts), { backend: stats.backend, facts: stats.facts, path: stats.path });
      } catch (error) {
        add("store.stats", false, String(error?.message ?? error));
      }
    } else {
      add("store.stats", false, "no store");
    }

    if (state.md) {
      try {
        const files = [];
        for (const key of Object.keys(state.md.FILES ?? { agent: 1, user: 1 })) {
          const file = await state.md.readMemoryFile(cfg, key);
          files.push({ key, exists: file.exists, entries: file.entries?.length ?? 0, chars: file.chars, budget: file.budget });
        }
        add("markdown.read", files.length > 0, files);
      } catch (error) {
        add("markdown.read", false, String(error?.message ?? error));
      }
    }

    // Round-trip: write a fact, read it back through the query path, remove it.
    if (state.store) {
      const probe = `selfcheck ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 8)}`;
      let created = null;
      try {
        created = await state.store.upsertFact({ content: probe, category: "diagnostic", tags: ["selfcheck"], trust: 0.5, source: "import" });
        const found = await state.store.queryFacts({ q: probe, limit: 5 });
        const hit = (found?.facts ?? []).some((f) => f.id === created.id);
        add("store.roundtrip", Boolean(created?.id) && hit, { id: created?.id, matched: hit });
        await state.store.deleteFact(created.id);
        created = null;
        const after = await state.store.queryFacts({ q: probe, limit: 5 });
        add("store.cleanup", (after?.facts ?? []).length === 0, { remaining: (after?.facts ?? []).length });
      } catch (error) {
        add("store.roundtrip", false, String(error?.message ?? error));
      } finally {
        if (created?.id) {
          try { await state.store.deleteFact(created.id); } catch { /* best effort */ }
        }
      }
    }

    // Holographic layer. Loading is not enough to call it healthy: a layer that hands back
    // arbitrary vectors would still "load". So this encodes twice (determinism), checks the vector
    // is a finite unit vector, and checks that a related fact really outranks an unrelated one.
    add("holographic.layer", Boolean(state.hrr), state.errors.find((e) => e.startsWith("lib/hrr.js")) ?? "loaded");

    // Embedder (bge-small-zh). "Deliberately not started" is a PASS, not a failure: the
    // JSON backend cannot store vectors and DSH_MEMORY_NO_EMBED=1 is an explicit opt-out,
    // so neither is a defect. Only "we wanted it and it broke" fails this check.
    const emb = state.embedder;
    const embedSkipped = !emb && Boolean(embedSkipReason);
    add(
      "embedder.worker",
      Boolean(emb) || embedSkipped,
      emb ? (emb.isFailed() ? "failed" : emb.isReady() ? "ready" : "loading") : `skipped (${embedSkipReason ?? "not started"})`,
    );
    if (state.store) {
      try {
        const embCount = await state.store.countEmbeddings();
        const total = stats?.facts ?? 0;
        add("embedder.backfill", true, { embedded: embCount, total, pct: total > 0 ? Math.round(embCount / total * 100) : 0 });
      } catch (error) {
        add("embedder.backfill", false, String(error?.message ?? error));
      }
    }
    if (state.hrr) {
      try {
        const hrr = state.hrr;
        const query = "显卡显存怎么分配？";
        const related = "GPU 显存分配：32K 上下文配 q4_0 的 KV 缓存。";
        const unrelated = "番茄炒蛋要先把鸡蛋炒散再下番茄。";
        const first = hrr.encode(query);
        const second = hrr.encode(query);
        let deterministic = first.length === second.length;
        let finite = true;
        let norm = 0;
        for (let i = 0; i < first.length; i++) {
          if (!deterministic || first[i] !== second[i]) deterministic = false;
          if (!Number.isFinite(first[i])) finite = false;
          norm += first[i] * first[i];
        }
        const near = hrr.similarity(hrr.encode(related), first);
        const far = hrr.similarity(hrr.encode(unrelated), first);
        add("holographic.encode", deterministic && finite && Math.abs(Math.sqrt(norm) - 1) < 1e-3, {
          dim: first.length,
          deterministic,
          finite,
          norm: Number(Math.sqrt(norm).toFixed(6)),
        });
        add("holographic.rank", near > far, { related: Number(near.toFixed(4)), unrelated: Number(far.toFixed(4)) });
      } catch (error) {
        add("holographic.encode", false, String(error?.message ?? error));
        add("holographic.rank", false, String(error?.message ?? error));
      }
    }

    // Decay regression probe. The bug this catches: a formula whose real half-life is
    // far shorter than its documented layers (the previous one was 1.58 days instead of
    // 3.5), which silently retired every memory after a few days. Checking the shape of
    // the curve — not just that a number comes out — is what makes that class of bug
    // visible from a browser instead of after a week of "it forgot".
    try {
      const decay = await import("./lib/decay.js");
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const sample = (days) => decay.dynamicTrust({ trust: 0.8, createdAt: now - days * day }, now);
      const d0 = sample(0);
      const d7 = sample(7);
      const d365 = sample(365);
      const halfLife = decay.effectiveHalfLifeDays();
      // A memory that is a week old must still be usable, and a year old must still be
      // findable (above the recall floor) — those are the two user-visible promises.
      const weekAlive = d7 >= decay.RECALL_MIN_DYN_TRUST;
      const yearFindable = d365 >= decay.RECALL_MIN_DYN_TRUST;
      const halfLifeSane = halfLife >= 2 && halfLife <= 14;
      const monotone = d0 > d7 && d7 > d365;
      add("recall.decay", weekAlive && yearFindable && halfLifeSane && monotone, {
        halfLifeDays: Math.round(halfLife * 100) / 100,
        at0d: Number(d0.toFixed(3)),
        at7d: Number(d7.toFixed(3)),
        at365d: Number(d365.toFixed(3)),
        recallFloor: decay.RECALL_MIN_DYN_TRUST,
        weekAlive,
        yearFindable,
        monotone,
      });
    } catch (error) {
      add("recall.decay", false, String(error?.message ?? error));
    }

    // Per-turn recall probe: two different questions must be able to retrieve two
    // different facts. The bug this catches: "inject once per session", which made the
    // second half of every conversation memory-blind.
    if (state.store) {
      const tag = `selfcheck-perTurn-${Math.random().toString(36).slice(2, 8)}`;
      let a = null;
      let b = null;
      try {
        a = await state.store.upsertFact({ content: `记忆探针甲：${tag} 端口固定 44565`, category: "diagnostic", tags: ["selfcheck"], trust: 0.9, source: "import" });
        b = await state.store.upsertFact({ content: `记忆探针乙：${tag} 显存分配 q4_0 KV 缓存`, category: "diagnostic", tags: ["selfcheck"], trust: 0.9, source: "import" });
        const { retrieveFacts } = await import("./lib/agent.js");
        // The query must be a substring of each probe's own content: the keyword channel
        // matches `content.includes(query)`, so a paraphrased question ("端口 44565" vs
        // "端口固定 44565") legitimately finds nothing without an embedding index.
        const hitA = await retrieveFacts({}, state.store, "记忆探针甲", { limit: 5 });
        const hitB = await retrieveFacts({}, state.store, "记忆探针乙", { limit: 5 });
        const idsA = new Set((hitA ?? []).map((f) => String(f.id)));
        const idsB = new Set((hitB ?? []).map((f) => String(f.id)));
        // Each query must reach its own fact, and the two results must not be identical
        // (identical results mean recall is ignoring the question).
        const reachedA = idsA.has(String(a.id));
        const reachedB = idsB.has(String(b.id));
        const differ = !(idsA.size === idsB.size && [...idsA].every((id) => idsB.has(id)));
        add("recall.perTurn", reachedA && reachedB && differ, {
          queryA: reachedA, queryB: reachedB, resultsDiffer: differ,
        });
      } catch (error) {
        add("recall.perTurn", false, String(error?.message ?? error));
      } finally {
        // Always remove the probes, on the success path AND the failure path. Never run a
        // broad maintenance call here: an earlier draft called archiveOldFacts({minAgeDays:0,
        // maxTrust:1}) as "cleanup", which would have archived the user's entire memory.
        for (const probe of [a, b]) {
          if (!probe?.id) continue;
          try { await state.store.deleteFact(probe.id); } catch { /* probe may never have landed */ }
        }
      }
    } else {
      add("recall.perTurn", false, "no store");
    }

    // Memory health: which facts are dead weight. Pure statistics, no model, no deletion —
    // it reports so a human (or the model) can decide. This is the "checkup" idea: a
    // memory store that is never audited silently fills with things nobody asks about.
    if (state.store) {
      try {
        const all = await state.store.queryFacts({ q: "", limit: 10000, includeArchived: true, includeSuperseded: true });
        const edges = [];
        for (const f of (all?.facts ?? []).slice(0, 500)) {
          if (typeof state.store.listEdges !== "function") break;
          try {
            const rows = await state.store.listEdges(String(f.id));
            if (Array.isArray(rows)) edges.push(...rows);
          } catch { /* edges optional */ }
        }
        const { auditFacts, describeFindings } = await import("./lib/health.js");
        const audit = auditFacts(all?.facts ?? [], edges);
        add("memory.health", true, {
          ...audit.summary,
          note: describeFindings(audit) || "no issues found",
          sample: {
            neverRecalled: audit.findings.neverRecalled.slice(0, 3),
            nearDuplicates: audit.findings.nearDuplicates.slice(0, 3),
            liveContradictions: audit.findings.contradictions.filter((c) => c.bothLive).slice(0, 3),
          },
        });
      } catch (error) {
        add("memory.health", false, String(error?.message ?? error));
      }
    } else {
      add("memory.health", false, "no store");
    }

    const sessionProbe = await sessions.search({ limit: 5 });    add("sessions.scan", sessionProbe.ok === true, { scanned: sessionProbe.scanned ?? 0, sources: sessionProbe.sources ?? [], note: sessionProbe.note ?? null });

    const env = { node: process.versions?.node, electron: process.versions?.electron ?? null, pid: process.pid };

    return {
      ok: checks.every((c) => c.ok),
      provider: PROVIDER_ID,
      version: cfg.version,
      home: cfg.home,
      errors: state.errors,
      env,
      checks,
      passed: checks.filter((c) => c.ok).length,
      total: checks.length,
      at: Date.now(),
    };
  }

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    // Async so a caller (and the test suite) can await the fact store actually
    // closing its handle before the memory directory is removed.
    return async () => {
      for (const dispose of disposers) dispose();
      try { if (archiveTimer) clearInterval(archiveTimer); } catch { /* already gone */ }
      archiveTimer = null;
      try { if (consolidateTimer) clearInterval(consolidateTimer); } catch { /* already gone */ }
      consolidateTimer = null;
      try {
        await state.ready;
      } catch {
        /* bootstrap already logged its own failure */
      }
      try {
        state.recall?.();
      } catch {
        /* already gone */
      }
      try {
        state.agent?.dispose?.();
      } catch {
        /* already gone */
      }
      try {
        await state.embedder?.dispose?.();
      } catch {
        /* already gone */
      }
      try {
        await state.reflector?.dispose?.();
      } catch {
        /* already gone */
      }
      try {
        await state.store?.close?.();
      } catch (error) {
        logger.warn?.(`[dsh-memory] store close failed: ${error?.message ?? error}`);
      }
    };
  }, "dsh-memory: routes");
}
