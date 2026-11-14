/**
 * lib/budget.js — decide whether this machine can afford to load the embedding model.
 *
 * WHY
 *
 * On a 16 GB machine with DSH and ComfyUI already resident, loading the bge-small-zh ONNX
 * model through @huggingface/transformers exhausted physical memory hard enough that
 * PowerShell could no longer start (`System.OutOfMemoryException` / "页面文件太小"). That is
 * not a slow path — it is the whole desktop becoming unusable, caused by an optional
 * feature that only improves ranking.
 *
 * A feature whose failure mode is "the machine dies" must check before it starts. This
 * module answers one question — "is there room for this?" — using figures measured on this
 * machine rather than a guess:
 *
 *   - the transformers runtime plus tokenizer costs ~350 MB resident before any weights;
 *   - the int8 bge-small-zh weights add ~250 MB;
 *   - inference peaks add ~400 MB transient above that.
 *
 * The default reservation (900 MB headroom) therefore reflects "we will put roughly 900 MB
 * on top of what is free right now", plus a safety margin so the *next* process can still
 * start.
 *
 * Pure function + a thin OS reader; the decision is testable without a real machine.
 */

import os from 'node:os';

/**
 * Rough resident cost of loading the embedder, in MB.
 *
 * CALIBRATED ON A CRASH, not guessed. The first estimate was 900 MB, and with a 700 MB margin
 * it happily authorised a load at 2233 MB free — the exact situation that then exhausted
 * physical memory. So the real cost is higher than "runtime + weights": ONNX Runtime allocates
 * arenas per inference session, the tokenizer holds its own buffers, and native fragmentation
 * means the peak is well above the sum of the parts. 1400 MB is the conservative figure that
 * refuses that case while still allowing a comfortable machine.
 */
export const EMBEDDER_COST_MB = 1400;

/** Headroom kept free after the load, so the desktop stays responsive. */
export const SAFETY_MARGIN_MB = 700;

/**
 * Below this, refuse outright regardless of margin: a machine this tight cannot take the
 * transient spike that inference causes.
 */
export const HARD_FLOOR_MB = 1500;

/**
 * Minimum fraction of TOTAL memory that must remain free — but only on SMALL machines.
 *
 * The absolute figures alone were not enough: 2233 MB free on a 14 GB machine cleared
 * "cost 1400 + margin 700" yet still OOM'd. Meanwhile 8 GB free on a 32 GB box is perfectly
 * comfortable even though it is only 25%. So the ratio is applied only when total memory is
 * under the threshold below: on a big machine, absolute headroom is what matters.
 */
export const MIN_FREE_RATIO = 0.3;

/** Above this much total RAM, the free-ratio check is skipped. */
export const RATIO_CHECK_MAX_TOTAL_MB = 20000;

/**
 * Read current memory facts. Isolated so tests can substitute numbers.
 *
 * Linux reports MemAvailable in /proc/meminfo, which is the honest "free for new work"
 * figure; Node's os.freemem() on Linux reports MemFree instead and understates badly. On
 * Windows os.freemem() is already the right number, so no special case is needed.
 */
export function readMemory() {
  const totalMB = Math.round(os.totalmem() / (1024 * 1024));
  let freeMB = Math.round(os.freemem() / (1024 * 1024));

  if (process.platform === 'linux') {
    try {
      // eslint-disable-next-line global-require
      const text = require('node:fs').readFileSync('/proc/meminfo', 'utf8');
      const m = /MemAvailable:\s+(\d+)\s+kB/.exec(text);
      if (m) freeMB = Math.round(Number(m[1]) / 1024);
    } catch { /* fall back to os.freemem() */ }
  }

  return { totalMB, freeMB };
}

/**
 * Should the embedder be loaded?
 *
 * @param {object} [memory]  `{ totalMB, freeMB }`; read from the OS when omitted
 * @param {object} [opts]
 * @param {number} [opts.costMB]         expected resident cost of the load
 * @param {number} [opts.marginMB]       headroom to keep free afterwards
 * @param {number} [opts.hardFloorMB]    refuse below this no matter what
 * @returns {{ allowed: boolean, reason: string, freeMB: number, totalMB: number, neededMB: number, note?: string }}
 */
export function canLoadEmbedder(memory = null, opts = {}) {
  const costMB = Number.isFinite(opts.costMB) ? opts.costMB : EMBEDDER_COST_MB;
  const marginMB = Number.isFinite(opts.marginMB) ? opts.marginMB : SAFETY_MARGIN_MB;
  const hardFloorMB = Number.isFinite(opts.hardFloorMB) ? opts.hardFloorMB : HARD_FLOOR_MB;

  let mem = memory;
  if (!mem || !Number.isFinite(mem.freeMB)) {
    try {
      mem = readMemory();
    } catch {
      // Cannot read memory: refuse rather than risk the machine. The embedder is optional;
      // a running desktop is not.
      return {
        allowed: false,
        reason: 'memory-unknown',
        freeMB: -1,
        totalMB: -1,
        neededMB: costMB + marginMB,
        note: 'could not read available memory; the embedder is optional, so it stays off',
      };
    }
  }

  const { freeMB, totalMB } = mem;
  const neededMB = costMB + marginMB;
  const base = { freeMB, totalMB, neededMB };

  if (freeMB < hardFloorMB) {
    return {
      ...base,
      allowed: false,
      reason: 'below-hard-floor',
      note: `only ${freeMB} MB free (hard floor ${hardFloorMB} MB)`,
    };
  }
  if (totalMB > 0 && totalMB <= RATIO_CHECK_MAX_TOTAL_MB) {
    const ratio = freeMB / totalMB;
    if (ratio < MIN_FREE_RATIO) {
      return {
        ...base,
        allowed: false,
        reason: 'low-free-ratio',
        note: `free ${freeMB} MB is only ${(ratio * 100).toFixed(0)}% of ${totalMB} MB (need ≥${(MIN_FREE_RATIO * 100).toFixed(0)}% on a machine this size)`,
      };
    }
  }
  if (freeMB < neededMB) {
    return {
      ...base,
      allowed: false,
      reason: 'insufficient-headroom',
      note: `free ${freeMB} MB, need ${neededMB} MB (cost ${costMB} + margin ${marginMB})`,
    };
  }

  return { ...base, allowed: true, reason: 'ok', note: `free ${freeMB} MB, needed ${neededMB} MB` };
}

/**
 * A one-line explanation for the panel and the selfcheck detail.
 */
export function describeBudget(verdict) {
  if (!verdict) return 'memory budget unknown';
  const status = verdict.allowed ? 'allowed' : `skipped (${verdict.reason})`;
  return `${status}: ${verdict.note ?? ''} · free ${verdict.freeMB} MB / total ${verdict.totalMB} MB`;
}

export const BUDGET_INFO = Object.freeze({
  embedderCostMB: EMBEDDER_COST_MB,
  safetyMarginMB: SAFETY_MARGIN_MB,
  hardFloorMB: HARD_FLOOR_MB,
});
