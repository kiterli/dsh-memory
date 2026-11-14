/**
 * lib/embed-worker.js — Worker Thread 入口。
 *
 * 加载 bge-small-zh ONNX int8 模型，维护内存中的 facts 向量表，
 * 全量线性点积做语义搜索。不阻塞主进程。
 *
 * 消息协议（parentPort ↔ workerData）：
 *   IN  { type: 'init', dbPath, modelPath, hfMirror }
 *   IN  { type: 'embed', text, reqId }
 *   OUT { type: 'embed-result', reqId, vec: number[] | null }
 *   IN  { type: 'search', query, topK, scope, project }
 *   OUT { type: 'search-result', reqId, results: [{id, score}] }
 *   IN  { type: 'upsert', id, vec: number[] | null }
 *   IN  { type: 'delete', id }
 *   IN  { type: 'load-vectors' }  // 从 SQLite 全量加载
 *   OUT { type: 'vectors-loaded', count }
 *   OUT { type: 'ready', status }  // model loaded / failed
 */
import { parentPort } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';

// ------------------------------------------------------------------ state
let extractor = null;
let modelReady = false;
let modelFailed = false;
let modelStatus = 'loading'; // loading | ready | failed

// 内存向量：factId -> Float32Array
const vectors = new Map();
let vectorsLoaded = false;

// SQLite
let db = null;
let dbPath = null;

// 模型配置
let modelName = 'Xenova/bge-small-zh-v1.5';
let hfMirror = 'https://hf-mirror.com';
let cacheDir = path.join(os.homedir(), '.dsh', 'memory-models');

// ------------------------------------------------------------------ helpers
function log(...args) {
  try { parentPort?.postMessage({ type: 'log', args: args.map(String) }); } catch { /* ignore */ }
}

/** 512 token 截断（bge-small-zh 上限约 512 token，粗略按字符截断中文） */
function truncate(text) {
  // 中文约 1 字 = 1-2 token，保守按 400 字符截
  const s = String(text ?? '');
  return s.length > 400 ? s.slice(0, 400) : s;
}

/** secret 正则：API key / token / password */
const RE_SECRET = /(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|gho_[a-zA-Z0-9]{20,}|xoxb-[a-zA-Z0-9-]{20,}|Bearer\s+[a-zA-Z0-9._-]{20,}|-----BEGIN[A-Z ]*PRIVATE KEY-----)/i;

function isSecret(text) {
  return RE_SECRET.test(String(text ?? ''));
}

/** cosine 相似度（向量已归一化，点积即 cosine） */
function cosine(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

// ------------------------------------------------------------------ model
async function ensureModel() {
  if (modelReady) return true;
  if (modelFailed) return false;
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;
    if (hfMirror) env.remoteHost = hfMirror;
    extractor = await pipeline('feature-extraction', modelName, { quantized: true });
    modelReady = true;
    modelStatus = 'ready';
    log('model loaded');
    return true;
  } catch (err) {
    modelFailed = true;
    modelStatus = 'failed';
    log('model failed:', err.message);
    return false;
  }
}

async function embedText(text) {
  if (!await ensureModel()) return null;
  if (isSecret(text)) return null;
  const out = await extractor(truncate(text), { pooling: 'mean', normalize: true });
  return new Float32Array(out.data);
}

// ------------------------------------------------------------------ SQLite
async function openDb(p) {
  if (db) return;
  dbPath = p;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA query_only = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    log('sqlite opened:', dbPath);
  } catch (err) {
    log('sqlite open failed:', err.message);
    db = null;
  }
}

async function loadVectorsFromDb() {
  if (!db) return 0;
  try {
    const rows = db.prepare('SELECT id, embedding FROM facts WHERE embedding IS NOT NULL AND archived = 0').all();
    vectors.clear();
    for (const row of rows) {
      if (!row.embedding) continue;
      const buf = Buffer.from(row.embedding);
      const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      vectors.set(String(row.id), vec);
    }
    vectorsLoaded = true;
    log('vectors loaded:', vectors.size);
    return vectors.size;
  } catch (err) {
    log('load vectors failed:', err.message);
    return 0;
  }
}

// ------------------------------------------------------------------ search
async function doSearch(queryText, topK, scope, project) {
  const qvec = await embedText(queryText);
  if (!qvec || vectors.size === 0) return [];

  const scored = [];
  for (const [id, vec] of vectors) {
    const score = cosine(qvec, vec);
    scored.push({ id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ------------------------------------------------------------------ priority queue
// 高优先级：embed（新 fact）、search（用户查询）
// 低优先级：backfill（批量补历史 embedding）
const highQueue = [];
const lowQueue = [];
let processing = false;

function enqueue(msg, priority = 'high') {
  if (priority === 'low') lowQueue.push(msg);
  else highQueue.push(msg);
  drain();
}

async function drain() {
  if (processing) return;
  processing = true;
  try {
    while (highQueue.length > 0 || lowQueue.length > 0) {
      const msg = highQueue.shift() || lowQueue.shift();
      if (!msg) break;
      await handleMessage(msg);
    }
  } finally {
    processing = false;
  }
}

// ------------------------------------------------------------------ message handlers
async function handleMessage(msg) {
  try {
    switch (msg.type) {
      case 'init': {
        cacheDir = msg.cacheDir || cacheDir;
        hfMirror = msg.hfMirror || hfMirror;
        if (msg.dbPath) await openDb(msg.dbPath);
        ensureModel().then(() => {
          parentPort.postMessage({ type: 'ready', status: modelStatus });
        });
        parentPort.postMessage({ type: 'ready', status: 'loading' });
        break;
      }
      case 'load-vectors': {
        const count = await loadVectorsFromDb();
        parentPort.postMessage({ type: 'vectors-loaded', count });
        break;
      }
      case 'embed': {
        const vec = await embedText(msg.text);
        parentPort.postMessage({
          type: 'embed-result',
          reqId: msg.reqId,
          vec: vec ? Array.from(vec) : null,
        });
        break;
      }
      case 'search': {
        const results = await doSearch(msg.query, msg.topK || 8, msg.scope, msg.project);
        parentPort.postMessage({ type: 'search-result', reqId: msg.reqId, results });
        break;
      }
      case 'upsert': {
        if (msg.vec) {
          vectors.set(msg.id, new Float32Array(msg.vec));
        } else {
          vectors.delete(msg.id);
        }
        break;
      }
      case 'delete': {
        vectors.delete(msg.id);
        break;
      }
      case 'status': {
        parentPort.postMessage({
          type: 'status-result',
          modelStatus,
          vectorCount: vectors.size,
          vectorsLoaded,
          highQueueLen: highQueue.length,
          lowQueueLen: lowQueue.length,
        });
        break;
      }
    }
  } catch (err) {
    log('worker error:', err.message);
    parentPort.postMessage({ type: 'error', error: err.message, reqId: msg?.reqId });
  }
}

// ------------------------------------------------------------------ message loop
parentPort.on('message', (msg) => {
  // backfill 消息标记 low priority（主进程批量补时发 type='embed' + lowPriority=true）
  const priority = msg.lowPriority ? 'low' : 'high';
  enqueue(msg, priority);
});
