/**
 * lib/reflection.js — 主进程 wrapper for reflection-worker.js.
 *
 * Phase 3: loads Qwen2.5-1.5B-Instruct in a Worker Thread for lesson mining.
 * Lazy: worker starts on first reflect() call, not at plugin boot.
 * Safe degrade: if model fails to load, reflect() returns [].
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(here, 'reflection-worker.js');

export function createReflector({ dbPath, cacheDir, hfMirror, logger }) {
  const log = logger ?? console;
  let worker = null;
  let ready = false;
  let failed = false;
  let starting = null;
  let reqSeq = 0;
  const pending = new Map();

  function post(msg) { if (worker) worker.postMessage(msg); }

  function postAndWait(msg, timeoutMs = 120000) {
    return new Promise((resolve) => {
      const reqId = ++reqSeq;
      pending.set(reqId, resolve);
      post({ ...msg, reqId });
      setTimeout(() => {
        if (pending.has(reqId)) { pending.delete(reqId); resolve([]); }
      }, timeoutMs);
    });
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'ready':
        if (msg.status === 'ready') ready = true;
        if (msg.status === 'failed') failed = true;
        break;
      case 'reflect-result': {
        const resolve = pending.get(msg.reqId);
        if (resolve) { pending.delete(msg.reqId); resolve(msg.suggestions || []); }
        break;
      }
      case 'log':
        log.info?.(`[dsh-memory:reflect] ${(msg.args || []).join(' ')}`);
        break;
      case 'error':
        log.warn?.(`[dsh-memory:reflect] ${msg.error}`);
        break;
    }
  }

  function start() {
    if (starting) return starting;
    starting = (async () => {
      try {
        worker = new Worker(WORKER_PATH, { type: 'module' });
        worker.on('message', handleMessage);
        worker.on('error', (err) => {
          log.warn?.(`[dsh-memory] reflection worker error: ${err.message}`);
          failed = true;
          for (const [, resolve] of pending) resolve([]);
          pending.clear();
        });
        post({ type: 'init', dbPath, cacheDir, hfMirror });
      } catch (err) {
        failed = true;
        log.warn?.(`[dsh-memory] reflection worker start failed: ${err.message}`);
      }
    })();
    return starting;
  }

  /** Reflect on recent events, return suggested facts. Empty if unavailable. */
  async function reflect(events, existingFacts) {
    if (failed) return [];
    if (!ready) await start();
    if (!ready || failed || !worker) return [];
    try {
      return await postAndWait({ type: 'reflect', events, existingFacts }, 120000);
    } catch { return []; }
  }

  function isReady() { return ready; }
  function isFailed() { return failed; }

  async function dispose() {
    // Same hazard as lib/embed.js: start() is async, so a dispose() racing the initial
    // launch would otherwise leave the Worker thread (and its ports) running.
    try {
      if (starting) await starting;
    } catch { /* start already logged its own failure */ }
    try {
      if (worker) {
        worker.removeAllListeners?.();
        await worker.terminate();
      }
    } catch { /* ignore */ }
    worker = null;
    failed = true;
    starting = null;
    for (const [, resolve] of pending) resolve([]);
    pending.clear();
  }

  return { reflect, isReady, isFailed, dispose };
}
