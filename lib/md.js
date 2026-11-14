/**
 * lib/md.js — builtin Markdown memory files (MEMORY.md / USER.md).
 * Owner: mem-core. Plain ESM, zero npm dependencies.
 *
 * Contract: see dsh-memory/CONTRACT.md, section "lib/md.js (mem-core)".
 * No filesystem access happens at import time; directories are only created on write.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const ENTRY_SEP = '§';

export const FILES = {
  agent: { key: 'agent', fileName: 'MEMORY.md', label: 'Agent memory', budgetKey: 'agentBudget' },
  user: { key: 'user', fileName: 'USER.md', label: 'User profile', budgetKey: 'userBudget' },
};

const FILE_KEYS = ['agent', 'user'];
const DEFAULT_BUDGETS = { agentBudget: 2200, userBudget: 1375 };

/** A separator is a whole line containing only §, with optional surrounding blanks. */
const SEPARATOR_LINE = new RegExp('^[ \\t]*' + ENTRY_SEP + '[ \\t]*$', 'm');

const LOCK_FILE_NAME = '.lock';
const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 3000;
const LOCK_POLL_MIN_MS = 8;
const LOCK_POLL_JITTER_MS = 20;

function resolveHome(cfg) {
  const home = cfg && typeof cfg === 'object' ? cfg.home : undefined;
  if (typeof home !== 'string' || home.trim() === '') {
    throw new Error('dsh-memory: cfg.home is required by lib/md.js (the memory home was not resolved)');
  }
  return home;
}

function fileDef(key) {
  if (key === 'agent' || key === 'user') return FILES[key];
  throw new Error('dsh-memory: unknown memory file key ' + JSON.stringify(key) + ' (expected "agent" or "user")');
}

function budgetFor(cfg, key) {
  const def = fileDef(key);
  const raw = cfg == null ? undefined : cfg[def.budgetKey];
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(value) && value > 0) return value;
  return DEFAULT_BUDGETS[def.budgetKey];
}

function memoryFilePath(cfg, key) {
  return path.resolve(resolveHome(cfg), fileDef(key).fileName);
}

function percentOf(chars, budget) {
  if (!(budget > 0)) return 0;
  const raw = (chars / budget) * 100;
  const clamped = Math.min(100, Math.max(0, raw));
  return Math.round(clamped * 10) / 10;
}

/** Split file text into trimmed, non-empty entries. */
function parseEntries(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const normalized = text.replace(/\r\n?/g, '\n');
  const out = [];
  for (const chunk of normalized.split(SEPARATOR_LINE)) {
    const trimmed = chunk.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}

/** Join entries with ENTRY_SEP on its own line, ending with a trailing newline. */
function serializeEntries(texts) {
  const cleaned = [];
  for (const raw of texts) {
    const text = typeof raw === 'string' ? raw.trim() : String(raw == null ? '' : raw).trim();
    if (text !== '') cleaned.push(text);
  }
  if (cleaned.length === 0) return '';
  return cleaned.join('\n' + ENTRY_SEP + '\n') + '\n';
}

function buildMemoryFile(cfg, key, exists, texts, mtime) {
  const def = fileDef(key);
  const budget = budgetFor(cfg, key);
  const chars = texts.join(ENTRY_SEP).length;
  return {
    key: def.key,
    label: def.label,
    fileName: def.fileName,
    path: path.resolve(resolveHome(cfg), def.fileName),
    exists,
    available: exists,
    chars,
    budget,
    percent: percentOf(chars, budget),
    mtime: typeof mtime === 'number' && Number.isFinite(mtime) ? mtime : null,
    entries: texts.map((text, index) => ({ index, text })),
    overBudget: chars > budget,
  };
}

/** Windows can refuse a replace-rename while a reader or the AV holds the target. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (!err || !TRANSIENT_RENAME_CODES.has(err.code) || attempt >= 20) {
        if (err && TRANSIENT_RENAME_CODES.has(err.code) && attempt >= 20) {
          await fsp.rm(to, { force: true });
          await fsp.rename(from, to);
          return;
        }
        throw err;
      }
      await delay(Math.min(5 * (attempt + 1), 50));
    }
  }
}

/** Temp file + rename, so readers never observe a partially written file. */
async function writeFileAtomic(filePath, text) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const base = path.basename(filePath);
  const tmp = path.join(dir, '.' + base + '.' + process.pid + '.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.tmp');
  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await renameWithRetry(tmp, filePath);
  } catch (err) {
    try { await fsp.rm(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort advisory lock. Returns null when the lock could not be taken, in which
 * case the caller proceeds anyway (the contract asks for a best-effort lock only).
 */
async function acquireLock(cfg) {
  const home = resolveHome(cfg);
  const lockPath = path.join(home, LOCK_FILE_NAME);
  try { await fsp.mkdir(home, { recursive: true }); } catch { /* best effort */ }
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await fsp.open(lockPath, 'wx');
      try { await handle.writeFile(process.pid + ' ' + new Date().toISOString() + '\n', 'utf8'); } catch { /* best effort */ }
      return { handle, lockPath };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return null;
      try {
        const st = await fsp.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fsp.rm(lockPath, { force: true });
          continue;
        }
      } catch { /* lock vanished, retry */ }
      if (Date.now() >= deadline) return null;
      await delay(LOCK_POLL_MIN_MS + Math.floor(Math.random() * LOCK_POLL_JITTER_MS));
    }
  }
}

async function releaseLock(lock) {
  if (!lock) return;
  try { await lock.handle.close(); } catch { /* best effort */ }
  try { await fsp.rm(lock.lockPath, { force: true }); } catch { /* best effort */ }
}

async function withLock(cfg, fn) {
  const lock = await acquireLock(cfg).catch(() => null);
  try {
    return await fn();
  } finally {
    await releaseLock(lock);
  }
}

export async function readMemoryFile(cfg, key) {
  fileDef(key);
  const filePath = memoryFilePath(cfg, key);
  try {
    const [text, st] = await Promise.all([fsp.readFile(filePath, 'utf8'), fsp.stat(filePath)]);
    return buildMemoryFile(cfg, key, true, parseEntries(text), Math.round(st.mtimeMs));
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return buildMemoryFile(cfg, key, false, [], null);
    }
    throw err;
  }
}

export async function writeMemoryEntries(cfg, key, entries) {
  fileDef(key);
  const filePath = memoryFilePath(cfg, key);
  const list = Array.isArray(entries) ? entries : [];
  const texts = list.map((item) => (item && typeof item === 'object' ? item.text : item));
  await withLock(cfg, async () => {
    await writeFileAtomic(filePath, serializeEntries(texts));
  });
  return readMemoryFile(cfg, key);
}

export async function addMemoryEntry(cfg, key, text) {
  fileDef(key);
  const filePath = memoryFilePath(cfg, key);
  const value = String(text == null ? '' : text).trim();
  await withLock(cfg, async () => {
    if (value === '') return;
    const current = await readMemoryFile(cfg, key);
    const texts = current.entries.map((entry) => entry.text);
    texts.push(value);
    await writeFileAtomic(filePath, serializeEntries(texts));
  });
  return readMemoryFile(cfg, key);
}

export async function removeMemoryEntry(cfg, key, index) {
  fileDef(key);
  const filePath = memoryFilePath(cfg, key);
  const target = Math.trunc(Number(index));
  await withLock(cfg, async () => {
    const current = await readMemoryFile(cfg, key);
    if (!Number.isFinite(target) || target < 0 || target >= current.entries.length) return;
    const texts = current.entries.map((entry) => entry.text);
    texts.splice(target, 1);
    await writeFileAtomic(filePath, serializeEntries(texts));
  });
  return readMemoryFile(cfg, key);
}

export async function overview(cfg) {
  resolveHome(cfg);
  let entries = 0;
  let available = 0;
  for (const key of FILE_KEYS) {
    const file = await readMemoryFile(cfg, key);
    entries += file.entries.length;
    if (file.available) available += 1;
  }
  return { entries, files: FILE_KEYS.length, available };
}
