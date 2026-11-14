// Tests for lib/embed.js — the main-process Worker wrapper.
// We inject a fake worker via workerFactory so no real ONNX model loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedder } from '../lib/embed.js';

class FakeWorker {
  constructor() {
    this.posted = [];
    this.handlers = {};
    this.terminated = false;
    FakeWorker.last = this;
  }
  on(event, fn) { this.handlers[event] = fn; }
  postMessage(msg) { this.posted.push(msg); }
  async terminate() { this.terminated = true; }
  emit(msg) { this.handlers['message']?.(msg); }
  emitError(err) { this.handlers['error']?.(err); }
}

function makeEmbedder() {
  FakeWorker.last = null;
  const logger = { info() {}, warn() {} };
  const emb = createEmbedder({
    dbPath: ':memory:', cacheDir: '/tmp', hfMirror: '', logger,
    workerFactory: () => new FakeWorker(),
  });
  return { emb, w: FakeWorker.last };
}

test('embed-result resolves Float32Array', async () => {
  const { emb, w } = makeEmbedder();
  const p = emb.embed('test');
  const req = w.posted.find(m => m.type === 'embed');
  assert.ok(req, 'should have posted an embed message');
  w.emit({ type: 'embed-result', reqId: req.reqId, vec: [0.1, 0.2, 0.3] });
  const vec = await p;
  assert.ok(vec instanceof Float32Array);
  assert.equal(vec.length, 3);
  await emb.dispose();
});

test('vectors-loaded updates getVectorCount', () => {
  const { emb, w } = makeEmbedder();
  w.emit({ type: 'vectors-loaded', count: 42 });
  assert.equal(emb.getVectorCount(), 42);
  w.emit({ type: 'vectors-loaded', count: 7 });
  assert.equal(emb.getVectorCount(), 7);
  emb.dispose();
});

test('ready message sets isReady', () => {
  const { emb, w } = makeEmbedder();
  w.emit({ type: 'ready', status: 'ready' });
  assert.equal(emb.isReady(), true);
  emb.dispose();
});

test('failed message sets isFailed', () => {
  const { emb, w } = makeEmbedder();
  w.emit({ type: 'ready', status: 'failed' });
  assert.equal(emb.isFailed(), true);
  emb.dispose();
});

test('worker error marks failed and pending resolve null', async () => {
  const { emb, w } = makeEmbedder();
  const p = emb.embed('will fail');
  w.emitError(new Error('boom'));
  const vec = await p;
  assert.equal(vec, null);
  assert.equal(emb.isFailed(), true);
  await emb.dispose();
});

test('embedLowPriority posts lowPriority flag', async () => {
  const { emb, w } = makeEmbedder();
  const p = emb.embedLowPriority('batch');
  const req = w.posted.find(m => m.type === 'embed' && m.lowPriority === true);
  assert.ok(req, 'should have posted lowPriority embed');
  w.emit({ type: 'embed-result', reqId: req.reqId, vec: [1, 2] });
  const vec = await p;
  assert.ok(vec instanceof Float32Array);
  await emb.dispose();
});

test('search returns results', async () => {
  const { emb, w } = makeEmbedder();
  const p = emb.search('query', 5);
  const req = w.posted.find(m => m.type === 'search');
  assert.ok(req);
  w.emit({ type: 'search-result', reqId: req.reqId, results: [{ id: 'a', score: 0.9 }] });
  const results = await p;
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'a');
  await emb.dispose();
});

test('dispose terminates worker', async () => {
  const { emb, w } = makeEmbedder();
  await emb.dispose();
  assert.equal(w.terminated, true);
});

test('embed returns null after failed', async () => {
  const { emb, w } = makeEmbedder();
  w.emitError(new Error('boom'));
  const vec = await emb.embed('x');
  assert.equal(vec, null);
  await emb.dispose();
});

test('MODEL_NAME and EMBED_DIM', () => {
  const { emb } = makeEmbedder();
  assert.equal(emb.MODEL_NAME, 'Xenova/bge-small-zh-v1.5');
  assert.equal(emb.EMBED_DIM, 512);
  emb.dispose();
});
