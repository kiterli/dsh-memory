/**
 * lib/recall.js — the retrieval core, rewritten around ONE question:
 * "can this answer be trusted, and does the caller know how much?"
 *
 * WHY THIS EXISTS
 *
 * The previous `retrieveFacts` returned a bare array. That made four distinct situations
 * look identical to the caller:
 *
 *   1. an exact match on a current fact,
 *   2. a fuzzy vector match that merely shares vocabulary,
 *   3. a fact that a later statement explicitly superseded,
 *   4. nothing at all.
 *
 * Collapsed into one array, (2) and (3) got recited as established fact — the failure mode
 * that makes an assistant confidently wrong about the user's own life. This is the design
 * KRouter gets right and worth adopting: every answer carries a RECEIPT saying where it
 * came from and how confident the system is, and a miss is reported as a miss.
 *
 * THE FOUR CHANGES
 *
 *  1. HARD PRECEDENCE, NOT WEIGHTS. An earlier ranking blended channels with fixed weights
 *     (keyword 1.0 / embedding 0.7 / holo 0.3). A high-scoring fuzzy match could therefore
 *     outrank a literal one. Exact hits now take their slots FIRST and are never displaced;
 *     associative channels only fill what is left.
 *
 *  2. THREE-STATE STATUS. `direct` (exact hit on a live fact), `related` (only associative
 *     or superseded matches), `none` (nothing). The caller can say "I don't have this"
 *     instead of paraphrasing a near miss.
 *
 *  3. SUPERSEDED FACTS GO OUT OF FORCE. `markContradiction` used to multiply trust by 0.3
 *     and leave the fact in the pool, so a corrected belief kept coming back. A contradiction
 *     now retires the old fact: excluded by default, reachable only with `includeSuperseded`
 *     (see lib/store.js#supersedeFact).
 *
 *  4. A RECEIPT PER FACT. Who matched it, how, with what score, how old, whether superseded.
 *     Nothing in the prompt is unattributable any more.
 *
 * Pure functions over an injected store; the caching wrapper stays in lib/agent.js.
 */

import {
  dynamicTrust,
  relativeAge,
  RECALL_MIN_DYN_TRUST,
} from './decay.js';

/** How many slots the exact (literal) channel may claim before associative fills the rest. */
export const DIRECT_QUOTA = 0.6;

/**
 * Associative hits must share at least one real content token with the query.
 *
 * WHY THIS EXISTS — measured, not assumed. On this machine's 12-fact store, HRR's top score
 * for RELEVANT paraphrases ranged 0.0937–0.1867 while for IRRELEVANT queries it ranged
 * 0.0445–0.1353. The two distributions overlap almost completely, so no score threshold can
 * separate them: the old 0.05 floor let "我平时几点上班" match a Qwen-Image recipe.
 *
 * What DOES separate them is a lexical anchor. "OCR 是怎么跑的" shares the token OCR with the
 * OCR fact; "量子纠缠退相干" shares nothing with any fact. Requiring one shared content token
 * before an associative hit is allowed turns a noisy score into an explainable claim.
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
  '的', '了', '是', '在', '和', '与', '或', '都', '也', '就', '不', '有', '这', '那',
  '什么', '怎么', '如何', '为什么', '哪个', '哪些', '可以', '应该', '需要', '一个',
]);

/**
 * Content tokens: CJK bigrams plus latin/digit words of length >= 2.
 */
export function contentTokens(text) {
  const s = String(text ?? '').toLowerCase();
  const tokens = new Set();
  for (const word of (s.match(/[a-z0-9][a-z0-9_.-]{1,}/g) ?? [])) {
    if (!STOP_WORDS.has(word)) tokens.add(word);
  }
  // CJK has no word boundaries: bigrams are the smallest meaningful unit.
  const cjk = s.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const run of cjk) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (!STOP_WORDS.has(bigram)) tokens.add(bigram);
    }
  }
  return tokens;
}

/**
 * Pronouns and bare function words. A BIGRAM CONTAINING ONE OF THESE CARRIERS IS NOT EVIDENCE.
 *
 * This distinction is the difference between a working anchor and a broken one. Relaxing the
 * anchor to "any shared bigram" made recall jump to 0.9 and refusal collapse to 0, because
 * "我平时几点上班" shares `我平`/`时几` shaped noise with unrelated facts — the shared unit
 * existed but carried no subject. A token like `ocr`, `插件`, `端口`, or `显存` identifies
 * WHAT is being asked about; `我平` does not.
 */
const WEAK_CHARS = new Set([
  '我', '你', '他', '她', '它', '们', '的', '了', '是', '在', '和', '与', '或', '也', '就',
  '不', '这', '那', '有', '个', '什', '么', '怎', '如', '何', '为', '哪', '些', '可', '以',
  '应', '该', '需', '要', '会', '能', '一', '时', '候', '多', '少', '点', '吗', '呢', '吧',
  '很', '都', '还', '把', '被', '给', '对', '从', '到', '用', '做', '去', '来', '说', '看',
  '想', '知', '道', '现', '其', '实', '然', '后', '所', '因', '为', '但', '而', '且',
  // Attitude/modal verbs: "我希望你怎么写注释" shares 希望 with a fact about naming, which is
  // a coincidence of phrasing, not a shared subject.
  '希', '望', '喜', '欢', '觉', '得', '认', '让', '请', '帮', '助', '感', '谢', '麻', '烦',
  '平', '常', '般', '通', '每', '天', '次', '现', '在', '已', '经', '还', '再', '又', '才',
]);

/**
 * Whole tokens that appear in almost any technical text and therefore identify nothing.
 *
 * A token only counts as an anchor if it names a SUBJECT. `使用`, `需要`, `可以` are verbs that
 * ride along with any topic: measured, the unanswerable probe "中世纪手抄本使用的铁胆墨水配方"
 * leaked through because it shared 使用 with a fact about Go/Java/Node. Excluding the token
 * wholesale is the fix — a character-level filter cannot express "this word is a verb".
 */
const WEAK_TOKENS = new Set([
  '使用', '需要', '可以', '应该', '能够', '进行', '通过', '采用', '基于', '包括', '提供',
  '支持', '实现', '处理', '问题', '方法', '情况', '时候', '方式', '内容', '部分', '相关',
  'the', 'use', 'used', 'using', 'with', 'and', 'for', 'any', 'all', 'can', 'need',
]);

/** Is one token strong enough to justify an associative hit on its own? */
export function isStrongToken(token) {
  const t = String(token ?? '');
  if (t.length < 2) return false;
  if (WEAK_TOKENS.has(t)) return false;
  if (/^[a-z0-9][a-z0-9_.-]*$/.test(t)) {
    // A latin/digit token names a thing (ocr, pnpm, rtx, 3060); at least 3 chars to count.
    return t.length >= 3;
  }
  // A CJK bigram needs at least one character that is not function-word filler.
  for (const ch of t) if (!WEAK_CHARS.has(ch)) return true;
  return false;
}

/**
 * Does the fact share a STRONG content token with the query? Returns the strong tokens only.
 */
export function lexicalAnchor(query, factText) {
  const q = contentTokens(query);
  if (q.size === 0) return [];
  const f = contentTokens(factText);
  const shared = [];
  for (const t of q) if (f.has(t) && isStrongToken(t)) shared.push(t);
  return shared;
}

/** An exact hit is anything the store's substring/token match returned. */
const MATCH_WEIGHTS = Object.freeze({
  keyword: 1.0,
  trigger: 0.95,
  embedding: 0.7,
  holographic: 0.3,
  superseded: 0.15,
});

/**
 * HRR's score floor. Kept low on purpose: the real gate is the lexical anchor above, not the
 * score. Measured top-score ranges overlap between relevant and irrelevant queries, so a
 * score threshold cannot do this job.
 */
const HRR_MIN_SCORE = 0.05;

/**
 * The semantic channel's floor, measured rather than guessed.
 *
 * Measured on this store: relevant paraphrases topped out at 0.4595–0.5390, and the best
 * IRRELEVANT query reached 0.4850 ("我希望你怎么写代码注释"). The ranges overlap, so the floor
 * alone cannot be the gate — it is set at the middle to drop the weakest noise while keeping
 * every genuinely relevant hit, and a synonym bridge below does the rest.
 */
export const EMBEDDING_MIN_SCORE = 0.45;

/**
 * The relaxed floor for a semantic hit that HAS lexical evidence (a strong shared token or a
 * synonym bridge). Measured: the correct synonym hit ("语言"→"中文") scored 0.4259, below the
 * no-evidence floor but clearly above the noise band. Evidence substitutes for score.
 */
export const EMBEDDING_FLOOR_EVIDENCED = 0.35;

/**
 * Synonym bridges: pairs where the user's word and the stored word mean the same thing but
 * share no characters. This is the ONE thing the lexical anchor cannot do and the semantic
 * channel must be trusted for.
 *
 * Kept as an explicit table rather than an open-ended "trust the vectors" rule, because the
 * measurements above show the vectors alone are not separable on this store.
 */
const SYNONYM_GROUPS = [
  ['语言', '中文', '英文', '简体', '繁体'],
  ['叫什么', '名字', '称呼', '自称'],
  ['配置', '硬件', '显卡', '内存', '显存', 'cpu', 'gpu', 'rtx'],
  ['目录', '路径', '源码', '安装在', '位置'],
  ['画图', '文生图', '生图', '绘图', '图片'],
  ['启动', '跑起来', '运行', '拉起'],
  ['报错', '错误', '失败', '异常'],
  ['依赖', '包管理', '安装', 'install'],
];

/** Do query and fact belong to the same synonym group? Returns the matched pair, or null. */
export function synonymBridge(query, factText) {
  const q = String(query ?? '').toLowerCase();
  const f = String(factText ?? '').toLowerCase();
  for (const group of SYNONYM_GROUPS) {
    const qHit = group.find((w) => q.includes(w));
    const fHit = group.find((w) => f.includes(w));
    if (qHit && fHit) return [qHit, fHit];
  }
  return null;
}

/**
 * Classify what the caller actually got.
 *
 * `direct` requires at least one exact hit that is still in force. Anything else that was
 * returned is `related` — useful context, not an answer.
 */
export function classifyStatus(facts) {
  if (!Array.isArray(facts) || facts.length === 0) return 'none';
  const hasDirect = facts.some((f) => f?.match === 'keyword' || f?.match === 'trigger');
  return hasDirect ? 'direct' : 'related';
}

/**
 * One receipt line per fact: what matched it, how strongly, how old, and whether a later
 * statement retired it. This is what lets the model say "根据 3 天前记的那条" instead of
 * claiming omniscience, and lets a user audit a wrong answer.
 */
export function buildReceipt(facts, now = Date.now()) {
  return (Array.isArray(facts) ? facts : []).map((f) => ({
    id: String(f?.id ?? ''),
    match: String(f?.match ?? 'unknown'),
    score: Number(f?.score ?? 0),
    trust: Number(f?.trust ?? 0),
    dynTrust: Number(f?.dynTrust ?? 0),
    ageDays: Number((f?.ageDays ?? 0).toFixed?.(2) ?? f?.ageDays ?? 0),
    age: f?.age ?? relativeAge(f?.createdAt, now),
    category: String(f?.category ?? 'general'),
    superseded: Boolean(f?.superseded),
  }));
}

/**
 * Order facts so that exact matches are never displaced by associative ones.
 *
 * Within a band the sort is RELEVANCE-FIRST. An earlier version weighted relevance and
 * dynamic trust as `score*w + dynTrust*0.2`, and that let a high-trust but irrelevant old
 * fact outrank the correct answer: measured on this store, "这个插件装在哪个目录" put the
 * right fact (HRR 0.1867, the highest of all candidates) at rank 6 because two unrelated
 * facts carried dynTrust 0.97 and 0.95.
 *
 * Trust still matters, but only as a TIE-BREAKER between comparable scores — it must not
 * override a clearly better match. `score + dynTrust * SMALL` keeps trust as a nudge.
 */
const TRUST_NUDGE = 0.02;

export function orderByPrecedence(facts) {
  const band = (f) => {
    if (f?.superseded) return 3;
    const m = String(f?.match ?? '');
    if (m === 'keyword' || m === 'trigger') return 0;
    if (m === 'embedding') return 1;
    return 2;
  };
  return [...(Array.isArray(facts) ? facts : [])].sort((a, b) => {
    const ba = band(a);
    const bb = band(b);
    if (ba !== bb) return ba - bb;
    const wa = MATCH_WEIGHTS[a?.match] ?? 0.5;
    const wb = MATCH_WEIGHTS[b?.match] ?? 0.5;
    const sa = Number(a?.score ?? 0) * wa + Number(a?.dynTrust ?? 0) * TRUST_NUDGE;
    const sb = Number(b?.score ?? 0) * wb + Number(b?.dynTrust ?? 0) * TRUST_NUDGE;
    return sb - sa;
  });
}

/**
 * Apply the direct/associative quotas and the decay filter.
 *
 * A fact is kept when it is permanent, or when its decayed trust is above the recall floor.
 * Superseded facts bypass the quota bands: they are filler of last resort.
 */
export function selectWithinQuota(facts, { limit = 8, directQuota = DIRECT_QUOTA } = {}) {
  const ordered = orderByPrecedence(facts);
  const maxDirect = Math.max(1, Math.ceil(limit * directQuota));

  const direct = [];
  const associative = [];
  const superseded = [];
  for (const f of ordered) {
    if (f?.superseded) superseded.push(f);
    else if (f?.match === 'keyword' || f?.match === 'trigger') direct.push(f);
    else associative.push(f);
  }

  const kept = [];
  kept.push(...direct.slice(0, maxDirect));
  // Associative fills the remainder; it can never push a direct hit out.
  const room = limit - kept.length;
  if (room > 0) kept.push(...associative.slice(0, room));
  // Superseded only when there is still room and nothing better exists.
  const room2 = limit - kept.length;
  if (room2 > 0) kept.push(...superseded.slice(0, room2));

  return { kept, directCount: Math.min(direct.length, maxDirect), associativeCount: associative.length };
}

/**
 * Run the full retrieval: literal first, then associative, then classify and receipt.
 *
 * @param {object}   deps
 * @param {object}   deps.store
 * @param {string}   deps.query
 * @param {number}   [deps.limit=8]
 * @param {string}   [deps.category='']
 * @param {number}   [deps.minTrust=0]
 * @param {object}   [deps.embedder]
 * @param {object}   [deps.hrrIndex]
 * @param {boolean}  [deps.includeSuperseded=false]
 * @returns {Promise<{facts: Object[], status: 'direct'|'related'|'none', receipt: Object[], directCount: number, relaxed: boolean}>}
 */
export async function recall(deps) {
  const {
    store,
    query,
    limit = 8,
    category = '',
    minTrust = 0,
    embedder = null,
    hrrIndex = null,
    includeSuperseded = false,
  } = deps ?? {};

  const q = String(query ?? '').trim();
  const empty = { facts: [], status: 'none', receipt: [], directCount: 0, relaxed: false };
  if (!store || !q) return empty;
  if (typeof store.queryFacts !== 'function') return empty;

  let facts = [];
  let relaxed = false;

  // ---- channel 1: literal (never displaced) -------------------------------------
  try {
    const kw = await store.queryFacts({ q, category, limit, minTrust, sort: 'trust' });
    for (const f of (kw?.facts ?? [])) {
      facts.push({ ...f, match: 'keyword', score: 0.8 });
    }
  } catch { /* literal channel optional on a broken store */ }

  // Category is a hint, not a cage: widen only when the narrow query under-delivered.
  if (facts.length < limit && category) {
    try {
      const wide = await store.queryFacts({ q, category: '', limit, minTrust, sort: 'trust' });
      const seen = new Set(facts.map((f) => String(f.id)));
      let widened = false;
      for (const f of (wide?.facts ?? [])) {
        if (seen.has(String(f.id))) continue;
        facts.push({ ...f, match: 'keyword', score: 0.75 });
        seen.add(String(f.id));
        widened = true;
      }
      relaxed = widened;
    } catch { /* widening optional */ }
  }

  const seen = new Set(facts.map((f) => String(f.id)));

  // ---- channel 2: semantic (fills only) ----------------------------------------
  //
  // The anchor is NOT required here, and the reason is measured: for the question
  //   "我应该用什么语言跟你说话"
  // the embedding channel put 「回复用简体中文」 at rank 2 (0.4259) — exactly right — while
  // sharing no token with the query (语言 vs 中文). Requiring an anchor would throw away the
  // one channel that understands synonyms, which is the whole point of having it.
  //
  // But the score alone is not enough either: measured, an IRRELEVANT query reached 0.4850
  // while that correct synonym hit scored only 0.4259. So a semantic hit is trusted when it
  // has independent lexical evidence (a strong shared token, or the single best synonym
  // bridge), and needs a clearly higher score when it has none.
  if (embedder && !embedder.isFailed?.()) {
    try {
      const results = await embedder.search(q, Math.min(limit * 2, 20));
      const ids = results.filter((r) => r.score >= EMBEDDING_FLOOR_EVIDENCED).map((r) => String(r.id));
      const rows = typeof store.getFactsByIds === 'function' ? await store.getFactsByIds(ids) : [];
      const byId = new Map(rows.map((f) => [String(f.id), f]));

      // A synonym bridge is trusted only for the SINGLE best-scoring bridged candidate.
      // 「语言」 bridges to any fact mentioning 中文/英文/语言; letting all of them through let
      // an irrelevant query slip in. The vector already ranks the bridged candidates; the
      // bridge only decides whether to believe the best one.
      let bestBridged = null;
      for (const r of results) {
        if (r.score < EMBEDDING_FLOOR_EVIDENCED) continue;
        const fact = byId.get(String(r.id));
        if (!fact || fact.muted) continue;
        if (lexicalAnchor(q, fact.content).length > 0) continue;
        if (!synonymBridge(q, fact.content)) continue;
        if (!bestBridged || r.score > bestBridged.score) {
          bestBridged = { id: String(r.id), score: r.score };
        }
      }

      for (const r of results) {
        const fact = byId.get(String(r.id));
        if (!fact || fact.muted) continue;
        if (seen.has(String(r.id))) continue;

        const anchored = lexicalAnchor(q, fact.content).length > 0;
        const isBestBridged = Boolean(bestBridged && bestBridged.id === String(r.id));

        // Evidence is REQUIRED for the semantic channel, exactly as it is for HRR.
        // Measured: the irrelevant query "我希望你怎么写代码注释" scored 0.457–0.485 on five
        // unrelated facts — ABOVE every genuine synonym hit (0.4259–0.5390). A score floor
        // therefore cannot separate them, and accepting "no evidence but high score" put us
        // back to answering anything. The vector decides WHICH evidenced candidate is best;
        // the evidence decides whether to speak at all.
        if (!anchored && !isBestBridged) continue;
        if (r.score < EMBEDDING_FLOOR_EVIDENCED) continue;

        if (minTrust && fact.trust < minTrust) continue;

        const bridged = isBestBridged ? synonymBridge(q, fact.content) : null;
        facts.push({
          ...fact,
          match: 'embedding',
          score: Number(Number(r.score).toFixed(4)),
          ...(anchored ? { anchored: true } : {}),
          ...(bridged ? { bridged: bridged.join('->') } : {}),
        });
        seen.add(String(r.id));
      }
    } catch { /* associative channel optional */ }
  }

  // ---- channel 3: holographic (fills only) -------------------------------------
  if (hrrIndex && facts.length < limit) {
    try {
      const scored = new Map(
        hrrIndex.search(q, Math.min(hrrIndex.size, 20)).map((h) => [String(h.id), h.score]),
      );
      const pool = await store.queryFacts({ q: '', category, offset: 0, limit: 2000, minTrust });
      for (const f of (pool?.facts ?? [])) {
        const id = String(f.id);
        if (seen.has(id) || f.muted) continue;
        const score = scored.get(id) ?? -1;

        // The anchor is REQUIRED, not optional. An earlier revision let an un-anchored hit
        // through whenever its HRR score cleared the 0.05 floor — which is every irrelevant
        // query, because the scores overlap completely (see the note above). Requiring the
        // anchor is the whole fix; the score is only used to ORDER the anchored hits.
        const anchor = lexicalAnchor(q, f.content);
        if (anchor.length === 0) continue;

        // A shared strong token is direct evidence, so lift the effective score: HRR can
        // score a self-cancelling fact NEGATIVE (measured: −0.008 for the OCR fact whose
        // text repeats ocr/dsh-ocr/RapidOCR), and such a fact must not rank last.
        const effective = Math.max(score, 0.3 + Math.min(anchor.length, 3) * 0.05);
        facts.push({ ...f, match: 'holographic', score: Number(Number(effective).toFixed(4)) });
        seen.add(id);
      }
    } catch { /* HRR optional */ }
  }

  // ---- decay + supersede handling ---------------------------------------------
  const now = Date.now();
  const scored = facts
    .filter((f) => !f.muted)
    .map((f) => {
      const dyn = dynamicTrust(f, now);
      const isSuperseded = Boolean(f.superseded);
      return {
        ...f,
        dynTrust: Number(dyn.toFixed(3)),
        age: relativeAge(f.createdAt, now),
        ageDays: Math.max(0, (now - Number(f.createdAt ?? now)) / 86400000),
        superseded: isSuperseded,
      };
    })
    .filter((f) => f.superseded || f.permanent || f.dynTrust >= RECALL_MIN_DYN_TRUST)
    // Superseded facts are reached only on explicit request.
    .filter((f) => includeSuperseded || !f.superseded);

  const { kept, directCount } = selectWithinQuota(scored, { limit });

  return {
    facts: kept,
    status: classifyStatus(kept),
    receipt: buildReceipt(kept, now),
    directCount,
    relaxed,
  };
}

/**
 * Human-readable status line for the injected block.
 *
 * The point is that the model is TOLD when it only has related material, so it can hedge
 * ("我只记得相关的一点…") instead of asserting. KRouter calls these three states
 * `memory: direct / related / none`; the wording here is Chinese because that is the
 * language the memory block is written in.
 */
export function statusLine(status, count = 0) {
  switch (status) {
    case 'direct':
      return '';
    case 'related':
      return '（以下只有沾边的记忆，没有直接答案；不确定的部分要说明，别当成事实。）';
    case 'none':
      return '（记忆里没有与这个问题直接相关的内容。不要编造，如实说不知道即可。）';
    default:
      return '';
  }
}

export const RECALL_INFO = Object.freeze({
  directQuota: DIRECT_QUOTA,
  matchWeights: MATCH_WEIGHTS,
  statuses: ['direct', 'related', 'none'],
});
