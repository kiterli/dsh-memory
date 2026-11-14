/**
 * lib/reflection-worker.js — Worker Thread for Phase 3 reflection.
 *
 * Rule-based preference extraction from recent events.
 * distilgpt2 stays loaded for future upgrade but doesn't drive extraction.
 */
import { parentPort } from 'node:worker_threads';

const MODEL_ID = 'Xenova/distilgpt2';
const PREFERENCE_PATTERNS = [
  /我喜欢(.{2,30})/g,
  /我不要(.{2,30})/g,
  /记住(.{2,30})/g,
  /以后都(.{2,30})/g,
  /别再(.{2,30})/g,
  /我是(.{2,20})/g,
  /我用(.{2,30})/g,
];

let generator = null;
let modelStatus = 'loading';

const log = (...args) => {
  try { parentPort.postMessage({ type: 'log', args: args.map(String) }); } catch {}
};

async function loadModel() {
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    generator = await pipeline('text-generation', MODEL_ID, { dtype: 'q8', device: 'cpu' });
    log('reflection model loaded');
  } catch (e) {
    log('model load skipped, rule-based only: ' + e.message);
  }
}

function reflect(events, existingFacts) {
  const suggestions = [];
  const existingSet = new Set((existingFacts || []).map(f => String(f).toLowerCase()));
  for (const evt of (events || []).slice(-20)) {
    const text = String(evt.content || '');
    for (const pattern of PREFERENCE_PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(text)) !== null) {
        const extracted = m[0].trim();
        if (extracted.length < 5) continue;
        if (existingSet.has(extracted.toLowerCase())) continue;
        suggestions.push({ content: extracted, category: 'preference', trust: 0.6 });
      }
    }
  }
  return suggestions.slice(0, 10);
}

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'init') {
      await loadModel();
      modelStatus = 'ready';
      parentPort.postMessage({ type: 'ready', status: 'ready' });
    } else if (msg.type === 'reflect') {
      const suggestions = reflect(msg.events || [], msg.existingFacts || []);
      parentPort.postMessage({ type: 'reflect-result', reqId: msg.reqId, suggestions });
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: String(err.message || err) });
  }
});

parentPort.postMessage({ type: 'ready', status: 'loading' });
