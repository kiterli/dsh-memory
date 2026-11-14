/**
 * Host-half end-to-end test: apply() the real plugin against a fake cordis
 * context, then drive every registered HTTP route the way webServer would.
 *
 * Nothing here is mocked except the context and the HTTP plumbing, so a green
 * run means index.js + lib/api.js + lib/md.js + lib/store.js actually work
 * together - which is the only thing we cannot learn from unit tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Keep the embedder out of the test process. A Worker's two MessagePorts survive
// worker.terminate() in Node 22, so a test run that ever spawned one would never exit.
// The embedder is exercised separately (agent.test.mjs / live smoke), not here.
process.env.DSH_MEMORY_NO_EMBED = "1";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const indexUrl = pathToFileURL(path.join(pluginRoot, "index.js")).href;

/* ------------------------------------------------------------- fake cordis */

function makeCtx() {
  const routes = [];
  const disposers = [];
  const logs = [];
  const ctx = {
    logger: {
      info: (m) => logs.push(["info", m]),
      warn: (m) => logs.push(["warn", m]),
      error: (m) => logs.push(["error", m]),
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    effect(fn, label) {
      const dispose = fn();
      disposers.push({ label, dispose });
      return () => {};
    },
  };
  return { ctx, routes, disposers, logs };
}

/* ------------------------------------------------------------- fake http */

function makeReq({ method = "GET", url = "/", headers = {}, body } = {}) {
  const all = { host: "127.0.0.1:44361", ...headers };
  const req = {
    method,
    url,
    headers: all,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    },
  };
  return req;
}

function makeRes() {
  const state = { status: 0, headers: null, body: "" };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers;
    },
    end(chunk) {
      state.body += chunk ?? "";
    },
    json() {
      return state.body ? JSON.parse(state.body) : null;
    },
  };
}

async function call(routes, routePath, { method = "GET", query = "", body, headers } = {}) {
  const route = routes.find((r) => r.path === routePath);
  assert.ok(route, `route ${routePath} was not registered`);
  const res = makeRes();
  await route.handler(makeReq({ method, url: routePath + query, headers, body }), res);
  return res;
}

/* ------------------------------------------------------------------ tests */

test("host half: routes, degraded start, and full data round-trip", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "dsh-memory-routes-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const prevHome = process.env.DSH_MEMORY_HOME;
  process.env.DSH_MEMORY_HOME = home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.DSH_MEMORY_HOME;
    else process.env.DSH_MEMORY_HOME = prevHome;
  });

  const { apply } = await import(indexUrl);
  const { ctx, routes, disposers, logs } = makeCtx();
  apply(ctx, {});

  // --- registration ------------------------------------------------------
  const exactByPath = Object.fromEntries(routes.filter((r) => r.kind === "exact").map((r) => [r.path, r]));
  for (const p of [
    "/api/dsh-memory/builtin",
    "/api/dsh-memory/env",
    "/api/dsh-memory/facts",
    "/api/dsh-memory/helpful",
    "/api/dsh-memory/overview",
    "/api/dsh-memory/providers",
    "/api/dsh-memory/refresh",
    "/api/dsh-memory/selfcheck",
    "/api/dsh-memory/sessions",
  ]) {
    assert.ok(exactByPath[p], `exact route ${p} was not registered`);
  }
  // RESTful sub-route: POST /facts/{id}/helpful lives under a longest-prefix
  // route because the router has no :id segment kind. The prefix shares the
  // /facts stem with the exact list route but carries no trailing slash: the
  // match() test is startsWith(prefix + "/"), so a trailing slash would
  // produce a doubled "//" and never match.
  const restful = routes.find((r) => r.kind === "prefix" && r.path === "/api/dsh-memory/facts");
  assert.ok(restful, "prefix route /api/dsh-memory/facts was not registered");
  assert.equal(restful.kind, "prefix");
  for (const route of routes) {
    if (route.kind === "prefix") continue;
    assert.equal(route.kind, "exact");
  }
  assert.equal(disposers.length, 1, "the plugin must register exactly one effect");
  assert.equal(disposers[0].label, "dsh-memory: routes");

  // --- env ---------------------------------------------------------------
  const env = await call(routes, "/api/dsh-memory/env");
  assert.equal(env.state.status, 200);
  const envBody = env.json();
  assert.equal(envBody.ok, true);
  assert.ok(envBody.node, "node version must be reported");
  assert.equal(envBody.home, home);
  assert.ok(["sqlite", "json"].includes(envBody.backend));

  // --- a fresh home must still answer everything -------------------------
  const overview = await call(routes, "/api/dsh-memory/overview");
  const overviewBody = overview.json();
  assert.equal(overview.state.status, 200);
  assert.equal(overviewBody.ok, true);
  assert.equal(overviewBody.builtin.files, 2);
  assert.equal(overviewBody.builtin.available, 0, "no MEMORY.md / USER.md exists yet");
  assert.equal(overviewBody.builtin.entries, 0);
  assert.equal(overviewBody.providers.enabled, 1);
  assert.equal(overviewBody.providers.items[0].id, "holographic");
  assert.equal(overviewBody.budgets.agent, 2200);
  assert.equal(overviewBody.budgets.user, 1375);
  assert.equal(typeof overviewBody.facts.total, "number");
  assert.equal(overviewBody.version, "0.1.0");

  // --- markdown layer ----------------------------------------------------
  const builtin = await call(routes, "/api/dsh-memory/builtin");
  const files = builtin.json().files;
  assert.equal(files.length, 2);
  const agent = files.find((f) => f.key === "agent");
  const user = files.find((f) => f.key === "user");
  assert.equal(agent.fileName, "MEMORY.md");
  assert.equal(agent.budget, 2200);
  assert.equal(agent.exists, false);
  assert.equal(agent.percent, 0);
  assert.deepEqual(agent.entries, []);
  assert.equal(user.fileName, "USER.md");
  assert.equal(user.budget, 1375);

  const written = await call(routes, "/api/dsh-memory/builtin", {
    method: "POST",
    body: { key: "agent", text: "DSH memory module smoke entry." },
  });
  const writtenBody = written.json();
  assert.equal(writtenBody.ok, true, JSON.stringify(writtenBody));
  assert.equal(writtenBody.file.entries.length, 1);
  assert.match(writtenBody.file.entries[0].text, /smoke entry/);
  assert.equal(writtenBody.file.exists, true);
  assert.ok(writtenBody.file.chars > 0);
  assert.equal(await readFile(path.join(home, "MEMORY.md"), "utf8") !== "", true);

  const badKey = await call(routes, "/api/dsh-memory/builtin", { method: "POST", body: { key: "nope", text: "x" } });
  assert.equal(badKey.json().ok, false);

  // --- fact store --------------------------------------------------------
  const created = await call(routes, "/api/dsh-memory/facts", {
    method: "POST",
    body: { content: "The RTX 3060 Laptop has 12288 MiB of VRAM.", category: "machine", tags: ["gpu"], trust: 0.8 },
  });
  const createdBody = created.json();
  assert.equal(createdBody.ok, true, JSON.stringify(createdBody));
  const factId = createdBody.fact.id;
  assert.ok(factId);

  const found = await call(routes, "/api/dsh-memory/facts", { query: "?q=VRAM" });
  const foundBody = found.json();
  assert.equal(foundBody.ok, true);
  assert.ok(foundBody.total >= 1);
  assert.ok(foundBody.facts.some((f) => f.id === factId), "the new fact must be queryable");
  const fact = foundBody.facts.find((f) => f.id === factId);
  assert.equal(fact.category, "machine");
  assert.deepEqual(fact.tags, ["gpu"]);
  assert.equal(fact.trust, 0.8);
  assert.ok(fact.shortId && fact.shortId.length <= 8);

  const filtered = await call(routes, "/api/dsh-memory/facts", { query: "?category=machine&minTrust=0.5" });
  assert.ok(filtered.json().facts.some((f) => f.id === factId));
  const excluded = await call(routes, "/api/dsh-memory/facts", { query: "?category=general" });
  assert.ok(!excluded.json().facts.some((f) => f.id === factId), "category filter must exclude");

  const helpful = await call(routes, "/api/dsh-memory/helpful", { method: "POST", body: { id: factId } });
  assert.equal(helpful.json().ok, true);
  assert.equal(helpful.json().fact.helpfulCount, 1);

  // RESTful variant: POST /facts/{id}/helpful (path param, no body).
  const restfulRes = makeRes();
  await restful.handler(makeReq({ method: "POST", url: `/api/dsh-memory/facts/${factId}/helpful` }), restfulRes);
  assert.equal(restfulRes.state.status, 200);
  assert.equal(restfulRes.json().ok, true);
  assert.equal(restfulRes.json().fact.helpfulCount, 2);

  // An unknown sub-path under /facts/ must 404, not fall through to a fact route.
  const unknownRes = makeRes();
  await restful.handler(makeReq({ method: "POST", url: "/api/dsh-memory/facts/xyz/not-a-route" }), unknownRes);
  assert.equal(unknownRes.state.status, 404);

  const providers = await call(routes, "/api/dsh-memory/providers");
  const provider = providers.json().providers[0];
  assert.equal(provider.facts, 1);
  assert.equal(provider.available, true);
  assert.ok(provider.path);
  assert.ok(["sqlite", "json"].includes(provider.backend));
  assert.ok(provider.categories.some((c) => c.name === "machine"));

  const expiry = await call(routes, "/api/dsh-memory/refresh", { method: "POST" });
  assert.equal(expiry.json().ok, true);
  assert.ok(expiry.json().snapshotAt > 0);

  // --- sessions ----------------------------------------------------------
  const sessions = await call(routes, "/api/dsh-memory/sessions");
  const sessionsBody = sessions.json();
  assert.equal(sessions.state.status, 200);
  assert.equal(sessionsBody.ok, true);
  assert.ok(Array.isArray(sessionsBody.sessions));

  // --- guard rails -------------------------------------------------------
  const wrongMethod = await call(routes, "/api/dsh-memory/env", { method: "POST" });
  assert.equal(wrongMethod.state.status, 405);

  const crossSite = await call(routes, "/api/dsh-memory/env", { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.state.status, 403);

  const remoteHost = await call(routes, "/api/dsh-memory/env", { headers: { host: "evil.example.com" } });
  assert.equal(remoteHost.state.status, 403);

  const badOrigin = await call(routes, "/api/dsh-memory/env", { headers: { origin: "http://evil.example.com" } });
  assert.equal(badOrigin.state.status, 403);

  const goodOrigin = await call(routes, "/api/dsh-memory/env", { headers: { origin: "http://127.0.0.1:44361" } });
  assert.equal(goodOrigin.state.status, 200);

  // --- self check --------------------------------------------------------
  const self = await call(routes, "/api/dsh-memory/selfcheck");
  const selfBody = self.json();
  assert.equal(self.state.status, 200);
  assert.equal(selfBody.ok, true, `selfcheck failed: ${JSON.stringify(selfBody.checks?.filter((c) => !c.ok))}`);
  assert.equal(selfBody.passed, selfBody.total);
  const roundtrip = selfBody.checks.find((c) => c.id === "store.roundtrip");
  assert.ok(roundtrip.ok, "the store must round-trip a fact");
  const cleanup = selfBody.checks.find((c) => c.id === "store.cleanup");
  assert.ok(cleanup.ok, "the self-check must remove its own probe fact");

  // The probe must not have been left behind.
  const after = await call(routes, "/api/dsh-memory/facts", { query: "?q=selfcheck" });
  assert.equal(after.json().facts.length, 0, "selfcheck left a probe fact behind");

  assert.equal(logs.filter(([level]) => level === "error").length, 0, "no errors should be logged");

  // Release the fact store handle before the temp home is removed; Windows
  // refuses to unlink an open SQLite file.
  await disposers[0].dispose();
});

test("host half: a missing memory home and a corrupt markdown file degrade, not throw", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "dsh-memory-broken-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  // A directory where MEMORY.md should be: readFile will fail with EISDIR.
  await mkdir(path.join(home, "MEMORY.md"), { recursive: true });
  await writeFile(path.join(home, "USER.md"), "§\n\n§\n", "utf8");

  const prevHome = process.env.DSH_MEMORY_HOME;
  process.env.DSH_MEMORY_HOME = home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.DSH_MEMORY_HOME;
    else process.env.DSH_MEMORY_HOME = prevHome;
  });

  const { apply } = await import(indexUrl);
  const { ctx, routes, disposers } = makeCtx();
  apply(ctx, {});

  const builtin = await call(routes, "/api/dsh-memory/builtin");
  assert.equal(builtin.state.status, 200, "an unreadable memory file must not 500 the route");
  const body = builtin.json();
  assert.equal(body.ok, true);
  assert.equal(body.files.length, 2);

  const overview = await call(routes, "/api/dsh-memory/overview");
  assert.equal(overview.state.status, 200);
  assert.equal(overview.json().ok, true);

  const self = await call(routes, "/api/dsh-memory/selfcheck");
  assert.equal(self.state.status, 200, "selfcheck must still answer");

  await disposers[0].dispose();
});
