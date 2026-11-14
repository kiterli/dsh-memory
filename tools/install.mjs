#!/usr/bin/env node
/**
 * Install (or revert) @local/dsh-memory in the live DSH profile.
 *
 *   node dsh-memory/tools/install.mjs                 # dry run: show the plan
 *   node dsh-memory/tools/install.mjs --apply         # patch profile + pnpm install
 *   node dsh-memory/tools/install.mjs --apply --no-install
 *   node dsh-memory/tools/install.mjs --revert        # restore the backup
 *   node dsh-memory/tools/install.mjs --verify        # check an installed profile
 *
 * The profile lives outside the workspace, so --apply is a privileged write.
 * Everything is backed up first and --revert puts it back byte for byte.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const PACKAGE_NAME = "@local/dsh-memory";
const BACKUP_MARK = ".dsh-memory-backup";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const REVERT = args.has("--revert");
const VERIFY = args.has("--verify");
const NO_INSTALL = args.has("--no-install");

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const PROFILE_DIR =
  process.env.DSH_PROFILE_DIR ||
  path.join(DSH_HOME, "profiles", process.env.DSH_PROFILE || "desktop");
const PKG = path.join(PROFILE_DIR, "package.json");
const LOCK = path.join(PROFILE_DIR, "pnpm-lock.yaml");
const PNPM_CANDIDATES = [
  path.join("D:\\DSH-Herness\\DSH NEXT\\resources\\app.asar.unpacked\\node_modules\\pnpm\\bin\\pnpm.cjs"),
  path.join(process.env.APPDATA || "", "npm", "node_modules", "pnpm", "bin", "pnpm.cjs"),
];

const say = (...a) => console.log(...a);
const linkSpec = `link:${pluginRoot.replace(/\\/g, "/")}`;
const installedLink = path.join(PROFILE_DIR, "node_modules", ...PACKAGE_NAME.split("/"));

function readPackage() {
  return JSON.parse(readFileSync(PKG, "utf8"));
}

function newestBackup() {
  if (!existsSync(PROFILE_DIR)) return null;
  const hits = readdirSync(PROFILE_DIR)
    .filter((name) => name.startsWith(path.basename(PKG) + BACKUP_MARK))
    .sort();
  return hits.length ? path.join(PROFILE_DIR, hits[hits.length - 1]) : null;
}

function plan() {
  const pkg = readPackage();
  const deps = pkg.dependencies ?? {};
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  return {
    pkg,
    hasDep: Object.prototype.hasOwnProperty.call(deps, PACKAGE_NAME),
    depValue: deps[PACKAGE_NAME] ?? null,
    depCorrect: deps[PACKAGE_NAME] === linkSpec,
    hasBundle: bundles.includes(PACKAGE_NAME),
    bundleCount: bundles.length,
    installed: existsSync(installedLink) || existsSync(installedLink + ".json"),
  };
}

function report() {
  const p = plan();
  say(`plugin root      : ${pluginRoot}`);
  say(`profile dir      : ${PROFILE_DIR}`);
  say(`package.json     : ${existsSync(PKG) ? "found" : "MISSING"}`);
  say(`dependency       : ${p.hasDep ? p.depValue : "(absent)"}  ${p.depCorrect ? "<= correct" : ""}`);
  say(`expected spec    : ${linkSpec}`);
  say(`bundle row       : ${p.hasBundle ? "present" : "absent"} (bundles: ${p.bundleCount})`);
  say(`linked into node_modules : ${p.installed ? "yes" : "no"}`);
  return p;
}

function doApply() {
  const before = report();
  say("");
  if (before.hasDep && before.depCorrect && before.hasBundle && before.installed && !REVERT) {
    say("Already installed; nothing to patch. Re-running pnpm install only.");
  }

  // 1. backup
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pkgBackup = `${PKG}${BACKUP_MARK}-${stamp}`;
  const lockBackup = `${LOCK}${BACKUP_MARK}-${stamp}`;
  copyFileSync(PKG, pkgBackup);
  if (existsSync(LOCK)) copyFileSync(LOCK, lockBackup);
  say(`backup written   : ${path.basename(pkgBackup)}`);
  if (existsSync(LOCK)) say(`backup written   : ${path.basename(lockBackup)}`);

  // 2. patch package.json
  const pkg = readPackage();
  pkg.dependencies = pkg.dependencies ?? {};
  pkg.dependencies[PACKAGE_NAME] = linkSpec;
  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME);
  pkg.dsh.profile.bundles = bundles;
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  say(`patched          : dependency + bundles[${bundles.length - 1}] = ${PACKAGE_NAME}`);

  if (NO_INSTALL) {
    say("--no-install given; stopping before pnpm.");
    return;
  }

  // 3. pnpm install, offline: every other dependency is already in the store.
  const pnpm = PNPM_CANDIDATES.find((p) => existsSync(p));
  if (!pnpm) {
    say("ERROR: no bundled pnpm found. Tried:");
    for (const p of PNPM_CANDIDATES) say(`  ${p}`);
    process.exitCode = 1;
    return;
  }
  say(`pnpm             : ${pnpm}`);
  try {
    const out = execFileSync(process.execPath, [pnpm, "install", "--offline", "--prefer-offline", "--reporter", "append-only"], {
      cwd: PROFILE_DIR,
      encoding: "utf8",
      timeout: 600000,
      windowsHide: true,
    });
    say(out.trim().split("\n").slice(-12).join("\n"));
  } catch (error) {
    say(`pnpm install FAILED: ${error.message}`);
    say(String(error.stdout ?? "").slice(-2000));
    say(String(error.stderr ?? "").slice(-2000));
    say(`restore with: copy "${pkgBackup}" "${PKG}"`);
    process.exitCode = 1;
    return;
  }

  say("");
  report();
}

function doRevert() {
  const backup = newestBackup();
  if (!backup) {
    say("No backup found; nothing to revert.");
    process.exitCode = 1;
    return;
  }
  const stamp = backup.slice(backup.indexOf(BACKUP_MARK) + BACKUP_MARK.length);
  const lockBackup = `${LOCK}${BACKUP_MARK}${stamp}`;
  copyFileSync(backup, PKG);
  say(`restored ${path.basename(PKG)} from ${path.basename(backup)}`);
  if (existsSync(lockBackup)) {
    copyFileSync(lockBackup, LOCK);
    say(`restored ${path.basename(LOCK)}`);
  }
  say("Run pnpm install again to drop the package from node_modules.");
}

async function doVerify() {
  const p = report();
  say("");
  let failures = 0;
  const check = (label, ok, detail = "") => {
    say(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
    if (!ok) failures += 1;
  };
  check("dependency row present and correct", p.hasDep && p.depCorrect, p.depValue ?? "");
  check("bundle row present", p.hasBundle);
  check("linked into node_modules", p.installed, installedLink);

  if (p.installed) {
    const entry = existsSync(path.join(installedLink, "package.json"))
      ? installedLink
      : installedLink + ".json";
    try {
      const manifest = JSON.parse(readFileSync(path.join(entry === installedLink ? entry : path.dirname(entry), "package.json"), "utf8"));
      check("manifest name", manifest.name === PACKAGE_NAME, manifest.name);
      check("manifest exports ./client", Boolean(manifest.exports?.["./client"]));
      check("manifest dsh.client.platform", manifest.dsh?.client?.platform === "web");
    } catch (error) {
      check("manifest readable", false, String(error.message));
    }
  }

  // Load the host half the way cordis would, and count the routes it registers.
  try {
    const mod = await import(pathToFileURL(path.join(pluginRoot, "index.js")).href);
    check("host half exports name", mod.name === PACKAGE_NAME, mod.name);
    check("host half injects webServer", Array.isArray(mod.inject) && mod.inject.includes("webServer"), JSON.stringify(mod.inject));
    const routes = [];
    let effectLabel = null;
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      webServer: { register: (r) => (routes.push(r), () => {}) },
      effect: (fn, label) => ((effectLabel = label), fn(), () => {}),
    };
    mod.apply(ctx, {});
    await new Promise((r) => setTimeout(r, 400));
    check("registers routes", routes.length >= 9, `${routes.length} routes`);
    check("effect labelled", effectLabel === "dsh-memory: routes", String(effectLabel));
    check("client entry file exists", existsSync(path.join(pluginRoot, "client.js")));
  } catch (error) {
    check("host half loads", false, String(error.message));
  }

  say("");
  say(failures === 0 ? "VERIFY: all checks passed" : `VERIFY: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

if (REVERT) doRevert();
else if (VERIFY) await doVerify();
else if (APPLY) doApply();
else {
  report();
  say("");
  say("dry run. re-run with --apply to patch the profile, or --verify to check an installed one.");
}
