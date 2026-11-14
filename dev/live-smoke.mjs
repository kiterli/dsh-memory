#!/usr/bin/env node
/**
 * Live-HTTP smoke of the host half. Boots dsh-memory's apply() into a real
 * node:http server (no DSH, no fake ctx), then exercises the routes over the wire:
 *
 *   node dsh-memory/dev/live-smoke.mjs [--home <dir>] [--port 0]
 *
 * This is the closest-to-real proof that survives without the Electron shell: exactly
 * the route handlers the plugin registers, driven through genuine HTTP.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const home = path.join(mkdtempSync(path.join(tmpdir(), "dsh-mem-live-")), "memories");
const prev = process.env.DSH_MEMORY_HOME;
process.env.DSH_MEMORY_HOME = home;

const { apply } = await import(pathToFileURL(path.resolve("dsh-memory/index.js")).href);

// A tiny webServer that serves the plugin's kind:"exact" routes over real HTTP.
const routes = [];
const ctx = {
  logger: {
    info: (...a) => console.log("  [info]", ...a),
    warn: (...a) => console.log("  [warn]", ...a),
    error: (...a) => console.log("  [error]", ...a),
  },
  webServer: { register: (route) => (routes.push(route), () => {}) },
  effect: (fn) => {
    const d = fn();
    process.on("exit", async () => { try { await d; } catch {} });
    return () => {};
  },
};
apply(ctx, {});

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const route = routes.find((r) => r.kind === "exact" && r.path === url.pathname);
  if (!route) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "no route: " + url.pathname }));
  }
  // Drain the request once, then hand it back to the handler with an async iterator
  // that re-yields the saved bytes, so readBody() inside the plugin sees them.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  req._bodyChunks = chunks;
  req[Symbol.asyncIterator] = async function* () {
    for (const c of this._bodyChunks) yield c;
  };
  const cl = Object.create(null);
  for (const [k, v] of Object.entries(req.headers)) cl[k] = v;
  req.headers = cl;
  // isAllowed wants a Host header; set loopback so it passes.
  if (!req.headers.host) req.headers.host = "127.0.0.1:" + (server.address()?.port ?? 8080);
  await route.handler(req, { writeHead: (s, h) => { res.writeHead(s, h); }, end: (b) => res.end(b) });
}

const server = http.createServer(handle);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;
console.log("home:", home);
console.log("base:", base);

const J = (method, route, body) => fetch(base + route, {
  method,
  headers: { "content-type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());

const ok = (label, cond, extra = "") => console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);

await new Promise((r) => setTimeout(r, 500)); // let bootstrap settle
const env = await J("GET", "/api/dsh-memory/env");
ok("env.ok", env.ok && env.home === home, `backend=${env.backend}`);

const overview = await J("GET", "/api/dsh-memory/overview");
ok("overview", overview.ok && overview.builtin.files === 2, `holographic=${JSON.stringify(overview.holographic)}`);

// Add facts, exercise holographic ranking over the wire.
await J("POST", "/api/dsh-memory/facts", { content: "GPU 显存分配：32K 上下文配 q4_0 的 KV 缓存。", category: "hardware", tags: ["gpu", "mm"] });
await J("POST", "/api/dsh-memory/facts", { content: "番茄炒蛋要先把鸡蛋炒散再下番茄。", category: "food", tags: ["cooking"] });
await new Promise((r) => setTimeout(r, 200));

const kw = await J("GET", "/api/dsh-memory/facts?q=显存");
ok("keywords face Illumination: hits=" + kw.facts.length + " holo=" + kw.holographic.enabled, kw.ok && kw.facts.length > 0);

const hrr = await J("GET", "/api/dsh-memory/facts?q=显卡内存分配");
const top = hrr.facts?.[0];
ok("holographic ranks GPU first", hrr.ok && top?.content?.includes("显存"), `score=${top?.score} match=${top?.match}`);

const self = await J("GET", "/api/dsh-memory/selfcheck");
ok("selfcheck ok", self.ok === true, `${self.passed}/${self.total}`);
const failed = self.checks?.filter((c) => !c.ok);
if (failed?.length) failed.forEach((c) => ok("  selfcheck." + c.id, false, JSON.stringify(c.detail)));

const sessions = await J("GET", "/api/dsh-memory/sessions");
ok("sessions", sessions.ok, `scanned=${sessions.scanned ?? 0} sources=${JSON.stringify(sessions.sources ?? [])}`);

server.close();
process.env.DSH_MEMORY_HOME = prev;
console.log("done.");