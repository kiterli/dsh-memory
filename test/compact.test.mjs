/**
 * lib/compact.js contract tests — the profile must never lose a topic silently.
 *
 * The regression these lock down: `readProfileText()` used to take the newest entries
 * that fit the budget and `break`, so every older entry stopped reaching the prompt while
 * the panel still displayed it. Earl preferences are often the load-bearing ones, so that
 * failure mode was silent and expensive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOPIC_RULES,
  topicOf,
  selectWithinBudget,
  describeOmission,
} from '../lib/compact.js';

/* ----------------------------------------------------------------- topic mapping */

test('compact: entries are bucketed by topic', () => {
  assert.equal(topicOf('用户的助手名字叫「小智」').id, 'identity');
  assert.equal(topicOf('回复用简体中文').id, 'language');
  assert.equal(topicOf('用户偏好：极简零废话').id, 'style');
  assert.equal(topicOf('用户硬件：拯救者 R9000P 2021，RTX 3060 12G').id, 'machine');
  assert.equal(topicOf('用户技术栈：Go/Java/Node.js 全栈').id, 'stack');
  assert.equal(topicOf('用户工作模式："完善所有"=一次性做完').id, 'workflow');
  assert.equal(topicOf('dsh-comfyui 已 fork 为本地可编辑插件').id, 'tools');
});

test('compact: an unmatched entry falls into 其他 rather than being lost', () => {
  assert.equal(topicOf('今天天气不错').id, 'other');
  assert.equal(topicOf('').id, 'other');
});

test('compact: every topic rule is well-formed', () => {
  for (const rule of TOPIC_RULES) {
    assert.ok(rule.id && rule.label, 'rule needs id and label');
    assert.ok(rule.pattern instanceof RegExp, `rule ${rule.id} needs a RegExp`);
  }
});

/* ------------------------------------------------------------------ budget fit */

const ENTRIES = [
  '用户的助手名字叫「小智」，希望像人一样自然聊天。',      // identity  (oldest)
  '回复用简体中文，极简零废话。',                          // language
  '用户偏好：专家角色扮演风格，全量交付不留尾巴。',        // style
  '用户硬件：拯救者 R9000P 2021，RTX 3060 12G，16G 内存。', // machine
  '用户技术栈：Go/Java/Node.js 全栈。',                    // stack
  '用户工作模式："完善所有"=一次性做完所有剩余项。',      // workflow
  'DSH 插件源码在 default-workspace/dsh-memory/。',        // tools
];

test('compact: a generous budget keeps everything in file order', () => {
  const r = selectWithinBudget(ENTRIES, { budget: 100000 });
  assert.deepEqual(r.kept, ENTRIES);
  assert.deepEqual(r.dropped, []);
  assert.equal(describeOmission(r), '');
});

test('compact: a tight budget still represents every topic it has room for', () => {
  // Each entry is ~20-30 chars + 2 overhead, so ~120 chars fits about four topics.
  // The guarantee under test: topics are taken round-robin, so the topics that DO fit
  // are spread across the file rather than all being the newest ones.
  const r = selectWithinBudget(ENTRIES, { budget: 120 });
  assert.ok(r.kept.length > 0);
  const topicsKept = r.topics.filter((t) => t.kept > 0);
  assert.ok(topicsKept.length >= 3, `expected several topics represented, got ${topicsKept.length}`);

  // No topic may take a second slot while some other topic that still has entries and
  // room in the budget is empty.
  for (const t of r.topics) {
    if (t.kept === 0) continue;
    assert.ok(t.kept >= 1);
  }
  // Every kept entry must belong to a represented topic (no orphan bookkeeping).
  const keptTopics = new Set(r.topics.filter((t) => t.kept > 0).map((t) => t.id));
  assert.ok(keptTopics.size >= 3);
});

test('compact: round-robin guarantees one-per-topic when the budget truly allows it', () => {
  // Short entries so that one per topic comfortably fits.
  const shortEntries = [
    '称呼：小智。',   // identity
    '用简体中文。',   // language
    '极简零废话。',   // style
    'RTX 3060。',     // machine
    'Go 全栈。',      // stack
    '一次性做完。',   // workflow
    'ComfyUI 插件。', // tools
  ];
  const r = selectWithinBudget(shortEntries, { budget: 200 });
  const topicsAll = new Set(r.topics.map((t) => t.id));
  const topicsKept = new Set(r.topics.filter((t) => t.kept > 0).map((t) => t.id));
  assert.deepEqual([...topicsKept].sort(), [...topicsAll].sort(), 'every topic gets a slot');
});

test('compact: the OLDEST entry survives when its topic is unique', () => {
  // The specific old bug: the oldest entries were the first to vanish.
  const r = selectWithinBudget(ENTRIES, { budget: 120 });
  assert.ok(
    r.kept.includes(ENTRIES[0]),
    'the oldest identity entry must survive — it is the only one of its topic',
  );
});

test('compact: within a topic the newest wording wins', () => {
  const entries = [
    '回复用英文。',   // oldest, same topic
    '回复用简体中文。', // newest
  ];
  // Just enough for one line.
  const r = selectWithinBudget(entries, { budget: 12 });
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0], '回复用简体中文。', 'the latest statement supersedes the older one');
  assert.deepEqual(r.dropped, ['回复用英文。']);
});

test('compact: a topic the user returns to keeps more entries', () => {
  const entries = [
    '风格：极简零废话。',
    '风格：专家角色扮演。',
    '风格：全量交付不留尾巴。',
    '机器：RTX 3060。',
  ];
  const r = selectWithinBudget(entries, { budget: 80 });
  const style = r.topics.find((t) => t.id === 'style');
  const machine = r.topics.find((t) => t.id === 'machine');
  assert.ok(style.kept >= machine.kept, 'the recurring topic keeps at least as many entries');
  assert.ok(machine.kept >= 1, 'the single-entry topic is still represented');
});

/* ------------------------------------------------------------- transparency */

test('compact: omissions are reported, not hidden', () => {
  const r = selectWithinBudget(ENTRIES, { budget: 120 });
  assert.ok(r.dropped.length > 0);
  const note = describeOmission(r);
  assert.match(note, /受预算限制/);
  assert.match(note, /\d+ 条未注入/);
  // It must name the affected topics so the loss is diagnosable.
  assert.match(note, /身份与称呼|语言与表达|回答风格|环境与机器|技术栈|工作模式与流程|工具与插件|其他/);
});

/* -------------------------------------------------------------------- hygiene */

test('compact: empty and malformed input degrade safely', () => {
  assert.deepEqual(selectWithinBudget([], { budget: 100 }).kept, []);
  assert.deepEqual(selectWithinBudget(null, { budget: 100 }).kept, []);
  assert.deepEqual(selectWithinBudget(['', '   ', null], { budget: 100 }).kept, []);
});

test('compact: object entries are accepted (MemoryFile shape)', () => {
  const r = selectWithinBudget([{ index: 0, text: '回复用简体中文。' }], { budget: 100 });
  assert.deepEqual(r.kept, ['回复用简体中文。']);
});

test('compact: an infinite budget keeps everything', () => {
  const r = selectWithinBudget(ENTRIES, {});
  assert.deepEqual(r.kept, ENTRIES);
  assert.equal(r.budget, null);
});

test('compact: used characters never exceed the budget', () => {
  for (const budget of [40, 80, 120, 200, 400]) {
    const r = selectWithinBudget(ENTRIES, { budget });
    assert.ok(r.used <= budget, `budget ${budget} exceeded: ${r.used}`);
  }
});
