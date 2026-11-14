/**
 * lib/autocapture.js contract tests.
 *
 * The behaviour these lock down is not "captures something" but "captures a COMPLETE,
 * self-contained sentence". An earlier version sliced the text between a pitfall
 * pattern's anchors and produced fragments like
 *
 *     "裸 spawn venv python main.py——缺 activate.bat 设置的环境时进程"
 *
 * which then entered every future prompt as if it were an established fact. A wrong
 * memory is far more expensive than a missing one, so the negative cases below matter
 * as much as the positive ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCandidates,
  splitSentences,
  normalizeCandidate,
  previousUserText,
  CAPTURE_RULES,
} from '../lib/autocapture.js';

/* ------------------------------------------------------------------ positives */

test('autocapture: standing instructions are captured whole', () => {
  const got = extractCandidates('以后都给我简体中文回复，别分步问。');
  assert.equal(got.length, 1);
  assert.equal(got[0].rule, 'standing');
  assert.equal(got[0].category, 'auto:preference');
  assert.equal(got[0].content, '以后都给我简体中文回复，别分步问');
});

test('autocapture: preference statements are captured whole', () => {
  const got = extractCandidates('我一般用 pwsh 而不是 cmd。');
  assert.equal(got.length, 1);
  assert.equal(got[0].rule, 'preference');
  assert.match(got[0].content, /pwsh/);
});

test('autocapture: environment facts are captured whole', () => {
  const got = extractCandidates('端口固定在 44565。');
  assert.equal(got.length, 1);
  assert.equal(got[0].category, 'auto:environment');
  assert.equal(got[0].content, '端口固定在 44565');
});

test('autocapture: corrections keep both sides of the correction', () => {
  const got = extractCandidates('其实不是 44560，而是 24550。');
  assert.equal(got.length, 1);
  assert.equal(got[0].rule, 'correction');
  assert.match(got[0].content, /44560/);
  assert.match(got[0].content, /24550/);
});

test('autocapture: a pitfall yields the WHOLE sentence, not the fragment between anchors', () => {
  const sentence =
    '启动本机 ComfyUI 必须优先跑安装目录里的启动 .bat，不能裸 spawn venv python main.py——缺 activate.bat 设置的环境时进程会在导入自定义节点阶段静默退出。';
  const got = extractCandidates(sentence);
  assert.equal(got.length, 1);
  assert.equal(got[0].category, 'auto:pitfall');
  // Whole sentence, minus the trailing full stop.
  assert.equal(got[0].content, sentence.replace(/。$/, ''));
  // And specifically NOT the old fragment shape.
  assert.doesNotMatch(got[0].content, /^裸 spawn/);
  assert.match(got[0].content, /^启动本机 ComfyUI 必须/);
});

test('autocapture: an explicit "remember" keeps only what follows the marker', () => {
  const got = extractCandidates('记住：ComfyUI 的 venv 在 E:\\ComfyUI\\venv。');
  assert.equal(got.length, 1);
  assert.equal(got[0].rule, 'explicit');
  assert.equal(got[0].trust, 0.8);
  assert.equal(got[0].content, 'ComfyUI 的 venv 在 E:\\ComfyUI\\venv');
});

/* ------------------------------------------------------------------ negatives */

test('autocapture: ordinary questions and filler are not captured', () => {
  for (const text of ['这个功能怎么用？', '好的。', '然后呢', '帮我看下这个报错', '嗯']) {
    assert.deepEqual(extractCandidates(text), [], `should not capture: ${text}`);
  }
});

test('autocapture: credentials are never captured', () => {
  const cases = [
    '我的 api key 是 sk-abcdefghijklmnopqrstuvwxyz123456',
    '令牌 token = ghp_abcdefghijklmnopqrstuvwx1234',
    '密码： hunter2secret',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6',
  ];
  for (const text of cases) {
    assert.deepEqual(extractCandidates(text), [], `must not capture a secret: ${text}`);
  }
});

test('autocapture: a plain descriptive sentence with no durability marker is skipped', () => {
  const text = 'dsh-comfyui 已 fork 为本地可编辑插件，源码在 default-workspace/dsh-comfyui/。';
  assert.deepEqual(extractCandidates(text), []);
});

test('autocapture: fragments that end mid-clause are rejected', () => {
  // Guards the specific regression: a sentence cap that cuts "…时进程" / "…的".
  const got = extractCandidates('注意千万' + '别'.repeat(1) + 'x'.repeat(300));
  assert.deepEqual(got, []);
});

test('autocapture: the same sentence is not captured twice', () => {
  const text = '端口固定在 44565。端口固定在 44565。';
  const got = extractCandidates(text);
  assert.equal(got.length, 1, 'duplicate sentence collapses to one candidate');
});

/* ------------------------------------------------------------------- helpers */

test('autocapture: splitSentences splits on CJK and Latin punctuation', () => {
  const parts = splitSentences('第一句。第二句！第三句？第四句\n第五句');
  assert.ok(parts.length >= 4);
  assert.equal(parts[0], '第一句。');
});

test('autocapture: normalizeCandidate strips bullets, whitespace and trailing stops', () => {
  assert.equal(normalizeCandidate('  - 端口固定在   44565。 '), '端口固定在 44565');
  assert.equal(normalizeCandidate('1. 我一般用 pwsh.'), '我一般用 pwsh');
});

test('autocapture: previousUserText picks the PREVIOUS turn and skips injected blocks', () => {
  const messages = [
    { role: 'user', content: '第一轮：以后都给我中文回复。' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '[以下是我记得的事情，来自本地记忆，不是用户刚说的话]\n- 记得，3 天前：xxx' },
    { role: 'user', content: '第二轮：这个怎么用？' },
  ];
  assert.equal(previousUserText(messages), '第一轮：以后都给我中文回复。');
  // Only one real user turn so far -> nothing "previous" to scan yet.
  assert.equal(previousUserText([{ role: 'user', content: '只有一轮' }]), '');
  assert.equal(previousUserText([]), '');
});

test('autocapture: every rule declares the shape the store expects', () => {
  for (const rule of CAPTURE_RULES) {
    assert.ok(rule.category.startsWith('auto:'), `${rule.id} category must be namespaced`);
    assert.ok(rule.trust > 0 && rule.trust <= 1, `${rule.id} trust must be in (0,1]`);
    assert.ok(rule.pattern instanceof RegExp, `${rule.id} needs a RegExp`);
  }
});
