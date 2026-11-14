/**
 * lib/failure.js contract tests — "learn from a wall you already hit".
 *
 * The classification rules here were calibrated against this machine's own session log,
 * where 361 tool results held exactly 6 real failures (all one repeated ACL message) and
 * where 66 results merely CONTAINED an error word because a file being read mentioned
 * 错误. That measurement is the reason `isError === true` is the only accepted failure
 * signal and text matching is only used to decide whether a real failure is worth
 * remembering — the tests below pin both halves of that decision.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFailure,
  isAbortFailure,
  normalizeFailure,
  captureFailures,
  FAILURE_INFO,
} from '../lib/failure.js';

const ACL =
  'Error: Windows ACL temp root must be outside the workspace: workspace=C:\\Users\\13264; temp=C:\\Users\\13264\\AppData\\Local\\Temp';

/* --------------------------------------------------------------- abort handling */

test('failure: user aborts and policy denials are never captured', () => {
  const cases = [
    'Error: tool call aborted',
    'AbortError: The operation was aborted',
    'The tool call was cancelled',
    'Permission denied by the user',
    'approval was denied',
    '{"name":"AbortError","code":"ABORTED"}',
  ];
  for (const text of cases) {
    assert.equal(isAbortFailure(text), true, `should be an abort: ${text}`);
    assert.equal(classifyFailure({ tool: 'pwsh', text }).keep, false, `must not keep: ${text}`);
  }
});

/* ------------------------------------------------------------- durable failures */

test('failure: the real ACL wall is captured with a concrete lesson', () => {
  const verdict = classifyFailure({ tool: 'pwsh', text: ACL });
  assert.equal(verdict.keep, true);
  assert.equal(verdict.category, 'auto:failure');
  assert.equal(verdict.kind, 'env-config');
  assert.match(verdict.content, /^pwsh 失败（env-config）：/);
  assert.match(verdict.content, /ACL temp root/);
});

test('failure: common durable shapes are recognised', () => {
  const cases = [
    ['EPERM: operation not permitted, open \'C:\\x\\y.json\'', 'permission'],
    ['pnpm: command not found', 'missing-binary'],
    ["Cannot find module 'left-pad'", 'missing-dep'],
    ['node script.js [exit code: 1]', 'nonzero-exit'],
    ['Error: connect ETIMEDOUT 1.2.3.4:443', 'timeout'],
    ['Error: listen EADDRINUSE: address already in use 127.0.0.1:44565', 'port-conflict'],
    ['SyntaxError: Unexpected token < in JSON at position 0', 'syntax'],
  ];
  for (const [text, kind] of cases) {
    const verdict = classifyFailure({ tool: 'bash', text });
    assert.equal(verdict.keep, true, `should keep: ${text}`);
    assert.equal(verdict.kind, kind, `wrong kind for: ${text}`);
  }
});

/* -------------------------------------------------------------------- negatives */

test('failure: a bare error word is not a lesson', () => {
  // File contents being read often contain 错误 / "error:" — that is not a failure.
  const noise = [
    'Error: something went wrong',
    'error: see the documentation',
    '失败',
  ];
  for (const text of noise) {
    assert.equal(classifyFailure({ tool: 'read', text }).keep, false, `must not keep: ${text}`);
  }
});

test('failure: empty input is rejected', () => {
  assert.equal(classifyFailure({ tool: 'x', text: '' }).keep, false);
  assert.equal(classifyFailure({}).keep, false);
});

/* ------------------------------------------------------------------ dedup shape */

test('failure: the same wall produces the same signature', () => {
  const a = classifyFailure({ tool: 'pwsh', text: ACL });
  const b = classifyFailure({ tool: 'pwsh', text: ACL + '\n    at Object.<anonymous> (file:///x.js:1:1)' });
  assert.equal(a.signature, b.signature, 'stack frames must not change the signature');
});

test('failure: different tools do not collide', () => {
  const a = classifyFailure({ tool: 'pwsh', text: ACL });
  const b = classifyFailure({ tool: 'bash', text: ACL });
  assert.notEqual(a.signature, b.signature);
});

test('failure: normalization drops stack frames and progress noise', () => {
  const text = 'Error: boom\n    at foo (C:\\a.js:1:1)\n    at bar (C:\\b.js:2:2)\n';
  assert.equal(normalizeFailure(text), 'Error: boom');
});

/* ------------------------------------------------------------------ captureTurn */

function makeMessages({ isError = true, text = ACL, tool = 'pwsh' } = {}) {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', callId: 'call_1', name: tool, input: {} },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'call_1',
      isError,
      source: { kind: 'tool', callId: 'call_1' },
      content: [{ type: 'text', text }],
    },
  ];
}

test('failure: captureFailures writes one fact and reports it', async () => {
  const written = [];
  const store = {
    async upsertFact(input) {
      written.push(input);
      return { id: 'f' + written.length, ...input };
    },
  };
  const got = await captureFailures({ store, messages: makeMessages(), logger: {} });
  assert.equal(got.length, 1);
  assert.equal(written.length, 1);
  assert.equal(written[0].category, 'auto:failure');
  assert.equal(written[0].source, 'auto');
  assert.equal(written[0].trust, 0.55);
  assert.ok(written[0].tags.includes('failure'));
});

test('failure: captureFailures ignores results the runtime did not mark as errors', async () => {
  const written = [];
  const store = { async upsertFact(i) { written.push(i); return { id: 'x', ...i }; } };
  const got = await captureFailures({ store, messages: makeMessages({ isError: false }), logger: {} });
  assert.deepEqual(got, []);
  assert.equal(written.length, 0, 'a successful result must never become a lesson');
});

test('failure: captureFailures respects the per-session skip set', async () => {
  const written = [];
  const store = { async upsertFact(i) { written.push(i); return { id: 'f' + written.length, ...i }; } };
  const skip = new Set();

  const first = await captureFailures({ store, messages: makeMessages(), logger: {}, skip });
  assert.equal(first.length, 1);

  const second = await captureFailures({ store, messages: makeMessages(), logger: {}, skip });
  assert.equal(second.length, 0, 'the same wall is recorded once per session');
  assert.equal(written.length, 1);
});

test('failure: captureFailures resolves the tool name from the tool-call message', async () => {
  let captured = null;
  const store = { async upsertFact(i) { captured = i; return { id: 'f', ...i }; } };
  await captureFailures({ store, messages: makeMessages({ tool: 'comfyui_server' }), logger: {} });
  assert.match(captured.content, /^comfyui_server 失败/);
});

test('failure: a missing store degrades quietly', async () => {
  assert.deepEqual(await captureFailures({ store: null, messages: makeMessages() }), []);
});

test('failure: FAILURE_INFO lists the kinds', () => {
  assert.ok(FAILURE_INFO.kinds.includes('env-config'));
  assert.ok(FAILURE_INFO.kinds.includes('permission'));
  assert.ok(FAILURE_INFO.maxLength > 100);
});
