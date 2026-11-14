/**
 * lib/consolidate.js contract tests — growth, not accumulation.
 *
 * The store only ever appended, so a subject that accumulated six fragments was recalled as
 * six competing lines. Consolidation compresses a group into ONE conclusion and retires the
 * sources. The properties that matter:
 *   - grouping is by subject, never across unrelated categories;
 *   - the conclusion is built from the sources' own words (verifiable, not paraphrased);
 *   - sources are retired, never deleted (history stays answerable);
 *   - running twice does not double the conclusions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  contentWords,
  overlap,
  groupBySubject,
  buildConclusion,
  planConsolidation,
  consolidate,
  MIN_GROUP_SIZE,
  GROUP_SIMILARITY,
  CONSOLIDATE_INFO,
} from '../lib/consolidate.js';

const fact = (over = {}) => ({
  id: 'f1',
  content: 'x',
  category: '环境',
  trust: 0.8,
  archived: 0,
  superseded: 0,
  ...over,
});

/* ------------------------------------------------------------------ grouping */

test('consolidate: facts about one subject group together', () => {
  const facts = [
    fact({ id: 'a', content: 'ComfyUI 的 venv 在 E:\\ComfyUI\\venv' }),
    fact({ id: 'b', content: 'ComfyUI 启动脚本在 E:\\ComfyUI\\启动ComfyUI.bat' }),
    fact({ id: 'c', content: 'ComfyUI 必须跑 bat 不能裸 spawn python' }),
  ];
  const groups = groupBySubject(facts);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].facts.length, 3);
  assert.ok(groups[0].shared.length > 0, 'the shared subject words are identified');
});

test('consolidate: different categories never merge', () => {
  const facts = [
    fact({ id: 'a', category: '环境', content: 'ComfyUI 的 venv 在 E:\\ComfyUI\\venv' }),
    fact({ id: 'b', category: '偏好', content: 'ComfyUI 的 venv 路径我习惯写成绝对路径' }),
  ];
  assert.equal(groupBySubject(facts).length, 0, 'one-fact groups are dropped');
});

test('consolidate: unrelated facts do not group by a stray shared word', () => {
  const facts = [
    fact({ id: 'a', content: '用户技术栈是 Go/Java/Node.js 全栈开发' }),
    fact({ id: 'b', content: '番茄炒蛋要先把鸡蛋炒散再下番茄' }),
  ];
  assert.equal(groupBySubject(facts).length, 0);
});

test('consolidate: archived and superseded facts never join a group', () => {
  const facts = [
    fact({ id: 'a', content: 'ComfyUI 的 venv 在 E:\\ComfyUI\\venv' }),
    fact({ id: 'b', content: 'ComfyUI 的 venv 路径记录', archived: 1 }),
    fact({ id: 'c', content: 'ComfyUI 的 venv 又被记了一遍', superseded: 1 }),
  ];
  const groups = groupBySubject(facts);
  assert.equal(groups.length, 0);
});

test('consolidate: overlap is containment-relative, not Jaccard', () => {
  const short = 'ComfyUI venv 路径';
  const long = 'ComfyUI venv 路径在 E 盘的 ComfyUI 目录下面那个文件夹里';
  // The short text is fully contained, so overlap should be high even though Jaccard is low.
  assert.ok(overlap(short, long) >= GROUP_SIMILARITY);
});

/* ---------------------------------------------------------------- conclusion */

test('consolidate: the conclusion is built from the sources own words', () => {
  const facts = [
    fact({ id: 'a', content: 'ComfyUI 的 venv 在 E:\\ComfyUI\\venv' }),
    fact({ id: 'b', content: 'ComfyUI 启动脚本在 E:\\ComfyUI\\启动ComfyUI.bat' }),
    fact({ id: 'c', content: 'ComfyUI 必须跑 bat 不能裸 spawn python' }),
    fact({ id: 'd', content: 'ComfyUI 的 pause 靠 stdin=ignore 收到 EOF 返回' }),
  ];
  const group = groupBySubject(facts)[0];
  const text = buildConclusion(group);
  assert.ok(text.length > 20);
  // Every source's distinctive content should be traceable in the conclusion.
  assert.match(text, /venv/);
  assert.match(text, /bat/);
  assert.match(text, /pause/);
  // And it must be a single statement, not the raw list.
  assert.ok(!text.includes('\n'));
});

test('consolidate: a conclusion respects its length budget', () => {
  const long = 'ComfyUI 的显存分配参数'.repeat(60);
  const facts = [
    fact({ id: 'a', content: long }),
    fact({ id: 'b', content: long + '甲' }),
    fact({ id: 'c', content: long + '乙' }),
    fact({ id: 'd', content: long + '丙' }),
  ];
  const group = groupBySubject(facts)[0];
  const text = buildConclusion(group);
  assert.ok(text.length <= CONSOLIDATE_INFO.maxConclusion + 10, `too long: ${text.length}`);
});

test('consolidate: a statement fully contained in another is not repeated', () => {
  const facts = [
    fact({ id: 'a', content: 'ComfyUI venv 在 E 盘' }),
    fact({ id: 'b', content: 'ComfyUI venv 在 E 盘，而且必须用 bat 启动' }),
    fact({ id: 'c', content: 'ComfyUI venv 在 E 盘，而且必须用 bat 启动，别再裸跑了' }),
    fact({ id: 'd', content: 'ComfyUI venv 在 E 盘，而且必须用 bat 启动，别再裸跑了，会静默退出' }),
  ];
  const group = groupBySubject(facts)[0];
  const text = buildConclusion(group);
  const occurrences = (text.match(/ComfyUI venv 在 E 盘/g) ?? []).length;
  assert.equal(occurrences, 1, 'the shortest redundant fragment is dropped');
});

/* --------------------------------------------------------------------- plans */

test('consolidate: a group below the threshold is not planned', () => {
  const facts = Array.from({ length: MIN_GROUP_SIZE - 1 }, (_, i) =>
    fact({ id: 'f' + i, content: `ComfyUI venv 在 E 盘的第 ${i} 条记录` }));
  assert.deepEqual(planConsolidation(facts), []);
});

test('consolidate: a large group is planned with its sources listed', () => {
  const facts = Array.from({ length: MIN_GROUP_SIZE + 1 }, (_, i) =>
    fact({ id: 'f' + i, content: `ComfyUI venv 在 E 盘的第 ${i} 条相关记录` }));
  const plans = planConsolidation(facts);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].sourceCount, MIN_GROUP_SIZE + 1);
  assert.equal(plans[0].sources.length, MIN_GROUP_SIZE + 1);
});

test('consolidate: the same sources produce the same signature (idempotence)', () => {
  const facts = Array.from({ length: 5 }, (_, i) =>
    fact({ id: 'f' + i, content: `ComfyUI venv 在 E 盘的第 ${i} 条相关记录` }));
  const a = planConsolidation(facts)[0];
  const b = planConsolidation([...facts].reverse())[0];
  assert.equal(a.signature, b.signature);
});

/* ------------------------------------------------------------------ execute */

function makeStore() {
  const written = [];
  const retired = [];
  const edges = [];
  return {
    written, retired, edges,
    async upsertFact(i) { written.push(i); return { id: 'concl' + written.length, ...i }; },
    async setFactSuperseded(id, flag, by) { retired.push({ id, by }); return {}; },
    async addEdge(a, b, type) { edges.push({ a, b, type }); return {}; },
  };
}

test('consolidate: execute writes a conclusion and retires every source', async () => {
  const store = makeStore();
  const facts = Array.from({ length: 5 }, (_, i) =>
    fact({ id: 'f' + i, content: `ComfyUI venv 在 E 盘的第 ${i} 条相关记录` }));

  const res = await consolidate({ store, facts, logger: {} });
  assert.equal(res.consolidated, 1);
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0].source, 'consolidation');
  assert.equal(store.written[0].trust, 0.75);
  assert.equal(res.retired, 5, 'every source is retired');
  // Sources are retired, never deleted — that is the whole point.
  assert.equal(store.retired.length, 5);
  assert.ok(store.edges.every((e) => e.type === 'consolidates'));
});

test('consolidate: nothing to consolidate is a clean no-op', async () => {
  const store = makeStore();
  const res = await consolidate({ store, facts: [], logger: {} });
  assert.equal(res.consolidated, 0);
  assert.equal(store.written.length, 0);
});

test('consolidate: a store without supersede support is skipped, not crashed', async () => {
  const store = { async upsertFact() { return { id: 'x' }; } };
  const res = await consolidate({ store, facts: [fact()], logger: {} });
  assert.equal(res.consolidated, 0);
});

test('consolidate: a missing store degrades quietly', async () => {
  const res = await consolidate({ store: null, facts: [] });
  assert.equal(res.consolidated, 0);
});

test('consolidate: contentWords drops stop words', () => {
  const words = contentWords('ComfyUI 的 venv 在 the E 盘');
  assert.ok(!words.includes('的'));
  assert.ok(!words.includes('the'));
});

test('consolidate: CONSOLIDATE_INFO exposes the thresholds', () => {
  assert.equal(CONSOLIDATE_INFO.minGroupSize, MIN_GROUP_SIZE);
  assert.equal(CONSOLIDATE_INFO.groupSimilarity, GROUP_SIMILARITY);
});
