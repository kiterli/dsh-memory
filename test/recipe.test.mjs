/**
 * lib/recipe.js contract tests — remember what WORKED, not only what broke.
 *
 * The risk here is noise: "we edited three files" is not a recipe. These tests pin the
 * three conditions (multiple successful actions, no failure, concrete specifics) and,
 * just as importantly, the rejections.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRecipe,
  extractSpecifics,
  normalizeRecipe,
  captureRecipe,
  RECIPE_INFO,
  MIN_STEPS,
} from '../lib/recipe.js';

const call = (name, args = {}, extra = {}) => ({ name, args, ...extra });

/* ---------------------------------------------------------------- specifics */

test('recipe: model file names are extracted as specifics', () => {
  const got = extractSpecifics([call('comfyui_run', { unet: 'qwen_image_2.1_int8_convrot.safetensors' })]);
  assert.ok(got.some((s) => s.includes('qwen_image_2.1_int8_convrot.safetensors')));
});

test('recipe: windows paths are extracted', () => {
  const got = extractSpecifics([call('pwsh', { command: 'cd E:\\ComfyUI && dir' })]);
  // Extraction runs over the JSON form of the arguments, so the snippet carries escaped
  // backslashes; match on the drive-relative shape rather than the exact literal.
  assert.ok(got.some((s) => /E:\\\\?ComfyUI/.test(s)), `got: ${JSON.stringify(got)}`);
});

test('recipe: key=value settings are extracted as a group', () => {
  const got = extractSpecifics([call('bash', { cmd: 'steps=28 cfg=2.5 sampler=euler' })]);
  assert.ok(got.length > 0, 'should find at least one concrete setting');
});

test('recipe: a call with no specifics yields none', () => {
  const got = extractSpecifics([call('write', { path: '/a/b.md', content: 'nothing special here' })]);
  assert.deepEqual(got, []);
});

test('recipe: specifics are deduplicated', () => {
  const args = { model: 'abc.safetensors' };
  const got = extractSpecifics([call('a', args), call('b', args)]);
  assert.equal(got.length, 1);
});

/* --------------------------------------------------------------- classifier */

test('recipe: a two-step successful run with specifics is kept', () => {
  const verdict = classifyRecipe({
    calls: [
      call('pwsh', { command: 'python run.py --model abc.safetensors --steps 28' }),
      call('write', { path: 'C:\\out\\result.json', content: '{}' }),
    ],
  });
  assert.equal(verdict.keep, true);
  assert.equal(verdict.category, 'auto:recipe');
  assert.ok(verdict.content.length > 20);
});

test('recipe: a single action is not a procedure', () => {
  const verdict = classifyRecipe({
    calls: [call('pwsh', { command: 'node x.js --flag 1 --other 2' })],
  });
  assert.equal(verdict.keep, false);
  assert.equal(verdict.reason, 'too-few-steps');
});

test('recipe: a turn that had a failure is not a clean recipe', () => {
  const verdict = classifyRecipe({
    calls: [
      call('pwsh', { command: 'a --x 1 --y 2' }),
      call('pwsh', { command: 'b --x 1 --y 2' }, { isError: true }),
    ],
  });
  assert.equal(verdict.keep, false);
  assert.equal(verdict.reason, 'had-failure');
});

test('recipe: evidence-gathering reads do not count as steps', () => {
  const verdict = classifyRecipe({
    calls: [
      call('read', { path: 'C:\\a\\b.js' }),
      call('grep', { pattern: 'x' }),
      call('glob', { pattern: '*.md' }),
    ],
  });
  assert.equal(verdict.keep, false);
  assert.ok(['too-few-steps', 'no-specifics'].includes(verdict.reason));
});

test('recipe: actions without concrete specifics are rejected', () => {
  const verdict = classifyRecipe({
    calls: [call('write', { path: '/x/y', content: 'hi' }), call('write', { path: '/x/z', content: 'hi' })],
  });
  // The paths in the ARGS are not concrete enough on their own here (posix, no extension).
  assert.equal(verdict.keep, false);
});

test('recipe: a turn whose only specifics are output paths is not a recipe', () => {
  const verdict = classifyRecipe({
    calls: [
      call('write', { path: 'C:\\out\\a.json' }),
      call('write', { path: 'C:\\out\\b.json' }),
    ],
  });
  assert.equal(verdict.keep, false);
  assert.equal(verdict.reason, 'paths-only', 'where output landed is not a method');
});

test('recipe: extraction is cleaned of JSON escape debris', () => {
  assert.equal(normalizeRecipe('py --model x --steps 28"}'), 'py --model x --steps 28');
  assert.equal(normalizeRecipe('C:\\\\a\\\\b.js'), 'C:\\a\\b.js');
});

test('recipe: method specifics (commands, models, settings) are preferred over paths', () => {
  const specifics = extractSpecifics([
    call('comfyui_run', { unet: 'qwen_image_2.1_int8_convrot.safetensors', steps: 28 }),
    call('pwsh', { command: 'python t2i.py --model qwen_image_2.1 --steps 28 --cfg 2.5' }),
  ]);
  assert.ok(specifics.length > 0);
  // The first specific becomes the signature, so it must be method-shaped, not a path.
  assert.ok(!/^[A-Za-z]:\\/.test(specifics[0]), `headline should not be a path: ${specifics[0]}`);
});

test('recipe: an empty turn is rejected', () => {
  assert.equal(classifyRecipe({ calls: [] }).keep, false);
  assert.equal(classifyRecipe({}).keep, false);
});

/* ------------------------------------------------------------------ capture */

function turnMessages() {
  return [
    { role: 'assistant', content: [
      { type: 'tool-call', callId: 'c1', name: 'pwsh', arguments: { command: 'python t2i.py --model qwen_image_v1.safetensors --steps 28' } },
      { type: 'tool-call', callId: 'c2', name: 'write', arguments: { path: 'C:\\out\\r.json' } },
    ] },
    { role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'ok' }] },
    { role: 'tool', toolCallId: 'c2', isError: false, content: [{ type: 'text', text: 'ok' }] },
  ];
}

test('recipe: captureRecipe writes one fact and reports it', async () => {
  const written = [];
  const store = { async upsertFact(i) { written.push(i); return { id: 'r1', ...i }; } };
  const got = await captureRecipe({ store, messages: turnMessages(), logger: {} });
  assert.ok(got);
  assert.equal(written.length, 1);
  assert.equal(written[0].category, 'auto:recipe');
  assert.equal(written[0].source, 'auto');
  assert.equal(written[0].trust, 0.6);
  assert.ok(written[0].tags.includes('recipe'));
});

test('recipe: captureRecipe dedupes the same procedure in a session', async () => {
  const written = [];
  const store = { async upsertFact(i) { written.push(i); return { id: 'r' + written.length, ...i }; } };
  const skip = new Set();
  const first = await captureRecipe({ store, messages: turnMessages(), logger: {}, skip });
  const second = await captureRecipe({ store, messages: turnMessages(), logger: {}, skip });
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(written.length, 1);
});

test('recipe: a turn with a failed call is not captured', async () => {
  const written = [];
  const store = { async upsertFact(i) { written.push(i); return { id: 'x', ...i }; } };
  const messages = turnMessages();
  messages[1].isError = true;
  const got = await captureRecipe({ store, messages, logger: {} });
  assert.equal(got, null);
  assert.equal(written.length, 0);
});

test('recipe: a missing store degrades quietly', async () => {
  assert.equal(await captureRecipe({ store: null, messages: turnMessages() }), null);
});

test('recipe: normalizeRecipe collapses whitespace and drops blank lines', () => {
  assert.equal(normalizeRecipe('  a  \n\n  b  '), 'a b');
});

test('recipe: RECIPE_INFO describes the thresholds', () => {
  assert.equal(RECIPE_INFO.minSteps, MIN_STEPS);
  assert.ok(RECIPE_INFO.evidenceTools.includes('read'));
  assert.ok(RECIPE_INFO.maxLength > 100);
});
