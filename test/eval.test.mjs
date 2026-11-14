/**
 * lib/eval.js contract tests — a benchmark that cannot lie about itself.
 *
 * The failure these guard against is the one that nearly shipped: a literal query built by
 * joining two non-adjacent words from a fact scored 0/11 because the store matches
 * substrings, and the report then said "the retriever is broken" when it was the FIXTURE
 * that was broken. A benchmark must fail loudly on its own defects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUERY_KINDS,
  validateFixture,
  scoreQueries,
  summarize,
  grade,
  buildLiteralQueries,
  buildUnanswerableQueries,
  buildFixture,
  addParaphrase,
  pickContiguousSlice,
  EVAL_INFO,
} from '../lib/eval.js';

/* ---------------------------------------------------------------- validation */

test('eval: a malformed fixture fails loudly instead of silently skipping rows', () => {
  const { ok, errors } = validateFixture({ queries: [{ q: '', kind: 'literal' }] });
  assert.equal(ok, false);
  assert.ok(errors.length > 0);
});

test('eval: an answerable query must name what answers it', () => {
  const { ok, errors } = validateFixture({
    queries: [{ q: 'something', kind: 'paraphrase', expectIds: [] }],
  });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /expectIds/);
});

test('eval: an unanswerable query must NOT list expected ids', () => {
  const { ok, errors } = validateFixture({
    queries: [{ q: 'nothing answers this', kind: 'unanswerable', expectIds: ['f1'] }],
  });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /unanswerable/);
});

test('eval: an unknown kind is rejected, not coerced', () => {
  const { ok } = validateFixture({ queries: [{ q: 'x', kind: 'vibes', expectIds: ['f1'] }] });
  assert.equal(ok, false);
});

test('eval: a well-formed fixture validates', () => {
  const { ok, queries } = validateFixture({
    queries: [
      { q: 'literal q', kind: 'literal', expectIds: ['f1'] },
      { q: 'para q', kind: 'paraphrase', expectIds: ['f2'] },
      { q: 'unknown q', kind: 'unanswerable', expectIds: [] },
    ],
  });
  assert.equal(ok, true);
  assert.equal(queries.length, 3);
});

/* ------------------------------------------------------------------ scoring */

test('eval: scoring separates the three kinds', async () => {
  const queries = [
    { q: 'exact', kind: 'literal', expectIds: ['a'] },
    { q: 'rewritten', kind: 'paraphrase', expectIds: ['b'] },
    { q: 'nothing', kind: 'unanswerable', expectIds: [] },
  ];
  const report = await scoreQueries(queries, async (q) => {
    if (q === 'exact') return { facts: [{ id: 'a' }], status: 'direct' };
    if (q === 'rewritten') return { facts: [{ id: 'b' }], status: 'direct' };
    return { facts: [], status: 'none' };
  }, { k: 5 });

  assert.equal(report.byKind.literal[`recall@5`], 1);
  assert.equal(report.byKind.paraphrase[`recall@5`], 1);
  assert.equal(report.byKind.unanswerable.refusalRate, 1);
});

test('eval: an unanswerable query that returns facts is not a refusal', async () => {
  const report = await scoreQueries(
    [{ q: 'nothing', kind: 'unanswerable', expectIds: [] }],
    async () => ({ facts: [{ id: 'x' }], status: 'direct' }),
    { k: 5 },
  );
  assert.equal(report.byKind.unanswerable.refusalRate, 0);
  assert.equal(report.byKind.unanswerable.confidentWrong, 1);
});

test('eval: a near miss labelled related is recorded as soft, not confident-wrong', async () => {
  const report = await scoreQueries(
    [{ q: 'nothing', kind: 'unanswerable', expectIds: [] }],
    async () => ({ facts: [{ id: 'x' }], status: 'related' }),
    { k: 5 },
  );
  assert.equal(report.byKind.unanswerable.softMisses, 1);
  assert.equal(report.byKind.unanswerable.confidentWrong, 0);
});

test('eval: ranking beyond k counts as late, not a hit', async () => {
  const facts = Array.from({ length: 8 }, (_, i) => ({ id: 'f' + i }));
  const report = await scoreQueries(
    [{ q: 'q', kind: 'paraphrase', expectIds: ['f7'] }],
    async () => ({ facts, status: 'direct' }),
    { k: 5 },
  );
  assert.equal(report.byKind.paraphrase[`recall@5`], 0);
  assert.equal(report.byKind.paraphrase.foundButLate, 1);
  assert.equal(report.byKind.paraphrase.mrr, round(1 / 8));
});

test('eval: a throwing query is recorded as an error, not a silent miss', async () => {
  const report = await scoreQueries(
    [{ q: 'boom', kind: 'paraphrase', expectIds: ['a'] }],
    async () => { throw new Error('store down'); },
    { k: 5 },
  );
  assert.equal(report.overall.errors, 1);
  assert.match(report.rows[0].error, /store down/);
});

function round(n) { return Math.round(n * 1000) / 1000; }

/* ---------------------------------------------------------------- the grade */

test('eval: literal recall alone never yields a grade', () => {
  assert.equal(grade({ literal: { 'recall@5': 1 } }), 'unmeasured');
});

test('eval: a retriever that answers everything is over-eager, not good', () => {
  assert.equal(grade({
    paraphrase: { 'recall@5': 0.95 },
    unanswerable: { refusalRate: 0.2 },
  }), 'over-eager');
});

test('eval: half the unanswerable probes slipping through is still over-eager', () => {
  // The boundary that nearly shipped as "good": a coin flip is not a pass.
  assert.equal(grade({
    paraphrase: { 'recall@5': 0.9 },
    unanswerable: { refusalRate: 0.5 },
  }), 'over-eager');
});

test('eval: good paraphrase recall with real refusal grades good', () => {
  assert.equal(grade({
    paraphrase: { 'recall@5': 0.85 },
    unanswerable: { refusalRate: 0.9 },
  }), 'good');
});

test('eval: middling paraphrase recall grades fair, low grades poor', () => {
  assert.equal(grade({ paraphrase: { 'recall@5': 0.6 }, unanswerable: { refusalRate: 0.9 } }), 'fair');
  assert.equal(grade({ paraphrase: { 'recall@5': 0.2 }, unanswerable: { refusalRate: 0.9 } }), 'poor');
});

/* ------------------------------------------------------- literal generation */

test('eval: a literal query is always a SUBSTRING of the fact it expects', () => {
  // This is the bug that shipped once: joined non-adjacent words can never match a
  // substring test, so the benchmark measured its own defect.
  const facts = [
    { id: 'f1', content: '启动本机 ComfyUI 必须优先跑安装目录里的启动 .bat，不能裸 spawn python' },
    { id: 'f2', content: 'DSH profile 的 node_modules 由 pnpm@11.28.5 管理' },
  ];
  for (const item of buildLiteralQueries(facts)) {
    const fact = facts.find((f) => f.id === item.expectIds[0]);
    assert.ok(fact.content.includes(item.q), `"${item.q}" is not a substring of ${fact.id}`);
  }
});

test('eval: pickContiguousSlice only returns real substrings', () => {
  const text = 'ComfyUI 必须优先跑安装目录里的启动 .bat 否则静默退出';
  const slice = pickContiguousSlice(text, 18);
  assert.ok(slice.length > 0);
  assert.ok(text.includes(slice));
});

test('eval: a fact too short for a slice is skipped, not faked', () => {
  const got = buildLiteralQueries([{ id: 'f1', content: '短' }]);
  assert.deepEqual(got, []);
});

/* -------------------------------------------------- unanswerable generation */

test('eval: unanswerable probes are built and name no expectation', () => {
  const got = buildUnanswerableQueries({ count: 4 });
  assert.equal(got.length, 4);
  for (const q of got) {
    assert.equal(q.kind, 'unanswerable');
    assert.deepEqual(q.expectIds, []);
    assert.ok(q.q.length > 4);
  }
});

/* ------------------------------------------------------------- fixture build */

test('eval: a built fixture validates cleanly', () => {
  const facts = Array.from({ length: 5 }, (_, i) => ({
    id: 'f' + i,
    content: `第 ${i} 条关于 ComfyUI 启动目录与静默退出的详细记录内容`,
  }));
  const fixture = buildFixture(facts);
  const { ok, errors } = validateFixture(fixture);
  assert.equal(ok, true, errors.join('; '));
  assert.ok(fixture.queries.some((q) => q.kind === 'literal'));
  assert.ok(fixture.queries.some((q) => q.kind === 'unanswerable'));
});

test('eval: addParaphrase appends a hand-written row', () => {
  const fixture = { queries: [] };
  addParaphrase(fixture, { q: '你叫什么', expectIds: ['f1'] });
  assert.equal(fixture.queries.length, 1);
  assert.equal(fixture.queries[0].kind, 'paraphrase');
});

test('eval: addParaphrase ignores an incomplete row rather than corrupting the fixture', () => {
  const fixture = { queries: [] };
  addParaphrase(fixture, { q: '', expectIds: ['f1'] });
  addParaphrase(fixture, { q: 'something', expectIds: [] });
  assert.equal(fixture.queries.length, 0);
});

test('eval: EVAL_INFO lists the kinds', () => {
  assert.deepEqual(EVAL_INFO.kinds, QUERY_KINDS);
  assert.equal(EVAL_INFO.defaultK, 5);
});
