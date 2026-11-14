/**
 * lib/health.js contract tests — find the memories that are dead weight.
 *
 * A store that is never audited fills with facts nobody asks about, pairs that contradict
 * each other, and near-duplicates. These tests pin the four findings and, importantly, that
 * the audit never deletes anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  auditFacts,
  describeFindings,
  similarity,
  contentWords,
  NEVER_RECALLED_MIN_DAYS,
  DUPLICATE_SIMILARITY,
  HEALTH_INFO,
} from '../lib/health.js';

const DAY = 86400000;
const NOW = Date.now();
const fact = (over = {}) => ({
  id: 'f1',
  content: 'some fact',
  trust: 0.8,
  createdAt: NOW - 100 * DAY,
  accessCount: 0,
  archived: 0,
  superseded: 0,
  permanent: 0,
  ...over,
});

/* ------------------------------------------------------------------ helpers */

test('health: contentWords strips stop words and short tokens', () => {
  const words = contentWords('用户的 DSH 插件在 the default workspace');
  assert.ok(!words.includes('的'));
  assert.ok(!words.includes('the'));
  assert.ok(words.some((w) => w.includes('插件')));
});

test('health: similarity is Jaccard over content words', () => {
  const a = '启动 ComfyUI 必须跑安装目录的 bat 脚本';
  const b = '启动 ComfyUI 必须跑安装目录的 bat 脚本';
  assert.equal(similarity(a, b), 1);
  assert.equal(similarity(a, '完全无关的另一个话题内容'), 0);
});

/* ----------------------------------------------------------------- findings */

test('health: never-recalled facts are reported once they are old enough', () => {
  const facts = [
    fact({ id: 'old', content: '端口固定在 44565 这条从没被问过', createdAt: NOW - 60 * DAY }),
    fact({ id: 'new', content: '刚记下的一条还很新的内容', createdAt: NOW - 2 * DAY }),
    fact({ id: 'used', content: '这条一直被召回所以不算死记忆', createdAt: NOW - 60 * DAY, accessCount: 3 }),
  ];
  const { findings, summary } = auditFacts(facts, [], { now: NOW });
  assert.deepEqual(findings.neverRecalled.map((f) => f.id), ['old']);
  assert.equal(summary.issueCount, 1, 'distinct content means no duplicates muddy the count');
  assert.equal(summary.healthy, false);
});

test('health: a fresh fact is not accused of being dead weight', () => {
  const { findings } = auditFacts([fact({ content: '今天刚记的一条新事实内容', createdAt: NOW - 1 * DAY })], [], { now: NOW });
  assert.deepEqual(findings.neverRecalled, [], 'a one-day-old fact has not had a chance');
});

test('health: contradictions are reported, and both-live is flagged as the defect', () => {
  const facts = [
    fact({ id: 'old', createdAt: NOW - 5 * DAY, accessCount: 2 }),
    fact({ id: 'new', createdAt: NOW - 1 * DAY, accessCount: 2 }),
  ];
  const edgesBothLive = [{ type: 'contradicts', fromId: 'old', toId: 'new' }];
  const live = auditFacts(facts, edgesBothLive, { now: NOW });
  assert.equal(live.findings.contradictions.length, 1);
  assert.equal(live.findings.contradictions[0].bothLive, true);

  // Once the old one is retired the contradiction is resolved.
  const resolved = auditFacts(
    [fact({ id: 'old', superseded: 1, createdAt: NOW - 5 * DAY }), fact({ id: 'new', createdAt: NOW - 1 * DAY })],
    edgesBothLive,
    { now: NOW },
  );
  assert.equal(resolved.findings.contradictions[0].bothLive, false);
});

test('health: near-duplicates are detected, unrelated facts are not', () => {
  const facts = [
    fact({ id: 'a', content: '用户的助手名字叫小智，希望像人一样自然聊天', accessCount: 1 }),
    fact({ id: 'b', content: '用户的助手名字叫小智，希望像人一样自然聊天。', accessCount: 1 }),
    fact({ id: 'c', content: 'ComfyUI 的 venv 在 E:\\ComfyUI\\venv', accessCount: 1 }),
  ];
  const { findings } = auditFacts(facts, [], { now: NOW });
  assert.equal(findings.nearDuplicates.length, 1);
  const [dup] = findings.nearDuplicates;
  assert.deepEqual([dup.a, dup.b].sort(), ['a', 'b']);
  assert.ok(dup.similarity >= DUPLICATE_SIMILARITY);
});

test('health: permanent-but-never-recalled is reported', () => {
  const facts = [
    fact({ id: 'p', permanent: 1, createdAt: NOW - 90 * DAY }),
    fact({ id: 'p2', permanent: 1, createdAt: NOW - 90 * DAY, accessCount: 4 }),
  ];
  const { findings } = auditFacts(facts, [], { now: NOW });
  assert.deepEqual(findings.stalePermanent.map((f) => f.id), ['p']);
});

/* ------------------------------------------------------------------- summary */

test('health: archived and superseded facts are counted but not audited as live', () => {
  const facts = [
    fact({ id: 'live', content: '还在生效的一条记忆', accessCount: 2, createdAt: NOW - 5 * DAY }),
    fact({ id: 'arch', content: '已经归档的老记忆内容', archived: 1, createdAt: NOW - 400 * DAY }),
    fact({ id: 'sup', content: '已经被推翻的旧结论内容', superseded: 1, createdAt: NOW - 400 * DAY }),
  ];
  const { summary, findings } = auditFacts(facts, [], { now: NOW });
  assert.equal(summary.total, 3);
  assert.equal(summary.live, 1);
  assert.equal(summary.archived, 1);
  assert.equal(summary.superseded, 1);
  assert.deepEqual(findings.neverRecalled, [], 'retired facts are not dead weight, they are retired');
});

test('health: a clean store reports healthy', () => {
  const facts = [fact({ id: 'ok', content: '一条被反复用到的有效记忆', accessCount: 5, createdAt: NOW - 10 * DAY })];
  const audit = auditFacts(facts, [], { now: NOW });
  assert.equal(audit.summary.healthy, true);
  assert.equal(audit.summary.issueCount, 0);
  assert.equal(describeFindings(audit), '');
});

test('health: the description names every issue type present', () => {
  const facts = [
    fact({ id: 'dead', createdAt: NOW - 100 * DAY }),
    fact({ id: 'dupA', content: '同一句话重复了一次又一次', accessCount: 2 }),
    fact({ id: 'dupB', content: '同一句话重复了一次又一次', accessCount: 2 }),
    fact({ id: 'perm', permanent: 1, createdAt: NOW - 100 * DAY }),
  ];
  const audit = auditFacts(facts, [], { now: NOW });
  const text = describeFindings(audit);
  assert.match(text, /未被召回/);
  assert.match(text, /近似重复/);
  assert.match(text, /永久标记/);
});

/* ---------------------------------------------------------------------- pure */

test('health: the audit never mutates its input', () => {
  const facts = [fact({ id: 'x' })];
  const snapshot = JSON.stringify(facts);
  auditFacts(facts, [], { now: NOW });
  assert.equal(JSON.stringify(facts), snapshot, 'auditing must be read-only');
});

test('health: empty input is healthy, not an error', () => {
  const audit = auditFacts([], [], { now: NOW });
  assert.equal(audit.summary.total, 0);
  assert.equal(audit.summary.healthy, true);
  assert.deepEqual(auditFacts(null, null).findings.neverRecalled, []);
});

test('health: HEALTH_INFO exposes the thresholds', () => {
  assert.equal(HEALTH_INFO.neverRecalledMinDays, NEVER_RECALLED_MIN_DAYS);
  assert.equal(HEALTH_INFO.duplicateSimilarity, DUPLICATE_SIMILARITY);
});
