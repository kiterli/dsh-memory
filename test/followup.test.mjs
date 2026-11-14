/**
 * lib/followup.js contract tests — remembering what is UNFINISHED.
 *
 * This is the one behaviour in the plugin about the future rather than the past. The risk is
 * symmetric: inventing an obligation ("上次那个…" about something the user never asked for) is
 * as annoying as never asking at all. So the negative cases here matter as much as the positive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectFollowup,
  shouldRaise,
  followupLine,
  createFollowupQueue,
  MAX_AGE_DAYS,
  FOLLOWUP_INFO,
} from '../lib/followup.js';

/* ------------------------------------------------------------------ detection */

test('followup: "先做到这里" opens an obligation', () => {
  const d = detectFollowup('今天先做到这里，明天把记忆模块收尾');
  assert.equal(d.action, 'open');
  // The topic is the trailing clause, not the signal word.
  assert.match(d.topic, /记忆模块收尾/);
});

test('followup: "还没做完" opens one and the topic is what follows', () => {
  const d = detectFollowup('还没做完，下次接着弄召回评测这条');
  assert.equal(d.action, 'open');
  assert.match(d.topic, /召回评测/);
});

test('followup: an explicit continue opens one', () => {
  const d = detectFollowup('继续做面板可编辑那块');
  assert.equal(d.action, 'open');
  assert.equal(d.topic, '面板可编辑那块');
});

test('followup: a TODO marker opens one', () => {
  const d = detectFollowup('待办：把 merge 模块接进 mirrorToBuiltin');
  assert.equal(d.action, 'open');
  assert.match(d.topic, /merge/);
});

test('followup: "做完了" closes one', () => {
  assert.equal(detectFollowup('这个功能做完了').action, 'close');
  assert.equal(detectFollowup('搞定了').action, 'close');
  assert.equal(detectFollowup('不用了，取消吧').action, 'close');
});

test('followup: a bare "先到这吧" opens a VAGUE obligation rather than nothing', () => {
  const d = detectFollowup('先到这吧');
  assert.equal(d.action, 'open');
  assert.equal(d.topic, null);
  assert.equal(d.vague, true);
});

test('followup: ordinary technical talk opens nothing', () => {
  for (const text of [
    '量子纠缠退相干时间的实验测量',
    '帮我看下这个报错',
    '读一下这个文件',
    '这个函数是干什么的',
  ]) {
    assert.equal(detectFollowup(text), null, `must not invent an obligation from: ${text}`);
  }
});

test('followup: our injected block is never read as the user', () => {
  assert.equal(detectFollowup('[以下是我记得的事情，来自本地记忆]\n- 明天继续做'), null);
});

test('followup: too-short input is ignored', () => {
  assert.equal(detectFollowup('继续'), null);
  assert.equal(detectFollowup(''), null);
});

/* --------------------------------------------------------------------- queue */

test('followup: the queue stores one obligation per topic', () => {
  const q = createFollowupQueue([]);
  q.apply(detectFollowup('继续做面板可编辑那块'), { now: 1000 });
  q.apply(detectFollowup('继续做面板可编辑那块'), { now: 2000 });
  assert.equal(q.all().length, 1, 'the same topic twice is one obligation');
});

test('followup: an obligation is raised exactly once', () => {
  const q = createFollowupQueue([]);
  q.apply(detectFollowup('继续做面板可编辑那块'), { now: 1000 });
  const first = q.take(1000);
  assert.ok(first, 'first take returns it');
  const second = q.take(1000);
  assert.equal(second, null, 'second take finds nothing — raised already');
});

test('followup: closing removes it from being raised', () => {
  const q = createFollowupQueue([]);
  q.apply(detectFollowup('继续做面板可编辑那块'), { now: 1000 });
  q.apply(detectFollowup('做完了'), { now: 2000 });
  assert.equal(q.take(2000), null, 'a closed obligation is not raised');
});

test('followup: expired obligations are pruned', () => {
  const now = Date.now();
  const old = now - (MAX_AGE_DAYS + 1) * 86400000;
  const q = createFollowupQueue([{ topic: 'old thing', createdAt: old, raised: false, closed: false }]);
  assert.equal(q.take(now), null, 'an obligation older than MAX_AGE_DAYS is not raised');
  q.prune(now);
  assert.equal(q.all().length, 0);
});

test('followup: a fresh obligation IS raised', () => {
  const now = Date.now();
  const q = createFollowupQueue([{ topic: '记忆模块收尾', createdAt: now - 86400000, raised: false, closed: false }]);
  const taken = q.take(now);
  assert.ok(taken);
  assert.match(followupLine(taken), /记忆模块收尾/);
});

test('followup: shouldRaise respects closed, raised and age', () => {
  const now = Date.now();
  assert.equal(shouldRaise({ closed: true, createdAt: now }, now), false);
  assert.equal(shouldRaise({ raised: true, createdAt: now }, now), false);
  assert.equal(shouldRaise({ createdAt: now - 100 * 86400000 }, now), false);
  assert.equal(shouldRaise({ createdAt: now }, now), true);
  assert.equal(shouldRaise(null, now), false);
});

test('followup: the line reads like a colleague, not a database', () => {
  const line = followupLine({ topic: '记忆模块收尾' });
  assert.match(line, /记忆模块收尾/);
  assert.match(line, /要不要/);
  // And it must not leak the raw user sentence when a topic exists.
  assert.doesNotMatch(line, /今天先做到这里/);
});

test('followup: a vague obligation still produces a usable line', () => {
  const line = followupLine({ topic: null });
  assert.match(line, /那件事/);
  assert.doesNotMatch(line, /上次上次/, 'no doubled prefix');
});

test('followup: the queue never grows without bound', () => {
  const q = createFollowupQueue([]);
  for (let i = 0; i < 40; i += 1) {
    q.apply({ action: 'open', topic: `第 ${i} 件待办事情`, text: `继续做第 ${i} 件待办`, vague: false }, { now: 1000 + i });
  }
  assert.ok(q.all().length <= 20, `queue grew to ${q.all().length}`);
});

test('followup: apply(null) is safe', () => {
  const q = createFollowupQueue([]);
  assert.equal(q.apply(null), null);
  assert.deepEqual(q.all(), []);
});

test('followup: FOLLOWUP_INFO exposes the policy', () => {
  assert.equal(FOLLOWUP_INFO.maxAgeDays, MAX_AGE_DAYS);
  assert.ok(FOLLOWUP_INFO.openPatterns > 0);
  assert.ok(FOLLOWUP_INFO.closePatterns > 0);
});
