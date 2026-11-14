/**
 * lib/health.js — find the memories that are dead weight, without a model.
 *
 * WHY
 *
 * A memory store only gets audited when a user notices it answering wrong. Everything that
 * quietly rots — a fact recorded once and never recalled again, two facts that contradict
 * each other, a preference stated three times in different words, an archived fact nobody
 * will ever ask about — accumulates invisibly. The panel shows a count, not a diagnosis.
 *
 * KRouter ships a "checkup" that writes a report of dead locks, dead triggers and pages
 * unused for 60 days. This is the same idea adapted to a fact store: pure statistics, no
 * model call, cheap enough to run on every selfcheck.
 *
 * THE FOUR FINDINGS
 *
 *  1. `never-recalled`  — recorded long ago, accessCount 0. Either the wording never
 *     matches a real question, or the fact was never worth keeping.
 *  2. `contradictions`  — facts linked by a `contradicts` edge. One of them should not be
 *     speaking any more; a `superseded` one is fine, both-live is a defect.
 *  3. `near-duplicates` — two facts whose text is nearly identical. Waste, and a source of
 *     contradictory-looking recalls.
 *  4. `stale-permanent` — marked permanent but never once recalled: the pin was a mistake.
 *
 * Nothing here DELETES. It reports, so a human (or the model) can decide.
 */

import { ageInDays } from './decay.js';

/** A fact must be at least this old before "never recalled" is meaningful. */
export const NEVER_RECALLED_MIN_DAYS = 30;

/** Two facts above this token-overlap are reported as near-duplicates. */
export const DUPLICATE_SIMILARITY = 0.8;

/** Content words: CJK runs and latin words, minus a small stop list. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'user',
  '的', '了', '是', '在', '和', '与', '或', '都', '也', '就', '不', '有', '这', '那',
]);

export function contentWords(text) {
  const raw = String(text ?? '').toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z0-9]{3,}/g) ?? [];
  return raw.filter((w) => !STOP_WORDS.has(w));
}

/** Jaccard similarity over content words. */
export function similarity(a, b) {
  const wa = new Set(contentWords(a));
  const wb = new Set(contentWords(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  if (shared === 0) return 0;
  return shared / (wa.size + wb.size - shared);
}

/**
 * Audit a list of facts.
 *
 * @param {Object[]} facts     every fact, including archived/superseded (pass includeArchived)
 * @param {Object[]} edges     rows from listEdges-like access, or []
 * @param {object}   [options]
 * @param {number}   [options.now=Date.now()]
 * @param {number}   [options.neverRecalledMinDays=NEVER_RECALLED_MIN_DAYS]
 * @returns {{ findings: Object, summary: { total:number, live:number, archived:number, superseded:number, healthy:boolean } }}
 */
export function auditFacts(facts, edges = [], options = {}) {
  const now = Number(options.now) || Date.now();
  const minDays = Number(options.neverRecalledMinDays) || NEVER_RECALLED_MIN_DAYS;
  const list = Array.isArray(facts) ? facts.filter(Boolean) : [];

  const live = list.filter((f) => !f.archived && !f.superseded);
  const archived = list.filter((f) => f.archived);
  const superseded = list.filter((f) => f.superseded);

  // 1. never recalled
  const neverRecalled = live
    .filter((f) => (f.accessCount || 0) === 0)
    .map((f) => ({ id: String(f.id), ageDays: Math.round(ageInDays(f.createdAt, now)), trust: f.trust, content: String(f.content ?? '').slice(0, 80) }))
    .filter((f) => f.ageDays >= minDays)
    .sort((a, b) => b.ageDays - a.ageDays);

  // 2. contradictions — both ends still live is the defect
  const liveIds = new Set(live.map((f) => String(f.id)));
  const contradictions = [];
  for (const e of (Array.isArray(edges) ? edges : [])) {
    if (String(e.type) !== 'contradicts') continue;
    const from = String(e.fromId ?? '');
    const to = String(e.toId ?? '');
    if (!from) continue;
    const bothLive = liveIds.has(from) && liveIds.has(to);
    contradictions.push({ oldId: from, newId: to, bothLive });
  }

  // 3. near-duplicates (live only, O(n^2) but n is small — hundreds, not millions)
  const nearDuplicates = [];
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const sim = similarity(live[i].content, live[j].content);
      if (sim >= DUPLICATE_SIMILARITY) {
        nearDuplicates.push({
          a: String(live[i].id),
          b: String(live[j].id),
          similarity: Number(sim.toFixed(3)),
          sample: String(live[i].content ?? '').slice(0, 60),
        });
      }
    }
  }

  // 4. permanent but never recalled
  const stalePermanent = live
    .filter((f) => f.permanent && (f.accessCount || 0) === 0)
    .map((f) => ({ id: String(f.id), ageDays: Math.round(ageInDays(f.createdAt, now)), content: String(f.content ?? '').slice(0, 80) }))
    .filter((f) => f.ageDays >= minDays);

  const findings = { neverRecalled, contradictions, nearDuplicates, stalePermanent };
  const issueCount = neverRecalled.length + contradictions.filter((c) => c.bothLive).length
    + nearDuplicates.length + stalePermanent.length;

  return {
    findings,
    summary: {
      total: list.length,
      live: live.length,
      archived: archived.length,
      superseded: superseded.length,
      issueCount,
      healthy: issueCount === 0,
    },
  };
}

/**
 * A compact human line for selfcheck / the panel. Empty when everything is fine.
 */
export function describeFindings(audit) {
  if (!audit?.summary || audit.summary.issueCount === 0) return '';
  const { findings } = audit;
  const parts = [];
  if (findings.neverRecalled.length) parts.push(`${findings.neverRecalled.length} 条长期未被召回`);
  const liveContradictions = findings.contradictions.filter((c) => c.bothLive).length;
  if (liveContradictions) parts.push(`${liveContradictions} 对矛盾仍同时生效`);
  if (findings.nearDuplicates.length) parts.push(`${findings.nearDuplicates.length} 组近似重复`);
  if (findings.stalePermanent.length) parts.push(`${findings.stalePermanent.length} 条永久标记但从未召回`);
  return parts.join('；');
}

export const HEALTH_INFO = Object.freeze({
  neverRecalledMinDays: NEVER_RECALLED_MIN_DAYS,
  duplicateSimilarity: DUPLICATE_SIMILARITY,
});
