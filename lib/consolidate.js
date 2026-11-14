/**
 * lib/consolidate.js — turn a pile of related facts into a conclusion.
 *
 * WHY
 *
 * Everything the plugin writes so far is an APPEND. A user who says the same thing three
 * ways over three weeks gets three facts; a topic that accumulates six fragments is
 * recalled as six lines competing for four slots. That is accumulation, not growth, and it
 * degrades: the more the store knows about a subject, the less of it fits in the prompt.
 *
 * Consolidation is what separates the two. When a group of facts about one subject exceeds
 * a threshold, they are summarised into ONE conclusion, the sources are retired into a
 * `superseded`-style relation (kept, not deleted) so history stays answerable, and the
 * conclusion takes their place in recall.
 *
 * DESIGN CONSTRAINTS
 *
 *  1. NO MODEL CALL. This runs from maintenance, not from a turn, and must be free and
 *     deterministic. The summary is built by selecting the most informative sentences, not
 *     by asking a model to paraphrase — a paraphrase we cannot verify is worse than a
 *     stitched quote we can.
 *  2. LOSSLESS ON SOURCES. Sources are archived, never deleted, and the conclusion records
 *     which ids it came from (`consolidates` in the tags and an edge per source).
 *  3. ONE SUBJECT ONLY. Grouping is by shared content words AND category; a loose word
 *     overlap across unrelated topics must not merge them.
 *  4. IDEMPOTENT. Running twice does not produce a second conclusion: the group is derived
 *     from live facts, and the sources of a conclusion are archived so they leave the pool.
 *
 * Pure functions for grouping/selection; one side-effecting helper for the write.
 */

/** A group needs at least this many live facts before it is worth compressing. */
export const MIN_GROUP_SIZE = 4;

/** Sources must share at least this fraction of content words to be one subject. */
export const GROUP_SIMILARITY = 0.35;

/** A conclusion longer than this is not a conclusion. */
const MAX_CONCLUSION = 600;

/** Stop words, same list as lib/health.js — kept local so the two modules stay independent. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'user',
  '的', '了', '是', '在', '和', '与', '或', '都', '也', '就', '不', '有', '这', '那',
]);

export function contentWords(text) {
  const raw = String(text ?? '').toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z0-9]{3,}/g) ?? [];
  return raw.filter((w) => !STOP_WORDS.has(w));
}

/** Overlap of two facts' content words, relative to the SMALLER set (containment, not Jaccard). */
export function overlap(a, b) {
  const wa = new Set(contentWords(a));
  const wb = new Set(contentWords(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size);
}

/**
 * Group live facts into subjects.
 *
 * Greedy single-pass clustering: each fact joins the first existing group it overlaps
 * enough with, else starts a new one. Greedy is deliberate — the corpus is small (hundreds),
 * and a stable, explainable grouping beats an optimal one nobody can predict.
 *
 * Category must match: two facts about ports in `环境` and `偏好` are not the same subject.
 */
export function groupBySubject(facts, { minSimilarity = GROUP_SIMILARITY } = {}) {
  const list = (Array.isArray(facts) ? facts : []).filter((f) => f && !f.archived && !f.superseded);
  const groups = [];

  for (const fact of list) {
    const text = String(fact.content ?? '');
    const category = String(fact.category ?? 'general');
    let placed = false;
    for (const group of groups) {
      if (group.category !== category) continue;
      if (overlap(text, group.representative) >= minSimilarity) {
        group.facts.push(fact);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({ category, representative: text, facts: [fact] });
    }
  }

  return groups
    .map((g) => {
      // Recomputed so a group's identity reflects all its members, not just the first.
      const words = new Map();
      for (const f of g.facts) {
        for (const w of contentWords(f.content)) words.set(w, (words.get(w) ?? 0) + 1);
      }
      const shared = [...words.entries()].filter(([, n]) => n >= 2).map(([w]) => w);
      return { ...g, shared };
    })
    .filter((g) => g.facts.length >= 2);
}

/**
 * Build one conclusion from a group.
 *
 * Deterministic and verifiable: the shared subject words become the title, and the group's
 * DISTINCT statements are appended in file order. Nothing is paraphrased, so every claim in
 * the conclusion is traceable to a source fact — which is the property that makes it safe
 * to inject as a single line.
 */
export function buildConclusion(group) {
  const facts = Array.isArray(group?.facts) ? group.facts : [];
  if (facts.length === 0) return '';

  const subject = (group.shared ?? []).slice(0, 6).join('、');
  const category = String(group.category ?? 'general');
  const title = subject
    ? `【${category}】关于 ${subject} 的结论`
    : `【${category}】${String(facts[0]?.content ?? '').slice(0, 30)} 相关结论`;

  // Distinct statements, longest-first so the informative ones survive the length cap.
  const seen = new Set();
  const statements = [];
  for (const f of [...facts].sort((a, b) => String(b.content ?? '').length - String(a.content ?? '').length)) {
    const text = String(f.content ?? '').replace(/\s+/g, ' ').trim();
    // Drop a statement fully contained in one already taken.
    if (statements.some((s) => s.includes(text))) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    statements.push(text);
  }

  let body = statements.join('；');
  if (body.length > MAX_CONCLUSION - title.length - 4) {
    body = body.slice(0, Math.max(0, MAX_CONCLUSION - title.length - 5)) + '…';
  }
  return `${title}：${body}`;
}

/**
 * Plan the consolidation for a whole store: which groups to compress, and into what.
 *
 * Returns plans only; nothing is written. `sources` lists the fact ids that would be
 * retired, so a caller can dry-run the operation.
 */
export function planConsolidation(facts, { minGroupSize = MIN_GROUP_SIZE } = {}) {
  const groups = groupBySubject(facts).filter((g) => g.facts.length >= minGroupSize);
  return groups.map((group) => {
    const conclusion = buildConclusion(group);
    const sources = group.facts.map((f) => String(f.id)).filter(Boolean);
    return {
      category: String(group.category ?? 'general'),
      subjects: group.shared.slice(0, 6),
      sources,
      sourceCount: sources.length,
      conclusion,
      // Signature makes the operation idempotent: same sources -> same signature.
      signature: sources.slice().sort().join(','),
    };
  }).filter((p) => p.sourceCount >= minGroupSize && p.conclusion.length > 0);
}

/**
 * Execute the consolidation: write each conclusion, then retire its sources.
 *
 * Retirement uses `setFactSuperseded`, so the sources stay on disk and remain answerable
 * through history queries — a conclusion never destroys its evidence.
 *
 * @returns {Promise<{ consolidated: number, written: Array, retired: number, skipped: number }>}
 */
export async function consolidate({ store, facts, logger, minGroupSize = MIN_GROUP_SIZE } = {}) {
  const log = logger ?? {};
  if (!store || typeof store.upsertFact !== 'function') {
    return { consolidated: 0, written: [], retired: 0, skipped: 0 };
  }
  if (typeof store.setFactSuperseded !== 'function') {
    return { consolidated: 0, written: [], retired: 0, skipped: 0 };
  }

  const plans = planConsolidation(facts, { minGroupSize });
  const written = [];
  let retired = 0;

  for (const plan of plans) {
    try {
      const fact = await store.upsertFact({
        content: plan.conclusion,
        category: plan.category,
        tags: ['consolidated', ...plan.subjects.slice(0, 4)],
        trust: 0.75,
        source: 'consolidation',
      });
      if (!fact?.id) continue;

      // Link and retire every source.
      for (const sourceId of plan.sources) {
        if (String(sourceId) === String(fact.id)) continue;
        try {
          if (typeof store.addEdge === 'function') {
            await store.addEdge(String(fact.id), sourceId, 'consolidates');
          }
        } catch { /* edge optional */ }
        try {
          await store.setFactSuperseded(sourceId, true, String(fact.id));
          retired += 1;
        } catch { /* one stubborn row must not abort the whole run */ }
      }

      written.push({ id: String(fact.id), sources: plan.sources.length, category: plan.category });
    } catch {
      /* one bad group must not stop the rest */
    }
  }

  if (written.length > 0) {
    try {
      log.info?.(`[dsh-memory] consolidated ${written.length} group(s), retired ${retired} source fact(s)`);
    } catch { /* logging is optional */ }
  }

  return { consolidated: written.length, written, retired, skipped: plans.length - written.length };
}

export const CONSOLIDATE_INFO = Object.freeze({
  minGroupSize: MIN_GROUP_SIZE,
  groupSimilarity: GROUP_SIMILARITY,
  maxConclusion: MAX_CONCLUSION,
});
