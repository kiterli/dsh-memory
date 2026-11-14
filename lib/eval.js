/**
 * lib/eval.js — measure retrieval quality, honestly.
 *
 * WHY
 *
 * Every other test in this plugin answers "is the mechanism intact?": does the store open,
 * does decay keep facts alive, does a superseded fact stay out. None of them answer "does a
 * real question actually find the right memory?" — and that is the only question a user
 * cares about. Without a measurement, every tuning decision is guesswork.
 *
 * THE HONESTY PROBLEM, AND HOW THIS HANDLES IT
 *
 * A test set written by the same person who wrote the retriever is biased. Two specific
 * traps, both of which inflate the score:
 *
 *   1. LITERAL QUERIES. If a query is the fact's own wording, it only tests substring
 *      matching. That number will look great and mean nothing. KRouter is explicit about
 *      this: given the same two rules, plain BM25 ties with it.
 *   2. ANSWERABLE-ONLY SETS. A retriever that always returns something scores 100% recall.
 *      Refusal has to be measured as part of the same run or the number is fiction.
 *
 * So the fixture format forces every query into one of three kinds, and the report keeps
 * them apart:
 *
 *   - `literal`     — the fact's own words. A floor, not a grade.
 *   - `paraphrase`  — a question in different words. THE measurement.
 *   - `unanswerable`— nothing in the store can answer it. Measures whether it refuses.
 *
 * Every score is reported per-kind, with the counts beside it. No single headline number.
 *
 * Pure functions only; running a set against a live store happens in tools/eval-recall.mjs.
 */

export const QUERY_KINDS = Object.freeze(['literal', 'paraphrase', 'unanswerable']);

/** Default cutoff for "did we find it". */
export const DEFAULT_K = 5;

const emptyScore = () => ({ atK: { }, total: 0, hits: 0 });

/**
 * Normalise a fixture into a validated list, reporting what was wrong with it.
 *
 * A malformed fixture must fail LOUDLY: a benchmark that silently skips half its rows is
 * worse than no benchmark.
 */
export function validateFixture(fixture) {
  const errors = [];
  if (!fixture || typeof fixture !== 'object') {
    return { ok: false, errors: ['fixture is not an object'], queries: [] };
  }
  const raw = Array.isArray(fixture.queries) ? fixture.queries : null;
  if (!raw) return { ok: false, errors: ['fixture.queries is not an array'], queries: [] };

  const queries = [];
  raw.forEach((q, i) => {
    const at = `queries[${i}]`;
    if (!q || typeof q !== 'object') { errors.push(`${at} is not an object`); return; }
    const text = String(q.q ?? '').trim();
    if (!text) { errors.push(`${at}.q is empty`); return; }
    const kind = String(q.kind ?? '');
    if (!QUERY_KINDS.includes(kind)) {
      errors.push(`${at}.kind must be one of ${QUERY_KINDS.join('|')}, got "${kind}"`);
      return;
    }
    const expect = Array.isArray(q.expectIds) ? q.expectIds.map(String).filter(Boolean) : [];
    if (kind !== 'unanswerable' && expect.length === 0) {
      errors.push(`${at} (${kind}) has no expectIds — an answerable query must name what answers it`);
      return;
    }
    if (kind === 'unanswerable' && expect.length > 0) {
      errors.push(`${at} is marked unanswerable but lists expectIds`);
      return;
    }
    queries.push({ q: text, kind, expectIds: expect, note: q.note == null ? null : String(q.note) });
  });

  return { ok: errors.length === 0, errors, queries };
}

/**
 * Score one run.
 *
 * @param {Array<{q:string, kind:string, expectIds:string[]}>} queries  validated queries
 * @param {Function} runOne  async (query) => { facts: [{id}], status: 'direct'|'related'|'none' }
 * @param {object} [opts]
 * @param {number} [opts.k=5]
 * @returns {Promise<object>} per-kind and overall metrics
 */
export async function scoreQueries(queries, runOne, { k = DEFAULT_K } = {}) {
  const rows = [];

  for (const item of queries) {
    let result;
    try {
      result = await runOne(item.q);
    } catch (error) {
      rows.push({
        q: item.q, kind: item.kind, error: String(error?.message ?? error),
        rank: null, hit: false, status: 'error', returned: 0,
      });
      continue;
    }
    const facts = Array.isArray(result?.facts) ? result.facts : [];
    const ids = facts.map((f) => String(f.id));
    const status = String(result?.status ?? 'none');

    if (item.kind === 'unanswerable') {
      // Correct behaviour: nothing returned, or at least an explicit refusal.
      const refused = ids.length === 0 || status === 'none';
      rows.push({
        q: item.q, kind: item.kind, rank: null,
        hit: refused, status, returned: ids.length,
        // A near miss that is still labelled "related" is not a refusal, but it is not a
        // confident wrong answer either — recorded separately so the report can say so.
        softMiss: ids.length > 0 && status === 'related',
      });
      continue;
    }

    // Answerable: rank of the first expected id (1-based), or null.
    let rank = null;
    for (let i = 0; i < ids.length; i += 1) {
      if (item.expectIds.includes(ids[i])) { rank = i + 1; break; }
    }
    rows.push({
      q: item.q, kind: item.kind, rank,
      hit: rank !== null && rank <= k,
      status, returned: ids.length,
    });
  }

  return summarize(rows, { k });
}

/** Turn per-query rows into the report. Pure. */
export function summarize(rows, { k = DEFAULT_K } = {}) {
  const byKind = {};
  for (const kind of QUERY_KINDS) {
    const subset = rows.filter((r) => r.kind === kind);
    if (subset.length === 0) { byKind[kind] = null; continue; }

    const hits = subset.filter((r) => r.hit).length;
    const reciprocal = subset
      .map((r) => (r.rank != null ? 1 / r.rank : 0))
      .reduce((a, b) => a + b, 0);

    byKind[kind] = {
      total: subset.length,
      hits,
      [`recall@${k}`]: subset.length > 0 ? round(hits / subset.length) : 0,
      mrr: subset.length > 0 ? round(reciprocal / subset.length) : 0,
      errors: subset.filter((r) => r.error).length,
      ...(kind === 'unanswerable'
        ? {
            refusalRate: subset.length > 0 ? round(hits / subset.length) : 0,
            softMisses: subset.filter((r) => r.softMiss).length,
            confidentWrong: subset.filter((r) => !r.hit && !r.softMiss).length,
          }
        : {
            notFound: subset.filter((r) => r.rank === null).length,
            foundButLate: subset.filter((r) => r.rank !== null && r.rank > k).length,
          }),
    };
  }

  const answerable = rows.filter((r) => r.kind !== 'unanswerable');
  const overall = {
    total: rows.length,
    errors: rows.filter((r) => r.error).length,
    answerableRecall: answerable.length > 0
      ? round(answerable.filter((r) => r.hit).length / answerable.length)
      : null,
  };

  return {
    k,
    byKind,
    overall,
    rows,
    /**
     * A single verdict that is deliberately NOT an average: a retriever can ace literal
     * queries and be useless, so paraphrased recall is what gates the grade.
     */
    verdict: grade(byKind),
  };
}

/**
 * Grade on the measurement that matters (paraphrase), with refusal as a correctness
 * requirement rather than a bonus. Literal recall is reported but never sufficient.
 */
export function grade(byKind) {
  const para = byKind?.paraphrase;
  const unans = byKind?.unanswerable;
  if (!para && !unans) return 'unmeasured';

  const paraRecall = para ? para[`recall@${5}`] ?? 0 : null;
  const refusal = unans ? unans.refusalRate : null;

  if (paraRecall === null) return 'unmeasured';
  // A retriever that answers everything is not good, it is unreliable. The threshold is
  // "strictly better than a coin flip" — half the unanswerable probes slipping through is
  // not a pass, it is the boundary case where a confident wrong answer is likely.
  if (refusal !== null && refusal <= 0.5) return 'over-eager';
  if (paraRecall >= 0.8) return 'good';
  if (paraRecall >= 0.5) return 'fair';
  return 'poor';
}

function round(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/**
 * Derive candidate queries from real facts.
 *
 * TWO KINDS, and the difference is the whole point:
 *   - `literal`: a CONTIGUOUS slice taken verbatim from the fact. Cheap and automatic, but
 *     it only proves the keyword path works. Reported as a floor, never as a grade.
 *   - `unanswerable`: built from vocabulary that appears NOWHERE in the store, so a correct
 *     retriever must refuse.
 *
 * WHY THE SLICE MUST BE CONTIGUOUS: an earlier version joined the two longest words of a
 * fact into one query. The store matches `content.includes(query)`, so a query made of
 * words that were never adjacent can never match — every literal row failed and the
 * benchmark was measuring nothing but its own bug. A literal query has to be a substring
 * of the text it expects to find.
 *
 * Paraphrase queries are deliberately NOT generated: a machine cannot reliably write a
 * question in different words without also revealing whether it is answerable, and a fake
 * paraphrase would be exactly the self-deception this module exists to avoid. They are
 * added by hand through `addParaphrase`.
 */
export function buildLiteralQueries(facts, { max = 40, sliceChars = 18 } = {}) {
  const out = [];
  const seen = new Set();
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (out.length >= max) break;
    const id = String(fact?.id ?? '');
    const content = String(fact?.content ?? '').trim();
    if (!id || content.length < 8) continue;

    // Take a contiguous slice from a content-rich region of the fact: prefer a stretch that
    // contains CJK or latin words, and avoid a slice that is only punctuation/paths.
    const slice = pickContiguousSlice(content, sliceChars);
    if (!slice) continue;
    const key = slice.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      q: slice,
      kind: 'literal',
      expectIds: [id],
      note: 'verbatim contiguous slice of the fact (a floor, not a grade)',
    });
  }
  return out;
}

/**
 * Pick a CONTIGUOUS, content-bearing slice out of a text.
 *
 * Deliberately simple: walk the longest run of word characters in the original order and
 * cut `size` characters out of its middle. The result is always a substring of the input,
 * which is the property the store's matching requires.
 */
export function pickContiguousSlice(text, size = 18) {
  const src = String(text ?? '');
  if (src.length === 0) return '';

  // Find the longest contiguous stretch of CJK/latin word characters.
  const runs = src.match(/[\u4e00-\u9fa5A-Za-z0-9_.\-\\/]{6,}/g) ?? [];
  if (runs.length === 0) return '';
  const longest = runs.reduce((a, b) => (b.length > a.length ? b : a), '');

  const want = Math.min(size, longest.length);
  if (want < 6) return '';
  const start = Math.max(0, Math.floor((longest.length - want) / 2));
  const slice = longest.slice(start, start + want);
  // Must still be a substring of the ORIGINAL text (it is, by construction) and carry words.
  return src.includes(slice) && /[\u4e00-\u9fa5A-Za-z]{3,}/.test(slice) ? slice : '';
}

/** Unanswerable probes built from vocabulary that is not in the corpus. */
export function buildUnanswerableQueries({ count = 6, seed = 1 } = {}) {
  const pool = [
    '量子纠缠退相干时间的实验测量',
    '拜占庭将军问题在异步网络下的下界',
    '巴洛克时期管风琴的音栓配比',
    '候鸟磁感应导航的分子机制',
    '古埃及莎草纸的鞣制工艺',
    '热带雨林冠层碳通量的季节变化',
    '中世纪手抄本使用的铁胆墨水配方',
    '鸟类迁徙路线的地磁倾角假说',
  ];
  const out = [];
  for (let i = 0; i < Math.min(count, pool.length); i += 1) {
    out.push({ q: pool[(i + seed) % pool.length], kind: 'unanswerable', expectIds: [], note: 'nothing in this store can answer it' });
  }
  return out;
}

/**
 * Build a full fixture from a store's facts.
 * Begins with no paraphrase rows; `addParaphrase` fills them in.
 */
export function buildFixture(facts, { literalMax = 20, unanswerableCount = 6, now = Date.now() } = {}) {
  return {
    name: 'dsh-memory recall eval',
    builtAt: new Date(now).toISOString(),
    note: 'literal rows are auto-derived (a floor, not a grade); paraphrase rows are hand-written and are the real measurement',
    queries: [
      ...buildLiteralQueries(facts, { max: literalMax }),
      ...buildUnanswerableQueries({ count: unanswerableCount }),
    ],
  };
}

/** Append a hand-written paraphrase query. Kept separate so the report can grade on it. */
export function addParaphrase(fixture, { q, expectIds, note = null }) {
  const text = String(q ?? '').trim();
  const ids = (Array.isArray(expectIds) ? expectIds : []).map(String).filter(Boolean);
  if (!text || ids.length === 0) return fixture;
  if (!Array.isArray(fixture.queries)) fixture.queries = [];
  fixture.queries.push({ q: text, kind: 'paraphrase', expectIds: ids, note });
  return fixture;
}

export const EVAL_INFO = Object.freeze({
  kinds: QUERY_KINDS,
  defaultK: DEFAULT_K,
});
