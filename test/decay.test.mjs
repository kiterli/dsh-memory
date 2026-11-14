/**
 * lib/decay.js contract tests — the memory-lifetime guarantee.
 *
 * These exist because of a real regression: the first implementation multiplied the
 * three decay factors instead of blending them, which gave an effective half-life of
 * 1.58 days instead of the documented 3.5. Combined with a hard `dynTrust >= 0.2`
 * recall cutoff, every non-permanent fact became invisible to BOTH automatic recall and
 * memory_search on day 4 — a "long-term" memory with a 4-day lifetime that nobody noticed
 * for weeks because nothing asserted the shape of the curve.
 *
 * The promises asserted here are user-visible:
 *   - a week-old memory is still recalled,
 *   - a year-old memory is still findable,
 *   - fresher facts outrank staler ones,
 *   - permanence really is exempt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY_MS,
  LAYERS,
  DECAY_FLOOR,
  RECALL_MIN_DYN_TRUST,
  ageInDays,
  layerFreshness,
  decayStrength,
  flooredStrength,
  effectiveHalfLifeDays,
  dynamicTrust,
  relativeAge,
  trustTone,
  DECAY_INFO,
} from '../lib/decay.js';

const NOW = 1_700_000_000_000;
const daysAgo = (d) => NOW - d * DAY_MS;
const trustAt = (days, trust = 0.8) => dynamicTrust({ trust, createdAt: daysAgo(days) }, NOW);

/* ------------------------------------------------------------------- lifetime */

test('decay: a week-old memory is still above the recall floor', () => {
  assert.ok(trustAt(7) >= RECALL_MIN_DYN_TRUST, `7d=${trustAt(7)} must be >= ${RECALL_MIN_DYN_TRUST}`);
});

test('decay: a year-old memory is still findable (decay ranks, it does not delete)', () => {
  assert.ok(trustAt(365) >= RECALL_MIN_DYN_TRUST, `365d=${trustAt(365)} must be >= ${RECALL_MIN_DYN_TRUST}`);
});

test('decay: the old 1.58-day regression cannot come back', () => {
  // Under the multiplied formula, day 4 scored 0.172*0.8=0.138 and day 7 scored 0.037
  // — both below the old 0.2 cutoff, i.e. invisible. These are the exact ages that broke.
  for (const day of [4, 5, 7, 14, 30]) {
    assert.ok(trustAt(day) >= RECALL_MIN_DYN_TRUST, `day ${day} must survive (got ${trustAt(day)})`);
  }
});

test('decay: the effective half-life is honest and in a sane band', () => {
  const halfLife = effectiveHalfLifeDays();
  assert.ok(halfLife >= 2 && halfLife <= 14, `half-life ${halfLife} outside [2,14]`);
  // It must be materially longer than the buggy 1.58 days.
  assert.ok(halfLife > 3, `half-life ${halfLife} unexpectedly short`);
});

test('decay: trust decreases monotonically with age', () => {
  let previous = Infinity;
  for (const day of [0, 1, 3, 7, 30, 180, 365, 1000]) {
    const value = trustAt(day);
    assert.ok(value <= previous, `trust must not increase with age (day ${day})`);
    previous = value;
  }
});

/* ---------------------------------------------------------------------- floor */

test('decay: strength never falls below the floor', () => {
  assert.equal(DECAY_FLOOR, 0.35);
  assert.ok(flooredStrength(0) <= 1.0000001);
  for (const day of [10, 100, 1000, 100000]) {
    assert.ok(flooredStrength(day) >= DECAY_FLOOR, `strength at ${day}d must stay at/above the floor`);
  }
  assert.ok(Math.abs(flooredStrength(100000) - DECAY_FLOOR) < 1e-6, 'very old facts settle exactly on the floor');
});

test('decay: fresh facts start at full strength', () => {
  assert.equal(decayStrength(0), 1);
  assert.ok(Math.abs(flooredStrength(0) - 1) < 1e-9);
  assert.ok(Math.abs(trustAt(0, 0.8) - 0.8) < 1e-9);
});

/* ------------------------------------------------------------------ exemption */

test('decay: permanent facts are exempt from decay', () => {
  assert.equal(dynamicTrust({ trust: 0.9, permanent: 1, createdAt: daysAgo(3650) }, NOW), 0.9);
  assert.ok(dynamicTrust({ trust: 0.9, createdAt: daysAgo(3650) }, NOW) < 0.9);
});

test('decay: trust is clamped to [0,1]', () => {
  assert.equal(dynamicTrust({ trust: 5, createdAt: NOW }, NOW), 1);
  assert.equal(dynamicTrust({ trust: -3, createdAt: NOW }, NOW), 0);
  assert.equal(dynamicTrust({ trust: 0.5 }, NOW), 0.5, 'missing createdAt counts as brand new');
});

/* --------------------------------------------------------------------- layers */

test('decay: the three layers are blended, not multiplied', () => {
  assert.equal(LAYERS.length, 3);
  const weightSum = LAYERS.reduce((sum, l) => sum + l.weight, 0);
  assert.ok(Math.abs(weightSum - 1) < 1e-9, 'layer weights must sum to 1');

  // Blending means one year of age cannot zero the strength the way multiplication did.
  const strongest = Math.max(...LAYERS.map((l) => Math.pow(0.5, 365 / l.halfLifeDays)));
  assert.ok(decayStrength(365) >= 0, 'blend is never negative');
  assert.ok(decayStrength(365) < strongest, 'blend sits below the strongest single layer');
});

test('decay: layerFreshness reports each layer in order', () => {
  const rows = layerFreshness(0);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.ok(Math.abs(row.freshness - 1) < 1e-9);
  const old = layerFreshness(30);
  // keyword layer (longest half-life) must be freshest
  assert.ok(old[2].freshness > old[0].freshness);
});

/* ---------------------------------------------------------------------- age */

test('decay: ageInDays is never negative', () => {
  assert.equal(ageInDays(NOW + 10 * DAY_MS, NOW), 0, 'future timestamps clamp to 0');
  assert.equal(ageInDays(undefined, NOW), 0);
  assert.equal(ageInDays(daysAgo(3), NOW), 3);
});

/* ------------------------------------------------------------------ language */

test('decay: relativeAge speaks in human units', () => {
  assert.equal(relativeAge(NOW, NOW), '刚刚');
  assert.equal(relativeAge(NOW - 2 * 60 * 60 * 1000, NOW), '2 小时前');
  assert.equal(relativeAge(daysAgo(3), NOW), '3 天前');
  assert.equal(relativeAge(daysAgo(60), NOW), '2 个月前');
  assert.equal(relativeAge(daysAgo(400), NOW), '1 年前');
  // Never "0 天前" / "0 小时前"
  assert.doesNotMatch(relativeAge(NOW - 60 * 1000, NOW), /^0 /);
});

test('decay: trustTone hedges by confidence', () => {
  assert.equal(trustTone(0.95), '很确定');
  assert.equal(trustTone(0.7), '记得');
  assert.equal(trustTone(0.45), '大概记得');
  assert.equal(trustTone(0.2), '隐约记得');
  assert.equal(trustTone(1), '很确定');
  assert.equal(trustTone(0), '隐约记得');
});

test('decay: DECAY_INFO exposes the contract constants', () => {
  assert.equal(DECAY_INFO.floor, DECAY_FLOOR);
  assert.equal(DECAY_INFO.recallMinDynTrust, RECALL_MIN_DYN_TRUST);
  assert.equal(DECAY_INFO.layers.length, 3);
  assert.ok(DECAY_INFO.effectiveHalfLifeDays > 3);
});
