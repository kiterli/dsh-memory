/**
 * lib/decay.js — the ONE place three-layer time decay is computed.
 *
 * Why this file exists (and why the formula changed):
 *
 * The three-layer model keeps three retrieval strengths per fact — body (3.5 day
 * half-life), summary (4.8 day) and keyword (7.1 day). The previous implementation
 * MULTIPLIED the three per-layer factors together:
 *
 *     dynTrust = trust * 0.5^(age/3.5) * 0.5^(age/4.8) * 0.5^(age/7.1)
 *
 * Exponents add when bases multiply, so the real half-life was
 * 1 / (1/3.5 + 1/4.8 + 1/7.1) = 1.58 days, not 3.5. Combined with the hard
 * `dynTrust >= 0.2` recall cutoff this meant every non-permanent fact became
 * invisible to BOTH automatic recall and `memory_search` on day 4 — a "long-term"
 * memory with a 4-day lifetime.
 *
 * Two independent fixes:
 *
 *  1. LAYERS ARE BLENDED, NOT MULTIPLIED. The per-layer factors are combined by a
 *     weighted arithmetic mean (weights sum to 1), so the blend starts at 1 and
 *     falls smoothly, and the effective half-life is a defensible ~4.6 days rather
 *     than an accidental 1.58.
 *
 *  2. DECAY RANKS, IT DOES NOT DELETE. The blend is squashed into
 *     [DECAY_FLOOR, 1] before it touches trust. A year-old fact therefore keeps
 *     DECAY_FLOOR (0.35) of its trust — enough to stay above the recall floor and
 *     remain findable, while still ranking far below a fresh fact. Removing a
 *     memory is `archiveOldFacts`'s job, and that requires explicit staleness
 *     (old + never recalled + low trust), never merely the passage of time.
 *
 * Pure functions, no imports, no I/O — so the agent layer and the store layer
 * cannot drift apart again.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Per-layer half-lives (days) and blend weights (must sum to 1). */
export const LAYERS = Object.freeze([
  Object.freeze({ key: 'bodyStr', label: 'body', halfLifeDays: 3.5, weight: 0.5 }),
  Object.freeze({ key: 'sumStr', label: 'summary', halfLifeDays: 4.8, weight: 0.3 }),
  Object.freeze({ key: 'kwStr', label: 'keyword', halfLifeDays: 7.1, weight: 0.2 }),
]);

/**
 * Fraction of trust an arbitrarily old fact keeps. 0.35 is deliberate: a year-old
 * fact with trust 0.8 scores 0.28, which is above RECALL_MIN_DYN_TRUST (0.12), so it
 * is still retrieved — but a fresh fact at 0.80 outranks it by ~2.9x, so recency
 * still wins whenever both are relevant.
 */
export const DECAY_FLOOR = 0.35;

/**
 * Safety net, NOT the primary filter. Previously 0.2, which combined with the
 * accidental 1.58-day half-life silently deleted memory on day 4. With the floor in
 * place the value can be low: it only excludes facts so decayed that something else
 * already went wrong.
 */
export const RECALL_MIN_DYN_TRUST = 0.12;

/** A fact must be at least this old, and never recalled, before archiving considers it. */
export const ARCHIVE_MIN_AGE_DAYS = 180;

/** Facts below this raw trust are candidates for archival once old and unused. */
export const ARCHIVE_MAX_TRUST = 0.5;

/**
 * How much a fact is used, as a 0..1 multiplier on its decay curve.
 *
 * This is the difference between "old" and "forgotten". A fact the user keeps coming back
 * to should not fade at the same rate as one recorded once and never touched again —
 * KRouter expresses this by down-weighting pages nobody has used in 60 days; here it is a
 * continuous factor so ranking, not deletion, carries the signal.
 *
 * Shape: 1 recall = 1.0x decay (unchanged, no opinion yet); 10 recalls ≈ 0.55x (decays
 * slowly); 50+ recalls ≈ 0.18x (nearly does not decay). Once a fact is recalled a lot AND
 * recently, it is effectively treated as permanent-by-use.
 *
 * `lastHitAt` matters as much as the count: 50 recalls two years ago should not keep a fact
 * alive, so the boost itself decays with time since the last hit.
 */
export const USAGE_NEUTRAL = 1;
export const USAGE_FLOOR = 0.15;

/** Recency factor of the usage boost: full within a week, halved after ~3 months. */
const USAGE_HALF_LIFE_DAYS = 90;

/**
 * The decay multiplier for a fact, in [USAGE_FLOOR, 1].
 * 1 means "decay normally"; lower means "decay more slowly".
 */
export function usageFactor(fact, now = Date.now()) {
  const recalls = Math.max(0, Number(fact?.accessCount) || 0);
  if (recalls <= 1) return USAGE_NEUTRAL;

  // Logarithmic: the first few recalls matter most, and the curve flattens so that one
  // very popular fact cannot permanently dominate the ranking.
  const strength = Math.min(1, Math.log10(recalls) / Math.log10(50));

  // Being used long ago is weaker evidence than being used recently.
  const lastHit = Number(fact?.lastHitAt) || 0;
  const sinceDays = lastHit > 0 ? Math.max(0, (now - lastHit) / DAY_MS) : 365;
  const recency = Math.pow(0.5, sinceDays / USAGE_HALF_LIFE_DAYS);

  const boost = strength * recency;
  return Math.max(USAGE_FLOOR, USAGE_NEUTRAL - boost * (USAGE_NEUTRAL - USAGE_FLOOR));
}

const clamp01 = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

/** Age of a fact in days (never negative; a missing createdAt counts as brand new). */
export function ageInDays(createdAt, now = Date.now()) {
  const created = Number(createdAt);
  if (!Number.isFinite(created) || created <= 0) return 0;
  return Math.max(0, (now - created) / DAY_MS);
}

/** Per-layer freshness factors, freshest first, for diagnostics and tests. */
export function layerFreshness(ageDays) {
  const age = Math.max(0, Number(ageDays) || 0);
  return LAYERS.map((layer) => ({
    label: layer.label,
    halfLifeDays: layer.halfLifeDays,
    weight: layer.weight,
    freshness: Math.pow(0.5, age / layer.halfLifeDays),
  }));
}

/**
 * Weighted arithmetic blend of the three layer factors: 1 at age 0, falling toward 0.
 * This is the "raw" strength before the floor is applied.
 */
export function decayStrength(ageDays) {
  const age = Math.max(0, Number(ageDays) || 0);
  let strength = 0;
  for (const layer of LAYERS) {
    strength += layer.weight * Math.pow(0.5, age / layer.halfLifeDays);
  }
  return strength;
}

/** Blend strength after the floor: never drops below DECAY_FLOOR. */
export function flooredStrength(ageDays) {
  const strength = decayStrength(ageDays);
  return DECAY_FLOOR + (1 - DECAY_FLOOR) * clamp01(strength);
}

/**
 * The age at which the *floored* strength reaches 0.5 of its initial value, i.e. the
 * honest half-life of this model. Computed numerically so the documentation cannot
 * drift from the formula.
 */
export function effectiveHalfLifeDays() {
  const target = 0.5;
  let low = 0;
  let high = 4096;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (flooredStrength(mid) > target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Dynamic trust used for ranking and for the recall floor.
 *
 * `permanent` facts are exempt: they never decay, so a user-pinned or repeatedly-used
 * fact keeps its full trust forever.
 *
 * Accepts a fact-shaped object so both the store and the agent layer pass real rows.
 */
export function dynamicTrust(fact, now = Date.now()) {
  const trust = clamp01(fact?.trust ?? 0.5);
  if (fact?.permanent) return trust;
  const age = ageInDays(fact?.createdAt, now);
  // Usage stretches the curve: a heavily-used fact decays more slowly. Implemented by
  // dividing the age, which is exactly "same shape, slower clock" — so a well-used fact
  // still fades eventually, just later.
  const stretch = usageFactor(fact, now);
  const effectiveAge = age * stretch;
  return clamp01(trust * flooredStrength(effectiveAge));
}

/**
 * Human-facing age label used in the injected memory block ("3 天前").
 * Coarse on purpose: a model should not be told "2.7 days", it should be told
 * "3 天前" the way a person would remember.
 */
export function relativeAge(createdAt, now = Date.now()) {
  const days = ageInDays(createdAt, now);
  if (days < 1 / 24) return '刚刚';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} 小时前`;
  if (days < 30) return `${Math.round(days)} 天前`;
  if (days < 365) return `${Math.round(days / 30)} 个月前`;
  return `${Math.round(days / 365)} 年前`;
}

/**
 * Map trust onto the hesitation a person would show when recalling something.
 * The model gets to sound appropriately unsure instead of reciting stale memory as fact.
 */
export function trustTone(trust) {
  const t = clamp01(trust);
  if (t >= 0.85) return '很确定';
  if (t >= 0.6) return '记得';
  if (t >= 0.4) return '大概记得';
  return '隐约记得';
}

export const DECAY_INFO = Object.freeze({
  layers: LAYERS,
  floor: DECAY_FLOOR,
  recallMinDynTrust: RECALL_MIN_DYN_TRUST,
  effectiveHalfLifeDays: Math.round(effectiveHalfLifeDays() * 100) / 100,
});
