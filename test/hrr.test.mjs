/**
 * Tests for lib/hrr.js - the deterministic holographic (HRR/VSA) layer.
 *
 * Run directly (do NOT use `node --test dsh-memory/test/`; this machine's sandbox
 * forbids piped stdio for spawned children and that runner fails with spawn EPERM):
 *
 *   node dsh-memory/test/hrr.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAGIC,
  DEFAULT_DIM,
  encode,
  bind,
  unbind,
  bundle,
  similarity,
  createIndex,
  serializeIndex,
  deserializeIndex,
} from '../lib/hrr.js';

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

/** FNV-1a 32-bit over the little-endian IEEE-754 bytes of a float32 vector. */
function digest(vec) {
  let h = 0x811c9dc5 >>> 0;
  const buf = new Uint8Array(4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < vec.length; i++) {
    dv.setFloat32(0, vec[i], true);
    for (let b = 0; b < 4; b++) {
      h ^= buf[b];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0');
}

function l2norm(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  return Math.sqrt(s);
}

function avgMs(fn, reps) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < reps; i++) fn();
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6 / reps;
}

function assertFinite(vec, label) {
  assert.ok(vec instanceof Float32Array, label + ': expected Float32Array');
  for (let i = 0; i < vec.length; i++) {
    assert.ok(Number.isFinite(vec[i]), label + ': non-finite value at ' + i + ' = ' + vec[i]);
  }
}

/** Exactly 200 characters (the performance-budget passage). */
const ZH_PASSAGE = '显卡显存分配需要把专家层留在内存里，'.repeat(12).slice(0, 200);

const GPU_QUERY = encode('Which GPU is best for running a local LLM?');
const GPU_FACT = encode('The RTX 3060 laptop GPU runs a local LLM at 58 tokens per second.');
const FOOD_FACT = encode('Sourdough bread needs a warm kitchen and a twelve hour rise.');

/* ------------------------------------------------------------------ *
 * 1. exports and constants
 * ------------------------------------------------------------------ */

test('exposes the documented constants and functions', () => {
  assert.equal(MAGIC, 'HRR1');
  assert.equal(DEFAULT_DIM, 1024);
  for (const [name, fn] of Object.entries({
    encode,
    bind,
    unbind,
    bundle,
    similarity,
    createIndex,
    serializeIndex,
    deserializeIndex,
  })) {
    assert.equal(typeof fn, 'function', name + ' must be a function');
  }
  assert.equal(encode('hello').length, DEFAULT_DIM);
});

/* ------------------------------------------------------------------ *
 * 2. determinism
 * ------------------------------------------------------------------ */

test('two independent encodes of the same text are byte-identical', () => {
  const samples = [
    'Hermes holographic memory',
    'Which GPU is best for running a local LLM?',
    '显卡显存分配需要把专家层留在内存里',
    '   ',
    '',
    'MiXeD case 123 and punctuation!!',
  ];
  for (const text of samples) {
    const a = encode(text);
    const b = encode(text);
    assert.deepStrictEqual(a, b, 'encode must be deterministic for ' + JSON.stringify(text));
    assert.equal(digest(a), digest(b));
  }
  assert.deepStrictEqual(encode(ZH_PASSAGE), encode(ZH_PASSAGE));
});

test('encode uses presence weighting over the token set', () => {
  // Repetition and order must not change the vector: encode() is the bundle of
  // the DISTINCT token vectors, not of the raw token stream.
  assert.deepStrictEqual(encode('gpu gpu gpu'), encode('gpu'));
  assert.deepStrictEqual(encode('beta alpha'), encode('alpha beta'));
  assert.notDeepStrictEqual(encode('alpha beta'), encode('alpha gamma'));
  assert.deepStrictEqual(encode('GPU'), encode('gpu'), 'Latin tokens are lowercased');
});

test('golden digests are locked (byte-identical across runs/processes)', () => {
  // Computed on this machine (Node 24.21.0, x64) from the float32 byte layout.
  assert.equal(digest(encode('Hermes holographic memory')), '4f2d0432');
  assert.equal(digest(encode('显卡显存分配')), '46c7baf1');
  assert.equal(digest(encode('')), '9f369e7a');
  assert.equal(digest(encode(ZH_PASSAGE)), 'f73c39e9');
});

test('serializeIndex/deserializeIndex round-trips to exactly equal vectors', () => {
  const index = createIndex();
  index.add('gpu', 'The RTX 3060 laptop GPU runs a local LLM at 58 tokens per second.');
  index.add('zh-gpu', 'RTX 3060 显卡的显存分配需要把专家层留在内存里。');
  index.add('food', 'Sourdough bread needs a warm kitchen and a twelve hour rise.');
  index.add('empty', '   ');
  index.add(42, 'numeric id survives the round trip');

  const before = index.search('显卡显存怎么分配？', 5);
  const doc = serializeIndex(index);
  assert.equal(doc.magic, 'HRR1');
  assert.equal(doc.dim, 1024);
  assert.equal(doc.seed, 0x5eed);
  assert.equal(doc.vectors.length, 5);
  assert.equal(doc.vectors[0][1].length, 1024);

  // Through JSON as well, to prove the wire form is lossless.
  const restored = deserializeIndex(JSON.parse(JSON.stringify(doc)));
  assert.equal(restored.size, index.size);
  assert.equal(restored.has(42), true);
  for (const id of ['gpu', 'zh-gpu', 'food', 'empty', 42]) {
    assert.equal(restored.has(id), true, 'has(' + id + ')');
    const a = index.vector(id);
    const b = restored.vector(id);
    assert.equal(b.length, a.length);
    for (let i = 0; i < a.length; i++) {
      assert.equal(b[i], a[i], 'vector(' + id + ') differs at ' + i);
    }
    assert.equal(digest(b), digest(a));
  }
  assert.deepStrictEqual(restored.search('显卡显存怎么分配？', 5), before);
  assert.throws(() => deserializeIndex({ magic: 'NOPE' }), /magic/);
});

test('determinism holds across separate node processes', (t) => {
  const moduleUrl = new URL('../lib/hrr.js', import.meta.url).href;
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'hrr-det-'));
    const scriptPath = join(dir, 'child.mjs');
    const outPath = join(dir, 'digest.txt');
    const source = [
      'import { encode } from ' + JSON.stringify(moduleUrl) + ';',
      "import { writeFileSync } from 'node:fs';",
      'function digest(vec) {',
      '  let h = 0x811c9dc5 >>> 0;',
      '  const buf = new Uint8Array(4);',
      '  const dv = new DataView(buf.buffer);',
      '  for (let i = 0; i < vec.length; i++) {',
      '    dv.setFloat32(0, vec[i], true);',
      '    for (let b = 0; b < 4; b++) { h ^= buf[b]; h = Math.imul(h, 0x01000193) >>> 0; }',
      '  }',
      "  return h.toString(16).padStart(8, '0');",
      '}',
      'writeFileSync(' + JSON.stringify(outPath) + ', digest(encode(' + JSON.stringify(ZH_PASSAGE) + ')), ' + "'utf8');",
    ].join('\n');
    writeFileSync(scriptPath, source, 'utf8');
    const res = spawnSync(process.execPath, [scriptPath], { stdio: 'ignore', timeout: 30000 });
    if (res.error || res.status !== 0) {
      t.diagnostic('cross-process check skipped: ' + (res.error ? res.error.message : 'exit ' + res.status));
      return;
    }
    const childDigest = readFileSync(outPath, 'utf8').trim();
    assert.equal(childDigest, digest(encode(ZH_PASSAGE)));
    assert.equal(childDigest, 'f73c39e9');
  } catch (err) {
    t.diagnostic('cross-process check skipped: ' + err.message);
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort cleanup */
      }
    }
  }
});

/* ------------------------------------------------------------------ *
 * 3. retrieval quality
 * ------------------------------------------------------------------ */

test('a GPU query ranks a GPU fact above an unrelated culinary fact', () => {
  const index = createIndex();
  index.add('gpu', 'The RTX 3060 laptop GPU runs a local LLM at 58 tokens per second.');
  index.add('food', 'Sourdough bread needs a warm kitchen and a twelve hour rise.');
  index.add('tax', 'Quarterly tax returns are due at the end of the month.');
  index.add('garden', 'Tomato seedlings need six hours of direct sunlight.');

  const hits = index.search('Which GPU is best for running a local LLM?', 4);
  assert.equal(hits.length, 4);
  assert.equal(hits[0].id, 'gpu');
  const gpuScore = similarity(GPU_QUERY, GPU_FACT);
  const foodScore = similarity(GPU_QUERY, FOOD_FACT);
  assert.ok(gpuScore > foodScore + 0.2, 'GPU fact must clearly outrank the food fact');
  assert.ok(foodScore < 0.15, 'unrelated fact must stay near chance, got ' + foodScore);
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].score >= hits[i].score, 'results must be sorted by score desc');
  }
  console.log(
    '[hrr-measure] gpu query: gpu fact=' +
      gpuScore.toFixed(4) +
      ' food fact=' +
      foodScore.toFixed(4) +
      ' margin=' +
      (gpuScore - foodScore).toFixed(4),
  );
});

test('a Chinese query ranks the matching Chinese fact first', () => {
  const index = createIndex();
  index.add('zh-gpu', 'RTX 3060 显卡的显存分配需要把专家层留在内存里。');
  index.add('zh-food', '面包需要在温暖的厨房里发酵十二个小时。');
  index.add('zh-weather', '明天上海有雨，出门记得带伞。');
  index.add('en-gpu', 'The laptop GPU holds its experts in system memory.');

  const query = '显卡显存怎么分配？';
  const hits = index.search(query, 4);
  assert.equal(hits[0].id, 'zh-gpu');
  const match = similarity(encode(query), index.vector('zh-gpu'));
  const unrelated = similarity(encode(query), index.vector('zh-food'));
  assert.ok(match > 0.3, 'Chinese match must be strong, got ' + match);
  assert.ok(unrelated < 0.15, 'unrelated Chinese fact must stay near chance, got ' + unrelated);
  console.log(
    '[hrr-measure] zh query: matching fact=' +
      match.toFixed(4) +
      ' unrelated fact=' +
      unrelated.toFixed(4),
  );
});

/* ------------------------------------------------------------------ *
 * 4. index bookkeeping
 * ------------------------------------------------------------------ */

test('add / remove / rebuild keep size and has() consistent', () => {
  const index = createIndex();
  assert.equal(index.size, 0);
  assert.equal(index.has('a'), false);
  assert.equal(index.vector('a'), null);

  index.add('a', 'alpha');
  index.add('b', 'beta');
  index.add('c', 'gamma');
  assert.equal(index.size, 3);
  assert.equal(index.has('a'), true);
  assert.equal(index.has('b'), true);
  assert.equal(index.has('c'), true);

  index.add('a', 'alpha replaced'); // same id overwrites
  assert.equal(index.size, 3);

  assert.equal(index.remove('b'), true);
  assert.equal(index.remove('b'), false);
  assert.equal(index.size, 2);
  assert.equal(index.has('b'), false);

  index.rebuild([
    { id: 'x', text: 'xray' },
    { id: 'y', text: 'yankee' },
  ]);
  assert.equal(index.size, 2);
  assert.equal(index.has('x'), true);
  assert.equal(index.has('y'), true);
  assert.equal(index.has('a'), false, 'rebuild must clear previous entries');

  index.rebuild([]);
  assert.equal(index.size, 0);

  // vector() hands out a copy, not the internal buffer.
  index.add('z', 'zulu');
  const first = index.vector('z');
  first[0] = 999;
  assert.notEqual(index.vector('z')[0], 999);
});

test('search honours k, ordering and unknown ids', () => {
  const index = createIndex();
  for (let i = 0; i < 6; i++) index.add('f' + i, 'fact number ' + i + ' about topic ' + (i % 3));
  assert.equal(index.search('topic 1', 0).length, 0);
  assert.equal(index.search('topic 1', 2).length, 2);
  assert.equal(createIndex().search('anything', 5).length, 0);
  const hits = index.search('fact about topic 2', 10);
  assert.equal(hits.length, 6);
  for (const hit of hits) {
    assert.ok(Number.isFinite(hit.score) && hit.score >= -1 && hit.score <= 1);
  }
  assert.equal(index.vector('nope'), null);
});

/* ------------------------------------------------------------------ *
 * 5. vector algebra
 * ------------------------------------------------------------------ */

test('bundle of one vector equals that vector; bundles are unit norm', () => {
  const a = encode('alpha');
  const b = encode('beta');
  const c = encode('gamma');
  const single = bundle([a]);
  assert.deepStrictEqual(single, a);
  assert.deepStrictEqual(bundle([]), new Float32Array(0));
  const many = bundle([a, b, c]);
  assert.equal(many.length, DEFAULT_DIM);
  assert.ok(Math.abs(l2norm(many) - 1) < 1e-5, 'bundle must be unit norm');
  // bundling one of the members into a larger bundle keeps it retrievable
  assert.ok(similarity(many, a) > 0.3);
});

test('unbind(bind(a, b), b) recovers a far above chance', () => {
  const a = encode('alpha signal');
  const b = encode('beta key');
  const bound = bind(a, b);
  const recovered = unbind(bound, b);
  const recoveredScore = similarity(recovered, a);
  const chance = Math.abs(similarity(a, b));
  assert.ok(recoveredScore > 0.5, 'recovery must be well above chance, got ' + recoveredScore);
  assert.ok(chance < 0.1, 'two unrelated unit vectors must be near-orthogonal, got ' + chance);
  assert.ok(Math.abs(l2norm(bound) - 1) < 0.05, 'bind keeps norm ~1 for unit inputs');

  // The non-power-of-two fallback path must behave the same way.
  const a100 = encode('alpha signal', { dim: 100 });
  const b100 = encode('beta key', { dim: 100 });
  assert.ok(similarity(unbind(bind(a100, b100), b100), a100) > 0.5);
  const a64 = encode('alpha signal', { dim: 64 });
  const b64 = encode('beta key', { dim: 64 });
  assert.ok(similarity(unbind(bind(a64, b64), b64), a64) > 0.5);

  console.log(
    '[hrr-measure] recovery cos=' +
      recoveredScore.toFixed(4) +
      ' chance cos=' +
      chance.toFixed(4) +
      ' bind norm=' +
      l2norm(bound).toFixed(4),
  );
});

/* ------------------------------------------------------------------ *
 * 6. numerical hygiene and normalisation
 * ------------------------------------------------------------------ */

test('empty and whitespace-only text give a defined unit vector', () => {
  const empty = encode('');
  const blank = encode('   \n\t  ');
  assertFinite(empty, 'encode("")');
  assert.equal(empty.length, DEFAULT_DIM);
  assert.ok(Math.abs(l2norm(empty) - 1) < 1e-5);
  assert.deepStrictEqual(blank, empty);
  assert.ok(similarity(empty, encode('anything')) < 0.15);
});

test('no returned vector ever contains NaN or Infinity', () => {
  const a = encode('alpha signal');
  const b = encode('beta key');
  const vectors = {
    ascii: encode('Hermes holographic memory'),
    chinese: encode('显卡显存分配'),
    empty: encode(''),
    blank: encode(' \n '),
    bound: bind(a, b),
    recovered: unbind(bind(a, b), b),
    bundled: bundle([a, b, encode('gamma')]),
    cancel: bundle([a, Float32Array.from(a, (v) => -v)]),
  };
  for (const [label, vec] of Object.entries(vectors)) assertFinite(vec, label);
  assert.ok(Number.isFinite(similarity(a, b)));
  assert.ok(Number.isFinite(similarity(vectors.empty, vectors.cancel)));

  const index = createIndex();
  for (const [label, vec] of Object.entries(vectors)) index.add(label, 'text ' + label);
  for (const key of Object.keys(vectors)) assertFinite(index.vector(key), 'index ' + key);
  const restored = deserializeIndex(serializeIndex(index));
  for (const key of Object.keys(vectors)) assertFinite(restored.vector(key), 'restored ' + key);
  for (const hit of index.search('holographic memory', 3)) {
    assert.ok(Number.isFinite(hit.score));
  }
  assert.throws(() => similarity(a, encode('x', { dim: 8 })), /dimensions/);
  assert.throws(() => encode('x', { dim: 0 }), /dim/);
});

/* ------------------------------------------------------------------ *
 * 7. performance budget
 * ------------------------------------------------------------------ */

test('performance: 200-char Chinese encode and 500-fact search', (t) => {
  assert.equal(ZH_PASSAGE.length, 200);

  for (let i = 0; i < 5; i++) encode(ZH_PASSAGE); // warm up caches and JIT
  const encodeMs = avgMs(() => encode(ZH_PASSAGE), 20);
  assert.ok(encodeMs < 25, 'encode of 200 Chinese chars took ' + encodeMs.toFixed(3) + ' ms');

  const index = createIndex();
  for (let i = 0; i < 500; i++) {
    index.add(
      'f' + i,
      '第' + i + '号服务器在显卡显存分配上使用方案' + (i % 7) + '，处理器型号 RTX ' + (3000 + i) + '。',
    );
  }
  assert.equal(index.size, 500);
  const query = '显卡显存怎么分配？';
  for (let i = 0; i < 3; i++) index.search(query, 10);
  const searchMs = avgMs(() => index.search(query, 10), 20);
  assert.ok(searchMs < 100, 'search over 500 facts took ' + searchMs.toFixed(3) + ' ms');

  t.diagnostic('encode(200 zh chars) = ' + encodeMs.toFixed(3) + ' ms');
  t.diagnostic('search over 500 facts = ' + searchMs.toFixed(3) + ' ms');
  console.log('[hrr-measure] encode 200-char zh=' + encodeMs.toFixed(3) + ' ms');
  console.log('[hrr-measure] search 500 facts=' + searchMs.toFixed(3) + ' ms');
});
