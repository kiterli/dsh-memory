/**
 * lib/recall.js contract tests — "can this answer be trusted, and does the caller know how much?"
 *
 * The failure mode these lock down is the expensive one: a fuzzy vector hit, or a fact the
 * user already corrected, being recited as established truth. Four things must hold:
 *   1. exact hits are never displaced by associative ones (hard precedence, not weights);
 *   2. the caller is told which of direct / related / none it got;
 *   3. superseded facts are out of force by default;
 *   4. every fact carries a receipt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyStatus,
  orderByPrecedence,
  selectWithinQuota,
  buildReceipt,
  statusLine,
  recall,
  contentTokens,
  lexicalAnchor,
  isStrongToken,
  synonymBridge,
  EMBEDDING_MIN_SCORE,
  EMBEDDING_FLOOR_EVIDENCED,
  DIRECT_QUOTA,
  RECALL_INFO,
} from '../lib/recall.js';

const NOW = Date.now();
const fresh = (over = {}) => ({
  id: 'f1',
  content: 'x',
  category: 'general',
  trust: 0.8,
  createdAt: NOW - 1000,
  ...over,
});

/* ------------------------------------------------------------------- status */

test('recall: no facts means none', () => {
  assert.equal(classifyStatus([]), 'none');
  assert.equal(classifyStatus(null), 'none');
});

test('recall: a literal hit makes the answer direct', () => {
  assert.equal(classifyStatus([fresh({ match: 'keyword' })]), 'direct');
});

test('recall: only associative hits means related, not direct', () => {
  assert.equal(classifyStatus([fresh({ match: 'embedding' })]), 'related');
  assert.equal(classifyStatus([fresh({ match: 'holographic' })]), 'related');
  assert.equal(
    classifyStatus([fresh({ match: 'embedding' }), fresh({ id: 'f2', match: 'holographic' })]),
    'related',
  );
});

test('recall: a status line exists for related and none, and is silent for direct', () => {
  assert.equal(statusLine('direct', 3), '');
  assert.match(statusLine('related', 2), /沾边/);
  assert.match(statusLine('related', 2), /别当成事实/);
  assert.match(statusLine('none', 0), /没有.*直接相关/);
  assert.match(statusLine('none', 0), /不要编造/);
});

/* -------------------------------------------------------------- precedence */

test('recall: an exact hit outranks a higher-scoring fuzzy hit', () => {
  const exact = fresh({ id: 'exact', match: 'keyword', score: 0.1 });
  const fuzzy = fresh({ id: 'fuzzy', match: 'embedding', score: 0.99 });
  const ordered = orderByPrecedence([fuzzy, exact]);
  assert.equal(ordered[0].id, 'exact', 'precedence is a band, not a weighted score');
});

test('recall: superseded facts sink to the bottom', () => {
  const live = fresh({ id: 'live', match: 'embedding', score: 0.1 });
  const dead = fresh({ id: 'dead', match: 'keyword', score: 0.99, superseded: true });
  const ordered = orderByPrecedence([dead, live]);
  assert.equal(ordered[ordered.length - 1].id, 'dead');
});

/* ------------------------------------------------------------------ quotas */

test('recall: the direct channel may not be pushed out by associative hits', () => {
  const facts = [
    ...Array.from({ length: 3 }, (_, i) => fresh({ id: 'k' + i, match: 'keyword', score: 0.5 })),
    ...Array.from({ length: 20 }, (_, i) => fresh({ id: 'e' + i, match: 'embedding', score: 0.99 })),
  ];
  const { kept, directCount } = selectWithinQuota(facts, { limit: 5 });
  assert.equal(kept.length, 5);
  const directKept = kept.filter((f) => f.match === 'keyword').length;
  assert.equal(directKept, 3, 'every direct hit survives the quota');
  assert.equal(directCount, 3);
  assert.equal(kept.filter((f) => f.match === 'embedding').length, 2, 'associative fills the rest');
});

test('recall: the direct quota caps how much one channel can take', () => {
  const facts = Array.from({ length: 20 }, (_, i) => fresh({ id: 'k' + i, match: 'keyword', score: 0.9 }));
  const { kept, directCount } = selectWithinQuota(facts, { limit: 10, directQuota: DIRECT_QUOTA });
  // ceil(10 * 0.6) = 6. The remaining 4 slots stay EMPTY rather than being filled with
  // more of the same channel: the point of the quota is that one channel cannot dominate.
  assert.equal(kept.length, 6, 'direct is capped, leftover slots are not backfilled from it');
  assert.equal(directCount, 6);
});

test('recall: associative hits are used when there are no direct ones', () => {
  const facts = Array.from({ length: 8 }, (_, i) => fresh({ id: 'e' + i, match: 'embedding', score: 0.5 }));
  const { kept } = selectWithinQuota(facts, { limit: 3 });
  assert.equal(kept.length, 3);
});

/* ----------------------------------------------------------------- receipt */

test('recall: every fact carries a receipt naming how it was found', () => {
  const receipt = buildReceipt([
    fresh({ id: 'a', match: 'keyword', score: 0.8, dynTrust: 0.5, category: '偏好' }),
    fresh({ id: 'b', match: 'embedding', score: 0.42, dynTrust: 0.3 }),
  ], NOW);
  assert.equal(receipt.length, 2);
  assert.equal(receipt[0].id, 'a');
  assert.equal(receipt[0].match, 'keyword');
  assert.equal(receipt[0].category, '偏好');
  assert.equal(receipt[1].match, 'embedding');
  for (const r of receipt) {
    assert.ok('score' in r && 'trust' in r && 'dynTrust' in r && 'ageDays' in r && 'age' in r);
  }
});

/* --------------------------------------------------------- semantic channel */

function embedderStub(results) {
  return {
    isFailed: () => false,
    async search() { return results; },
  };
}

test('recall: a synonym bridge is the semantic channel doing its job', () => {
  // 「语言」 asked, 「中文」 stored — zero shared characters, one shared meaning.
  const bridge = synonymBridge('我应该用什么语言跟你说话', '用户偏好：回复用简体中文');
  assert.deepEqual(bridge, ['语言', '中文']);
});

test('recall: the semantic channel reaches a fact that shares no literal token', async () => {
  const store = {
    async queryFacts({ q }) {
      if (q === '') return { facts: [{ id: 'f1', content: '用户偏好：回复用简体中文', trust: 0.9, createdAt: Date.now() }] };
      return { facts: [] };
    },
    async getFactsByIds() { return [{ id: 'f1', content: '用户偏好：回复用简体中文', trust: 0.9, createdAt: Date.now() }]; },
  };
  const embedder = embedderStub([{ id: 'f1', score: 0.4259 }]); // below the no-evidence floor
  const r = await recall({ store, query: '我应该用什么语言跟你说话', embedder });
  assert.equal(r.facts.length, 1, 'the synonym bridge admits a hit an anchor never could');
  assert.equal(r.facts[0].match, 'embedding');
  assert.ok(r.facts[0].bridged, 'the receipt shows the bridge that justified it');
});

test('recall: a high semantic score WITHOUT evidence is not trusted', async () => {
  // Measured: the irrelevant query "我希望你怎么写代码注释" scored 0.457–0.485 on five
  // unrelated facts — above every genuine synonym hit. A score floor cannot separate them,
  // so evidence is required exactly as it is for HRR.
  const store = {
    async queryFacts({ q }) {
      if (q === '') return { facts: [{ id: 'f1', content: '启动本机 ComfyUI 必须跑 .bat', trust: 0.9, createdAt: Date.now() }] };
      return { facts: [] };
    },
    async getFactsByIds() { return [{ id: 'f1', content: '启动本机 ComfyUI 必须跑 .bat', trust: 0.9, createdAt: Date.now() }]; },
  };
  const embedder = embedderStub([{ id: 'f1', score: 0.485 }]);
  const r = await recall({ store, query: '我希望你怎么写代码注释', embedder });
  assert.equal(r.facts.length, 0, 'no anchor, no bridge, no answer — even at 0.485');
  assert.equal(r.status, 'none');
});

test('recall: only the single best bridged candidate is admitted', async () => {
  // 「语言」bridges to every fact mentioning 中文/英文; only the closest may speak.
  const rows = [
    { id: 'a', content: '用户偏好：回复用简体中文', trust: 0.9, createdAt: Date.now() },
    { id: 'b', content: '界面文案与文档一律中文优先', trust: 0.9, createdAt: Date.now() },
  ];
  const store = {
    async queryFacts({ q }) { return q === '' ? { facts: rows } : { facts: [] }; },
    async getFactsByIds() { return rows; },
  };
  const embedder = embedderStub([{ id: 'a', score: 0.4259 }, { id: 'b', score: 0.4 }]);
  const r = await recall({ store, query: '我应该用什么语言跟你说话', embedder });
  assert.equal(r.facts.length, 1, 'the bridge admits one candidate, not all of them');
  assert.equal(String(r.facts[0].id), 'a', 'and it is the best-scoring one');
});

test('recall: the semantic floors are ordered the way the design intends', () => {
  assert.ok(EMBEDDING_FLOOR_EVIDENCED < EMBEDDING_MIN_SCORE,
    'evidence relaxes the floor, it does not replace it');
});

test('recall: contentTokens produces CJK bigrams and latin words, minus stop words', () => {
  const t = contentTokens('OCR 是怎么跑的 ComfyUI 启动');
  assert.ok(t.has('ocr'), 'latin word kept');
  assert.ok(!t.has('怎么'), 'stop bigram dropped');
});

test('recall: a relevant paraphrase shares at least one content token', () => {
  assert.ok(lexicalAnchor('OCR 是怎么跑的', 'DSH 的本地 OCR 能力用 @local/dsh-ocr 插件实现').length > 0);
  assert.ok(lexicalAnchor('画图那个工作流怎么绕开提取', 'ComfyUI 模板库是未提取的 UI 图工作流').length > 0);
});

test('recall: an irrelevant query shares no token — this is what refuses it', () => {
  // Measured on this machine's store: these pairs scored 0.12+ in HRR, indistinguishable
  // from relevant pairs. Only the anchor separates them.
  assert.deepEqual(lexicalAnchor('我平时几点上班', '千问 Qwen-Image 2.1 文生图流程'), []);
  assert.deepEqual(lexicalAnchor('量子纠缠退相干时间的实验测量', '用户偏好：回复用简体中文'), []);
  assert.deepEqual(lexicalAnchor('巴洛克时期管风琴的音栓配比', '用户的助手名字叫「小智」'), []);
});

test('recall: an irrelevant question gets NOTHING even when HRR would have scored it', async () => {
  // The exact bug that shipped once: the anchor was treated as OPTIONAL, so any hit whose
  // HRR score cleared 0.05 came through — and since relevant/irrelevant scores overlap
  // completely, that meant every irrelevant query got an answer.
  const store = {
    async queryFacts({ q }) {
      if (q === '') return { facts: [{ id: 'f1', content: '千问 Qwen-Image 2.1 文生图流程', trust: 0.9, createdAt: Date.now() }] };
      return { facts: [] };
    },
    async getFactsByIds() { return []; },
  };
  const hrrIndex = {
    size: 1,
    // A score well ABOVE the 0.05 floor — the old code let this through.
    search() { return [{ id: 'f1', score: 0.1353 }]; },
  };
  const r = await recall({ store, query: '我平时几点上班', hrrIndex });
  assert.equal(r.facts.length, 0, 'no strong shared token means no associative hit, score notwithstanding');
  assert.equal(r.status, 'none');
});

test('recall: a weak function-word bigram is not an anchor', () => {
  // "我希望你怎么写代码注释" shares 希望 with an unrelated fact about naming — a coincidence of
  // phrasing, not a shared subject.
  assert.deepEqual(lexicalAnchor('我希望你怎么写代码注释', '用户的助手名字叫「小智」，用户希望它以这个名字自称'), []);
});

test('recall: high-frequency carrier verbs are not anchors', () => {
  // Measured leak: the unanswerable probe "中世纪手抄本使用的铁胆墨水配方" came through because
  // it shared 使用 with "深度使用 DSH 插件开发". 使用 rides along with any topic.
  assert.deepEqual(
    lexicalAnchor('中世纪手抄本使用的铁胆墨水配方', '用户技术栈：Go/Java/Node.js 全栈，深度使用 DSH 插件开发'),
    [],
  );
  for (const verb of ['使用', '需要', '可以', '通过', '包括', '问题']) {
    assert.equal(isStrongToken(verb), false, `${verb} must not justify a hit`);
  }
});

test('recall: genuine subject tokens still count', () => {
  for (const token of ['ocr', '插件', '端口', '显存', 'rtx', '3060', 'comfyui']) {
    assert.equal(isStrongToken(token), true, `${token} names a subject and must count`);
  }
});

test('recall: a self-cancelling HRR score still returns when the anchor is strong', async () => {
  // Measured on this store: the OCR fact scored −0.008 for "OCR 是怎么跑的" because its text
  // repeats ocr / dsh-ocr / RapidOCR and the vectors cancel. The anchor is direct evidence.
  const store = {
    async queryFacts({ q }) {
      if (q === '') return { facts: [{ id: 'f1', content: 'DSH 的本地 OCR 用 RapidOCR 实现', trust: 0.9, createdAt: Date.now() }] };
      return { facts: [] };
    },
    async getFactsByIds() { return []; },
  };
  const hrrIndex = { size: 1, search() { return [{ id: 'f1', score: -0.008 }]; } };
  const r = await recall({ store, query: 'OCR 是怎么跑的', hrrIndex });
  assert.equal(r.facts.length, 1, 'a strong anchor must survive a negative vector score');
  assert.ok(r.facts[0].score >= 0.3, 'the effective score is lifted so it does not rank last');
});

test('recall: a relevant question DOES get the fact through the same HRR path', async () => {
  const store = {
    async queryFacts({ q }) {
      if (q === '') return { facts: [{ id: 'f1', content: 'DSH 的本地 OCR 用 RapidOCR 实现', trust: 0.9, createdAt: Date.now() }] };
      return { facts: [] };
    },
    async getFactsByIds() { return []; },
  };
  const hrrIndex = { size: 1, search() { return [{ id: 'f1', score: 0.12 }]; } };
  const r = await recall({ store, query: 'OCR 是怎么跑的', hrrIndex });
  assert.equal(r.facts.length, 1);
  assert.equal(r.facts[0].match, 'holographic');
  assert.equal(r.status, 'related', 'an associative-only hit is related, never direct');
});

function makeStore({ keyword = [], all = [] } = {}) {
  return {
    async queryFacts({ q, limit }) {
      if (q === '' || q == null) return { facts: all, total: all.length, filtered: all.length };
      return { facts: keyword, total: keyword.length, filtered: keyword.length };
    },
    async getFactsByIds() { return []; },
  };
}

test('recall: nothing matching reports none, not an empty success', async () => {
  const store = makeStore();
  const r = await recall({ store, query: '一个完全不存在的话题' });
  assert.equal(r.status, 'none');
  assert.deepEqual(r.facts, []);
  assert.deepEqual(r.receipt, []);
});

test('recall: an exact hit reports direct with a receipt', async () => {
  const store = makeStore({ keyword: [fresh({ id: 'k1', content: '端口固定在 44565' })] });
  const r = await recall({ store, query: '端口 44565' });
  assert.equal(r.status, 'direct');
  assert.equal(r.facts.length, 1);
  assert.equal(r.receipt[0].match, 'keyword');
});

test('recall: superseded facts are excluded by default, reachable on request', async () => {
  const store = makeStore({
    keyword: [fresh({ id: 'old', content: '端口是 44560', superseded: true })],
  });

  const normal = await recall({ store, query: '端口' });
  assert.equal(normal.facts.length, 0, 'a corrected fact must not come back');
  assert.equal(normal.status, 'none');

  const history = await recall({ store, query: '端口', includeSuperseded: true });
  assert.equal(history.facts.length, 1, 'the history is still answerable on request');
  assert.equal(history.receipt[0].superseded, true);
});

test('recall: a missing store degrades to none', async () => {
  const r = await recall({ store: null, query: 'x' });
  assert.equal(r.status, 'none');
});

test('recall: an empty query never hits the store', async () => {
  let called = false;
  const store = { async queryFacts() { called = true; return { facts: [] }; } };
  const r = await recall({ store, query: '   ' });
  assert.equal(r.status, 'none');
  assert.equal(called, false);
});

test('recall: RECALL_INFO exposes the contract constants', () => {
  assert.equal(RECALL_INFO.directQuota, DIRECT_QUOTA);
  assert.deepEqual(RECALL_INFO.statuses, ['direct', 'related', 'none']);
  assert.ok(RECALL_INFO.matchWeights.keyword > RECALL_INFO.matchWeights.embedding);
});
