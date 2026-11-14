/**
 * lib/mood.js contract tests — notice how the user sounded, without inventing feelings.
 *
 * A wrong emotion in the prompt is worse than none: telling someone "上次你有点烦" when
 * they were calm is actively irritating. So the negative cases below matter as much as
 * the positive ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectMood, recordMood, MOOD_INFO } from '../lib/mood.js';

/* -------------------------------------------------------------------- positives */

test('mood: frustration is recognised in the ways people actually phrase it', () => {
  for (const text of ['烦死了，又挂了', '这个报错真的很烦', '服了，怎么又失败', '受不了了，太坑了']) {
    const mood = detectMood(text);
    assert.ok(mood, `should detect something in: ${text}`);
    assert.equal(mood.emotion, 'frustrated', `wrong emotion for: ${text}`);
  }
});

test('mood: tiredness is recognised', () => {
  for (const text of ['好累，熬了一晚上', '困死了，没睡好', '撑不住了']) {
    assert.equal(detectMood(text)?.emotion, 'tired', `for: ${text}`);
  }
});

test('mood: relief and success are recognised', () => {
  for (const text of ['太好了，跑通了', '搞定了！', '终于好用']) {
    const mood = detectMood(text);
    assert.ok(mood);
    assert.ok(['happy', 'satisfied'].includes(mood.emotion), `for: ${text} got ${mood.emotion}`);
  }
});

test('mood: urgency raises importance', () => {
  const mood = detectMood('来不及了，赶紧改');
  assert.ok(mood);
  assert.equal(mood.emotion, 'anxious');
});

/* --------------------------------------------------------------- importance only */

test('mood: a calm but consequential turn is recorded without inventing a feeling', () => {
  const mood = detectMood('生产环境已经上线了');
  assert.ok(mood, 'a release should be memorable');
  assert.equal(mood.emotion, 'neutral', 'no feeling is invented');
  assert.ok(mood.importance >= 0.75, 'but importance is high');
  assert.equal(mood.hasFeeling, false);
});

/* --------------------------------------------------------------------- negatives */

test('mood: ordinary technical talk yields nothing', () => {
  const neutral = [
    '帮我看下这个报错',
    '读取这个需求，分析实现',
    '现在什么情况',
    '这个记忆插件有什么优化的地方',
    '接着推进',
    '你好，小智',
  ];
  for (const text of neutral) {
    assert.equal(detectMood(text), null, `must not infer a mood from: ${text}`);
  }
});

test('mood: our own injected memory blocks are never read as the user speaking', () => {
  const injected = '[以下是我记得的事情，来自本地记忆，不是用户刚说的话]\n- 记得，3 天前：用户很烦';
  assert.equal(detectMood(injected), null);
  const legacy = '[dsh-memory context — injected automatically]\n- user is frustrated';
  assert.equal(detectMood(legacy), null);
});

test('mood: empty and very short input is ignored', () => {
  for (const text of ['', '   ', '嗯', '好']) {
    assert.equal(detectMood(text), null, `must not infer a mood from: ${JSON.stringify(text)}`);
  }
});

/* --------------------------------------------------------------------- capture */

const MESSAGES = [
  { role: 'assistant', content: 'ok' },
  { role: 'user', content: '烦死了，又失败了' },
];

test('mood: recordMood writes one event with the detected shape', async () => {
  const events = [];
  const store = { async addEvent(e) { events.push(e); return { id: 'e1', ...e }; } };
  const mood = await recordMood({ store, messages: MESSAGES, logger: {}, sessionId: 's1' });
  assert.ok(mood);
  assert.equal(mood.emotion, 'frustrated');
  assert.equal(events.length, 1);
  assert.equal(events[0].emotion, 'frustrated');
  assert.equal(events[0].sessionId, 's1');
  assert.ok(events[0].content.includes('烦死'));
});

test('mood: recordMood dedupes the same mood+text within a session', async () => {
  const events = [];
  const store = { async addEvent(e) { events.push(e); return { id: 'e' + events.length, ...e }; } };
  const skip = new Set();
  await recordMood({ store, messages: MESSAGES, logger: {}, sessionId: 's1', skip });
  await recordMood({ store, messages: MESSAGES, logger: {}, sessionId: 's1', skip });
  assert.equal(events.length, 1, 'a long rant must not write twenty identical events');
});

test('mood: recordMood does nothing for a neutral turn', async () => {
  const events = [];
  const store = { async addEvent(e) { events.push(e); return { id: 'e', ...e }; } };
  const got = await recordMood({
    store,
    messages: [{ role: 'user', content: '帮我看下这个报错' }],
    logger: {},
    sessionId: 's1',
  });
  assert.equal(got, null);
  assert.equal(events.length, 0);
});

test('mood: recordMood skips injected blocks when picking the last utterance', async () => {
  const events = [];
  const store = { async addEvent(e) { events.push(e); return { id: 'e', ...e }; } };
  const messages = [
    { role: 'user', content: '好累，不想干了' },
    { role: 'user', content: '[以下是我记得的事情，来自本地记忆，不是用户刚说的话]\n- xxx' },
  ];
  const mood = await recordMood({ store, messages, logger: {}, sessionId: 's1' });
  assert.ok(mood);
  assert.ok(events[0].content.includes('好累'));
});

test('mood: a missing store degrades quietly', async () => {
  assert.equal(await recordMood({ store: null, messages: MESSAGES }), null);
});

test('mood: MOOD_INFO lists the emotions the injection knows how to phrase', () => {
  for (const e of ['frustrated', 'tired', 'anxious', 'happy', 'satisfied', 'confused']) {
    assert.ok(MOOD_INFO.emotions.includes(e), `missing emotion: ${e}`);
  }
});
