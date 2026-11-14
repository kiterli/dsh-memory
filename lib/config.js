/**
 * Configuration for @local/dsh-memory.
 *
 * Resolves the memory home, the markdown character budgets and the fact-store
 * backend. The store backend can only be *probed* here (the store module is the
 * authority on what it actually used); `storePath`/`backend` are hints for the
 * UI before the store has been opened.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

export const DEFAULT_AGENT_BUDGET = 2200;
export const DEFAULT_USER_BUDGET = 1375;

/**
 * The assistant's name. Not cosmetic: it is injected as the first line of the memory
 * instructions, which is what makes the assistant answer to it and speak as itself
 * rather than as "the assistant". Configurable so a different user can rename it.
 */
export const DEFAULT_ASSISTANT_NAME = "小智";

/** Version string from our own package.json, or '0.0.0' if unreadable. */
export function pluginVersion() {
  try {
    const doc = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return typeof doc?.version === "string" ? doc.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Synchronously ask whether the running runtime has a usable node:sqlite.
 * `process.getBuiltinModule` exists on Node >= 22.3 and on Electron's node, and
 * returns undefined for a builtin that was not compiled in - which is exactly
 * the answer we need, without an async import.
 */
export function hasSqlite() {
  try {
    const mod = process.getBuiltinModule?.("node:sqlite");
    return Boolean(mod && typeof mod.DatabaseSync === "function");
  } catch {
    return false;
  }
}

/** Directory the markdown files and the fact store live in. */
export function resolveMemoryHome(input = {}) {
  const explicit = clean(input.home);
  if (explicit) return path.resolve(explicit);

  const fromEnv = clean(process.env.DSH_MEMORY_HOME);
  if (fromEnv) return path.resolve(fromEnv);

  const dshHome = clean(process.env.DSH_HOME);
  if (dshHome) return path.join(path.resolve(dshHome), "memories");

  return path.join(os.homedir(), ".dsh", "memories");
}

function clean(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function toBudget(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function resolveMemoryConfig(input = {}) {
  const home = resolveMemoryHome(input);
  const sqlite = hasSqlite();
  return {
    home,
    agentBudget: toBudget(input.agentBudget, DEFAULT_AGENT_BUDGET),
    userBudget: toBudget(input.userBudget, DEFAULT_USER_BUDGET),
    autoExtract: input.autoExtract === true,
    assistantName: clean(input.assistantName) || DEFAULT_ASSISTANT_NAME,
    backend: sqlite ? "sqlite" : "json",
    storePath: path.join(home, sqlite ? "memory_store.db" : "memory_store.json"),
    version: pluginVersion(),
    packageRoot,
  };
}

/** Human-readable environment facts; used by the /env route and the README. */
export function runtimeEnv(cfg) {
  const electron = process.versions?.electron ?? null;
  return {
    node: process.versions?.node ?? null,
    electron,
    chrome: process.versions?.chrome ?? null,
    v8: process.versions?.v8 ?? null,
    platform: process.platform,
    arch: process.arch,
    sqlite: hasSqlite(),
    pid: process.pid,
    home: cfg.home,
    homeExists: existsSync(cfg.home),
    backend: cfg.backend,
    storePath: cfg.storePath,
    version: cfg.version,
    // Where the host thinks DSH lives - handy when diagnosing a wrong home.
    dshHome: clean(process.env.DSH_HOME) || null,
    dshProfile: clean(process.env.DSH_PROFILE) || null,
    memoryHomeEnv: clean(process.env.DSH_MEMORY_HOME) || null,
  };
}
