/**
 * lib/embed.js — 主进程 Worker wrapper。
 *
 * 管理 embed-worker.js 线程，提供：
 *   - embed(text): 返回 Float32Array | null
 *   - search(query, topK): 返回 [{id, score}]
 *   - upsertNotify(id, vec): 通知 Worker 增量更新向量
 *   - deleteNotify(id): 通知 Worker 删除向量
 *   - status(): Worker 状态
 *   - dispose(): 终止 Worker
 *
 * 所有方法在 Worker 不可用时安全降级（返回 null / []）。
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(here, 'embed-worker.js');

const MODEL_NAME = 'Xenova/bge-small-zh-v1.5';
const EMBED_DIM = 512;

export function createEmbedder({ dbPath, cacheDir, hfMirror, logger, workerFactory }) {
  const log = logger ?? console;
  const makeWorker = workerFactory || ((path, opts) => new Worker(path, opts));
  let worker = null;
  let ready = false;
  let failed = false;
  let reqSeq = 0;
  let vectorCount = 0;
  const pending = new Map(); // reqId -> resolve
  let startupPromise = null;

  function post(msg) {
    if (!worker) return;
    worker.postMessage(msg);
  }

  function postAndWait(msg, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const reqId = ++reqSeq;
      pending.set(reqId, resolve);
      post({ ...msg, reqId });
      setTimeout(() => {
        if (pending.has(reqId)) {
          pending.delete(reqId);
          reject(new Error('embed worker timeout'));
        }
      }, timeoutMs);
    });
  }

  function start() {
    if (startupPromise) return startupPromise;
    startupPromise = (async () => {
      try {
        worker = makeWorker(WORKER_PATH, { type: 'module' });
        worker.on('message', (msg) => handleMessage(msg));
        worker.on('error', (err) => {
          log.warn?.(`[dsh-memory] embed worker error: ${err.message}`);
          failed = true;
          for (const [, resolve] of pending) resolve(null);
          pending.clear();
        });
        worker.on('exit', (code) => {
          if (code !== 0 && !failed) {
            log.warn?.(`[dsh-memory] embed worker exited code=${code}`);
            failed = true;
          }
        });
        post({
          type: 'init',
          dbPath,
          cacheDir,
          hfMirror,
        });
      } catch (err) {
        failed = true;
        log.warn?.(`[dsh-memory] embed worker start failed: ${err.message}`);
      }
    })();
    return startupPromise;
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'ready':
        if (msg.status === 'ready') ready = true;
        if (msg.status === 'failed') failed = true;
        break;
      case 'embed-result': {
        const resolve = pending.get(msg.reqId);
        if (resolve) {
          pending.delete(msg.reqId);
          resolve(msg.vec ? new Float32Array(msg.vec) : null);
        }
        break;
      }
      case 'search-result': {
        const resolve = pending.get(msg.reqId);
        if (resolve) {
          pending.delete(msg.reqId);
          resolve(msg.results || []);
        }
        break;
      }
      case 'status-result':
        // fire and forget
        break;
      case 'vectors-loaded':
        vectorCount = msg.count || 0;
        break;
      case 'log':
        log.info?.(`[dsh-memory:embed] ${(msg.args || []).join(' ')}`);
        break;
      case 'error':
        log.warn?.(`[dsh-memory:embed] worker error: ${msg.error}`);
        break;
    }
  }

  /** 嵌入文本，返回 Float32Array | null（降级时） */
  async function embed(text) {
    if (failed || !worker) return null;
    try {
      return await postAndWait({ type: 'embed', text }, 10000);
    } catch {
      return null;
    }
  }

  /** 低优先级 embed（批量补 embedding 用，不阻塞 search） */
  async function embedLowPriority(text) {
    if (failed || !worker) return null;
    try {
      return await postAndWait({ type: 'embed', text, lowPriority: true }, 30000);
    } catch {
      return null;
    }
  }

  /** 语义搜索，返回 [{id, score}] */
  async function search(query, topK = 8, scope, project) {
    if (failed || !worker) return [];
    try {
      return await postAndWait({ type: 'search', query, topK, scope, project }, 10000);
    } catch {
      return [];
    }
  }

  /** 通知 Worker 增量更新向量 */
  function upsertNotify(id, vec) {
    if (!worker) return;
    post({ type: 'upsert', id, vec: vec ? Array.from(vec) : null });
  }

  function deleteNotify(id) {
    if (!worker) return;
    post({ type: 'delete', id });
  }

  /** 触发 Worker 从 SQLite 全量加载向量 */
  async function loadVectors() {
    if (!worker) return;
    post({ type: 'load-vectors' });
  }

  function isReady() { return ready; }
  function isFailed() { return failed; }
  function getVectorCount() { return vectorCount; }

  async function dispose() {
    // Wait for the in-flight start() first. start() is async: without this await, a
    // dispose() that lands before `worker` is assigned leaves the Worker (and its two
    // MessagePorts) alive after the plugin is gone — the host then never exits.
    try {
      if (startupPromise) await startupPromise;
    } catch { /* start already logged its own failure */ }
    try {
      if (worker) {
        worker.removeAllListeners?.();
        await worker.terminate();
      }
    } catch { /* ignore */ }
    worker = null;
    failed = true;
    startupPromise = null;
    for (const [, resolve] of pending) resolve(null);
    pending.clear();
  }

  start();

  return { embed, embedLowPriority, search, upsertNotify, deleteNotify, loadVectors, isReady, isFailed, getVectorCount, dispose, MODEL_NAME, EMBED_DIM };
}
