/**
 * test/md.test.mjs — mem-core. Exercises lib/md.js against temp directories only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ENTRY_SEP,
  FILES,
  readMemoryFile,
  writeMemoryEntries,
  addMemoryEntry,
  removeMemoryEntry,
  overview,
} from '../lib/md.js';

async function makeHome(prefix = 'dsh-md-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function cfgFor(home) {
  return { home, agentBudget: 2200, userBudget: 1375, autoExtract: false };
}

function emptyShape(cfg, key) {
  const def = FILES[key];
  return {
    key,
    label: def.label,
    fileName: def.fileName,
    path: path.resolve(cfg.home, def.fileName),
    exists: false,
    available: false,
    chars: 0,
    budget: cfg[def.budgetKey],
    percent: 0,
    mtime: null,
    entries: [],
    overBudget: false,
  };
}

const SEP = '\n' + ENTRY_SEP + '\n';

test('md: ENTRY_SEP and FILES match the contract', () => {
  assert.equal(ENTRY_SEP, '\u00a7');
  assert.deepEqual(FILES, {
    agent: { key: 'agent', fileName: 'MEMORY.md', label: 'Agent memory', budgetKey: 'agentBudget' },
    user: { key: 'user', fileName: 'USER.md', label: 'User profile', budgetKey: 'userBudget' },
  });
});

test('md: a missing file yields the documented empty shape and creates nothing', async () => {
  const root = await makeHome();
  const home = path.join(root, 'nested', 'memories');
  const cfg = cfgFor(home);

  for (const key of ['agent', 'user']) {
    const file = await readMemoryFile(cfg, key);
    assert.deepEqual(file, emptyShape(cfg, key));
  }
  assert.equal(await fsp.stat(home).then(() => true, () => false), false, 'read must not create the home dir');
});

test('md: readMemoryFile throws a clear error when cfg.home is missing', async () => {
  await assert.rejects(() => readMemoryFile({}, 'agent'), /cfg\.home is required/);
  await assert.rejects(() => overview({}), /cfg\.home is required/);
});

test('md: writeMemoryEntries round-trips with the documented separator format', async () => {
  const home = await makeHome();
  const cfg = cfgFor(home);

  const written = await writeMemoryEntries(cfg, 'agent', ['first entry', 'second entry']);
  assert.equal(written.exists, true);
  assert.equal(written.available, true);
  assert.deepEqual(written.entries, [
    { index: 0, text: 'first entry' },
    { index: 1, text: 'second entry' },
  ]);

  const raw = await fsp.readFile(path.join(home, 'MEMORY.md'), 'utf8');
  assert.equal(raw, 'first entry' + SEP + 'second entry\n');

  const reread = await readMemoryFile(cfg, 'agent');
  assert.deepEqual(reread.entries, written.entries);
  assert.equal(reread.chars, ('first entry' + ENTRY_SEP + 'second entry').length);
});

test('md: parsing trims entries, drops empties and tolerates whitespace/CRLF separators', async () => {
  const home = await makeHome();
  const cfg = cfgFor(home);
  const body = '  alpha  \r\n  ' + ENTRY_SEP + '  \r\n\r\n   ' + ENTRY_SEP + '   \r\nbeta\r\n' + ENTRY_SEP + '\r\n';
  await fsp.writeFile(path.join(home, 'MEMORY.md'), body, 'utf8');

  const file = await readMemoryFile(cfg, 'agent');
  assert.deepEqual(file.entries.map((entry) => entry.text), ['alpha', 'beta']);
  assert.equal(file.exists, true);
});

test('md: chars/percent/overBudget derive from the entries and the cfg budget', async () => {
  const home = await makeHome();
  const cfg = { home, agentBudget: 100, userBudget: 1375 };
  const text = 'x'.repeat(46);
  const file = await writeMemoryEntries(cfg, 'agent', [text]);
  assert.equal(file.chars, 46);
  assert.equal(file.budget, 100);
  assert.equal(file.percent, 46);
  assert.equal(file.overBudget, false);

  const big = await writeMemoryEntries(cfg, 'agent', ['y'.repeat(140)]);
  assert.equal(big.percent, 100, 'percent is clamped to 0..100');
  assert.equal(big.overBudget, true);

  const defaults = await readMemoryFile({ home, userBudget: undefined }, 'user');
  assert.equal(defaults.budget, 1375);
  const agentDefaults = await readMemoryFile({ home }, 'agent');
  assert.equal(agentDefaults.budget, 2200);
});

test('md: addMemoryEntry appends and leaves other entries untouched', async () => {
  const home = await makeHome();
  const cfg = cfgFor(home);
  await writeMemoryEntries(cfg, 'user', ['one']);
  await addMemoryEntry(cfg, 'user', '  two  ');
  const file = await addMemoryEntry(cfg, 'user', 'three');
  assert.deepEqual(file.entries.map((entry) => entry.text), ['one', 'two', 'three']);
  assert.equal(file.fileName, 'USER.md');
});

test('md: addMemoryEntry with blank text does not create the file', async () => {
  const home = await makeHome();
  const cfg = cfgFor(home);
  const file = await addMemoryEntry(cfg, 'agent', '   ');
  assert.equal(file.exists, false);
  assert.equal(await fsp.stat(path.join(home, 'MEMORY.md')).then(() => true, () => false), false);
});

test('md: removeMemoryEntry removes by index and ignores an out-of-range index', async () => {
  const home = await makeHome();
  const cfg = cfgFor(home);
  await writeMemoryEntries(cfg, 'agent', ['a', 'b', 'c']);

  const removed = await removeMemoryEntry(cfg, 'agent', 1);
  assert.deepEqual(removed.entries.map((entry) => entry.text), ['a', 'c']);

  const untouched = await removeMemoryEntry(cfg, 'agent', 9);
  assert.deepEqual(untouched.entries.map((entry) => entry.text), ['a', 'c']);

  const missingHome = await makeHome();
  const missingCfg = cfgFor(missingHome);
  const noop = await removeMemoryEntry(missingCfg, 'agent', 0);
  assert.equal(noop.exists, false);
  assert.equal(await fsp.stat(path.join(missingHome, 'MEMORY.md')).then(() => true, () => false), false);
});

test('md: concurrent addMemoryEntry calls all land', async () => {
  const home = await makeHome();
  const cfg = cfgFor(home);
  const texts = Array.from({ length: 12 }, (_, i) => 'entry-' + i);
  await Promise.all(texts.map((text) => addMemoryEntry(cfg, 'agent', text)));

  const file = await readMemoryFile(cfg, 'agent');
  assert.equal(file.entries.length, texts.length);
  assert.deepEqual([...file.entries.map((entry) => entry.text)].sort(), [...texts].sort());
});

test('md: mtime is a number once the file exists, null before', async () => {
  const home = await makeHome();
  const cfg = cfgFor(home);
  assert.equal((await readMemoryFile(cfg, 'agent')).mtime, null);
  await writeMemoryEntries(cfg, 'agent', ['hello']);
  const file = await readMemoryFile(cfg, 'agent');
  assert.equal(typeof file.mtime, 'number');
  assert.ok(file.mtime > 0);
});

test('md: overview counts entries/files/available across both files', async () => {
  const home = await makeHome();
  const cfg = cfgFor(home);
  assert.deepEqual(await overview(cfg), { entries: 0, files: 2, available: 0 });

  await writeMemoryEntries(cfg, 'agent', ['a', 'b']);
  await writeMemoryEntries(cfg, 'user', ['c']);
  assert.deepEqual(await overview(cfg), { entries: 3, files: 2, available: 2 });
});

test('md: unknown keys are rejected', async () => {
  const home = await makeHome();
  const cfg = cfgFor(home);
  await assert.rejects(() => readMemoryFile(cfg, 'nope'), /unknown memory file key/);
});
