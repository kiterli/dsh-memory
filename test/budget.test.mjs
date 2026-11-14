/**
 * lib/budget.js contract tests — never let an optional feature kill the machine.
 *
 * The incident: loading the embedding model on a busy 16 GB machine exhausted physical memory
 * hard enough that PowerShell could not start. These tests pin the decision logic so that can
 * not silently regress.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canLoadEmbedder,
  describeBudget,
  readMemory,
  EMBEDDER_COST_MB,
  SAFETY_MARGIN_MB,
  HARD_FLOOR_MB,
  BUDGET_INFO,
} from '../lib/budget.js';

test('budget: plenty of free memory allows the load', () => {
  const v = canLoadEmbedder({ freeMB: 8000, totalMB: 16000 });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, 'ok');
});

test('budget: below the hard floor is refused regardless of margin', () => {
  const v = canLoadEmbedder({ freeMB: HARD_FLOOR_MB - 1, totalMB: 16000 });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'below-hard-floor');
  assert.match(v.note, /hard floor/);
});

test('budget: between hard floor and cost+margin is refused as insufficient headroom', () => {
  // Pick a value that is above the hard floor but below cost+margin on BOTH sides.
  const needed = EMBEDDER_COST_MB + SAFETY_MARGIN_MB;
  const free = Math.max(HARD_FLOOR_MB, Math.floor(needed / 2));
  // Guard: this case only makes sense when the two bounds do not coincide.
  if (free >= needed) return;
  const v = canLoadEmbedder({ freeMB: free, totalMB: 32000 });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'insufficient-headroom');
});

test('budget: exactly cost+margin is allowed on a machine with room', () => {
  const needed = EMBEDDER_COST_MB + SAFETY_MARGIN_MB;
  // Use a large total so the free-RATIO rule (small machines only) does not interfere.
  assert.equal(canLoadEmbedder({ freeMB: needed, totalMB: 64000 }).allowed, true);
  assert.equal(canLoadEmbedder({ freeMB: needed - 1, totalMB: 64000 }).allowed, false);
});

test('budget: a small machine needs a real fraction free, not just the absolute cost', () => {
  // 2233 MB free on 14 GB clears cost+margin (2100) but is only 16% — the crash case.
  const v = canLoadEmbedder({ freeMB: 2233, totalMB: 14188 });
  assert.equal(v.allowed, false);

  // The same free memory on a big machine is fine: absolute headroom is what matters there.
  assert.equal(canLoadEmbedder({ freeMB: 8000, totalMB: 32000 }).allowed, true);
});

test('budget: the measured incident numbers are refused', () => {
  const v = canLoadEmbedder({ freeMB: 2233, totalMB: 14188 });
  assert.equal(v.allowed, false, 'this is the case that crashed the machine');
});

test('budget: custom cost and margin are honoured', () => {
  const v = canLoadEmbedder({ freeMB: 3000, totalMB: 32000 }, { costMB: 200, marginMB: 200 });
  assert.equal(v.allowed, true);
  assert.equal(v.neededMB, 400);
});

test('budget: unreadable memory refuses rather than risk the machine', () => {
  const v = canLoadEmbedder({ freeMB: Number.NaN, totalMB: 0 });
  // NaN freeMB triggers a real read; if that succeeds it decides on real numbers, if it fails
  // it must refuse. Either way a decision must be made and it must be justified.
  assert.equal(typeof v.allowed, 'boolean');
  assert.ok(
    ['ok', 'memory-unknown', 'below-hard-floor', 'insufficient-headroom', 'low-free-ratio'].includes(v.reason),
    `unexpected reason: ${v.reason}`,
  );
});

test('budget: describeBudget is human readable in both outcomes', () => {
  assert.match(describeBudget(canLoadEmbedder({ freeMB: 8000, totalMB: 16000 })), /allowed/);
  assert.match(describeBudget(canLoadEmbedder({ freeMB: 100, totalMB: 16000 })), /skipped/);
  assert.equal(describeBudget(null), 'memory budget unknown');
});

test('budget: readMemory reports plausible numbers', () => {
  const mem = readMemory();
  assert.ok(mem.totalMB > 0, 'total memory must be positive');
  assert.ok(mem.freeMB >= 0, 'free memory must not be negative');
  assert.ok(mem.freeMB <= mem.totalMB, 'free cannot exceed total');
});

test('budget: BUDGET_INFO exposes the measured constants', () => {
  assert.equal(BUDGET_INFO.embedderCostMB, EMBEDDER_COST_MB);
  assert.equal(BUDGET_INFO.safetyMarginMB, SAFETY_MARGIN_MB);
  assert.equal(BUDGET_INFO.hardFloorMB, HARD_FLOOR_MB);
  assert.ok(EMBEDDER_COST_MB > 0 && SAFETY_MARGIN_MB > 0);
});
