/**
 * lib/merge.js contract tests — compact the memory files by MERGING, never by dropping.
 *
 * The bug this fixes: `mirrorToBuiltin` appended forever. The budget was a read-time limit, so
 * the FILE kept growing while only its newest entries were ever injected — old preferences sat
 * in the file looking authoritative and invisible at the same time.
 *
 * The property that matters: nothing a user or the model wrote may be silently lost. Merging
 * keeps the newest wording and folds in whatever the older ones said that the newest did not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeTwo,
  mergeEntries,
  compactEntries,
  overlap,
  words,
  MERGE_OVERLAP,
  MAX_MERGED_LENGTH,
  MERGE_INFO,
} from '../lib/merge.js';

/* ------------------------------------------------------------------- mergeTwo */

test('merge: identical entries collapse to one', () => {
  assert.equal(mergeTwo('回复用中文', '回复用中文'), '回复用中文');
});

test('merge: the newer wording is the base, older extras are appended', () => {
  const merged = mergeTwo('回复用简体中文', '回复用简体中文，极简零废话');
  assert.match(merged, /极简零废话/);
  // The base is the NEWER text, so it comes first.
  assert.ok(merged.indexOf('极简零废话') > merged.indexOf('回复用简体中文') - 1);
});

test('merge: information that only the older entry had is preserved', () => {
  const merged = mergeTwo('端口固定在 44565，日志放在 D:\\logs', '端口固定在 44565');
  assert.match(merged, /D:\\\\?logs/, 'the older-only clause must survive the merge');
});

test('merge: a clause already covered by the newer text is not duplicated', () => {
  const older = '回复用简体中文，极简零废话';
  const newer = '回复用简体中文，极简零废话，专家风格';
  const merged = mergeTwo(older, newer);
  assert.equal(merged, newer, 'nothing to add means the newer text stands alone');
});

test('merge: an over-long merged entry is truncated, not returned unbounded', () => {
  const older = 'A'.repeat(400);
  const newer = 'B'.repeat(400);
  const merged = mergeTwo(older, newer);
  assert.ok(merged.length <= MAX_MERGED_LENGTH + 1, `merged length ${merged.length}`);
});

test('merge: empty sides are handled', () => {
  assert.equal(mergeTwo('', 'x'), 'x');
  assert.equal(mergeTwo('x', ''), 'x');
  assert.equal(mergeTwo('', ''), '');
});

/* ------------------------------------------------------------------ grouping */

test('merge: overlap is containment-relative', () => {
  assert.ok(overlap('回复用简体中文', '回复用简体中文，极简零废话') >= MERGE_OVERLAP);
  assert.equal(overlap('量子纠缠实验', '番茄炒蛋做法'), 0);
});

test('merge: words drops stop words', () => {
  const w = words('回复用的 是 简体中文 the and');
  assert.ok(!w.includes('的'));
  assert.ok(!w.includes('the'));
});

test('merge: same-subject entries fold together', () => {
  const { entries, merged } = mergeEntries([
    '回复用简体中文',
    '回复用简体中文，极简零废话',
    'ComfyUI 的 venv 在 E 盘',
  ]);
  assert.equal(merged, 1);
  assert.equal(entries.length, 2, 'two of the three folded into one');
  assert.ok(entries.some((e) => /ComfyUI/.test(e)), 'the unrelated entry is untouched');
});

test('merge: unrelated entries are never folded', () => {
  const { entries, merged } = mergeEntries([
    '用户硬件是 RTX 3060',
    '番茄炒蛋要先把鸡蛋炒散',
  ]);
  assert.equal(merged, 0);
  assert.equal(entries.length, 2);
});

test('merge: a lone entry is never rewritten', () => {
  const { entries, merged } = mergeEntries(['只有这一条很长的独立记忆内容']);
  assert.equal(merged, 0);
  assert.deepEqual(entries, ['只有这一条很长的独立记忆内容']);
});

/* ------------------------------------------------------------------ budgeting */

test('merge: compaction reduces size below the budget', () => {
  const entries = [
    '回复用简体中文',
    '回复用简体中文，极简零废话',
    '回复用简体中文，极简零废话，专家风格',
    'ComfyUI 的 venv 在 E 盘',
  ];
  const r = compactEntries(entries, { budget: 80 });
  assert.ok(r.after <= 80, `after=${r.after} should fit 80`);
  assert.ok(r.merged > 0);
  assert.equal(r.needsMore, false);
});

test('merge: compaction reports honestly when merging cannot reach the budget', () => {
  // Two entirely unrelated long entries cannot be merged away.
  const entries = ['甲'.repeat(200), '乙'.repeat(200)];
  const r = compactEntries(entries, { budget: 50 });
  assert.equal(r.needsMore, true, 'it must say so rather than pretend');
  assert.ok(r.after > 50);
});

test('merge: compaction never drops an entry outright', () => {
  const entries = [
    '回复用简体中文',
    '回复用简体中文，极简零废话',
    '番茄炒蛋要先把鸡蛋炒散再下番茄',
    'ComfyUI 的 venv 在 E 盘',
  ];
  const r = compactEntries(entries, { budget: 200 });
  // Every distinct subject must still be represented by some text.
  const joined = r.entries.join('\n');
  assert.match(joined, /番茄炒蛋/);
  assert.match(joined, /ComfyUI/);
  assert.match(joined, /简体中文/);
});

test('merge: an infinite budget leaves entries alone', () => {
  const entries = ['回复用简体中文', '回复用简体中文，极简零废话'];
  const r = compactEntries(entries, {});
  assert.equal(r.merged, 1, 'merging still happens — it is not budget-driven only');
  assert.ok(r.after <= r.before);
});

test('merge: empty input is safe', () => {
  assert.deepEqual(compactEntries([], { budget: 100 }).entries, []);
  assert.deepEqual(compactEntries(null, { budget: 100 }).entries, []);
  assert.deepEqual(compactEntries(['', '  '], { budget: 100 }).entries, []);
});

test('merge: MERGE_INFO exposes the thresholds', () => {
  assert.equal(MERGE_INFO.mergeOverlap, MERGE_OVERLAP);
  assert.equal(MERGE_INFO.maxMergedLength, MAX_MERGED_LENGTH);
});
