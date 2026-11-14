/**
 * lib/autocapture.js — proactive capture of durable facts the model did not record.
 *
 * WHY THIS EXISTS
 *
 * `memory_record` only fires when the model decides to call it. In practice most
 * durable facts arrive inside ordinary sentences ("我一般用 pwsh 不是 cmd", "这个项目
 * 端口固定 44565", "以后别给我分步问") and are never recorded, because the model is busy
 * answering. A memory that only grows when explicitly asked to remember never grows.
 *
 * DESIGN CONSTRAINTS (deliberate)
 *
 *  1. RULE-BASED, NO MODEL CALL. Extraction runs on every turn boundary, so it must
 *     cost microseconds and must never add latency or depend on a worker being warm.
 *  2. CONSERVATIVE. A wrong memory is far worse than a missing one: it gets injected
 *     into every future prompt as if it were established fact. Every pattern here
 *     requires an explicit durability marker (以后/一律/固定/不要…), and the sentence
 *     must be long enough to stand alone.
 *  3. LOW TRUST, MARKED. Captured facts enter at trust 0.55 with source 'auto' and
 *     category 'auto:…'. They rank below anything the user stated deliberately, and
 *     they are visible as automatic in the panel and in exports.
 *  4. IDEMPOTENT. The same sentence is never captured twice (hash of normalised text,
 *     checked against recently captured content), so replaying a turn is harmless.
 *  5. SELF-CORRECTION FRIENDLY. A later explicit statement outranks an auto capture,
 *     and `memory_forget` removes the auto one like any other.
 *
 * Pure functions + one side-effecting helper, so the matchers are unit-testable.
 */

/** A captured fact must be at least this long to be a standalone statement. */
const MIN_LENGTH = 8;
/** …and no longer than this, or it is a paragraph, not a fact. */
const MAX_LENGTH = 240;

/**
 * Durable-preference / decision / correction signals.
 *
 * Ordered most specific first. `category` is what the captured fact lands in;
 * `trust` distinguishes a stated preference from a passing observation.
 *
 * DESIGN NOTE — why most rules capture the WHOLE sentence and only `explicit` slices
 * a fragment: a pattern like /不能(.{4,120})会/ proves that a sentence is durable, but the
 * text between its two anchors is not a self-contained statement. Slicing it produced
 * half-sentences such as "裸 spawn venv python main.py——缺 activate.bat 设置的环境时进程"
 * which are then injected into every future prompt as if they were facts. So the
 * anchors are used only as a TEST, and the sentence itself (trimmed) is the fact.
 */
export const CAPTURE_RULES = Object.freeze([
  // Explicit memory requests — the user said "remember" in plain words. Here slicing IS
  // correct: everything after the marker is the thing to remember.
  { id: 'explicit', category: 'auto:explicit', trust: 0.8, pattern: /(?:记住|记一下|记住这点|remember that|keep in mind)[:：,，\s]+(.{4,200})/i, slice: true },
  // Standing instruction about future behaviour ("以后都…", "一律…", "不要再…").
  { id: 'standing', category: 'auto:preference', trust: 0.7, pattern: /(?:以后都|今后|从现在起|一律|统一|永远不要|不要再|别再|不要分步问)/ },
  // Preference statement ("我习惯…", "我一般用…", "我偏好…", "我喜欢…").
  { id: 'preference', category: 'auto:preference', trust: 0.6, pattern: /(?:我(?:一般|通常|习惯|偏好|喜欢|倾向)|我(?:不)?(?:用|使用))[^\n。]{2,}/ },
  // Machine / environment fact stated as fixed ("端口固定…", "路径固定…", "版本是…").
  { id: 'environment', category: 'auto:environment', trust: 0.6, pattern: /(?:固定在|固定是|默认是|端口(?:是|为|固定)|路径(?:是|为))/ },
  // Correction of something previously believed ("不是…而是…", "其实是…").
  { id: 'correction', category: 'auto:correction', trust: 0.65, pattern: /(?:不是[^\n。]{1,80}而是|其实是|应该是)/ },
  // Pitfall / hard-won constraint. The anchors only TEST durability; the whole sentence
  // is captured, because the interesting part is the constraint, not the fragment
  // between "不能" and "会".
  { id: 'pitfall', category: 'auto:pitfall', trust: 0.65, pattern: /(?:必须[^\n。]{2,}否则|不能[^\n。]{2,}会|千万(?:不要|别)|否则(?:会)?[^\n。]{2,})/ },
]);

/**
 * Text that must never be captured even if it matches a rule: credentials, and
 * conversational filler that would be noise as a "fact".
 */
const RE_SECRET = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|xoxb-[A-Za-z0-9-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|-----BEGIN[A-Z ]*PRIVATE KEY-----|(?:密码|口令|token|api[_-]?key)\s*[:=]\s*\S{6,})/i;

/** Fillers that make a sentence useless as a standalone memory. */
const RE_FILLER = /^(?:这个|那个|就是|然后|所以|但是|而且|还有|嗯|哦|好的?|行|可以|没问题)[，,。.\s]*/;

/** Split a message into candidate sentences (CJK + Latin punctuation). */
export function splitSentences(text) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n');
  const parts = raw
    .split(/(?<=[。！？!?；;\n])|(?<=\.\s)/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [raw.trim()].filter(Boolean);
}

/** Normalise for hashing/dedup: collapse whitespace, strip trailing punctuation. */
export function normalizeCandidate(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-*•\d.、]+/, '')
    .replace(/[。．.\s]+$/, '')
    .trim();
}

/**
 * Extract capture candidates from one message body.
 *
 * Returns `[{ content, category, trust, rule }]`, already filtered for length,
 * secrets and fillers. Never throws; a malformed pattern just yields nothing.
 */
export function extractCandidates(text, { minLength = MIN_LENGTH, maxLength = MAX_LENGTH } = {}) {
  const out = [];
  const seen = new Set();
  for (const sentence of splitSentences(text)) {
    if (sentence.length < minLength) continue;
    if (RE_SECRET.test(sentence)) continue;

    for (const rule of CAPTURE_RULES) {
      const match = rule.pattern.exec(sentence);
      if (!match) continue;

      // Only `slice` rules take their group; every other rule captures the whole
      // sentence, because its anchors prove durability but do not delimit a statement.
      let content = sentence;
      if (rule.slice) {
        const groups = match.slice(1).filter((g) => typeof g === 'string' && g.trim() !== '');
        if (groups.length > 0) content = groups.join(' ');
      }
      content = normalizeCandidate(content);

      if (content.length < minLength) break;
      if (content.length > maxLength) break;
      if (RE_FILLER.test(content)) break;
      // A fragment that begins or ends mid-clause is worse than no memory at all.
      if (content.endsWith('时进程') || content.endsWith('，') || content.endsWith('的')) break;

      const key = content.toLowerCase();
      if (seen.has(key)) break;
      seen.add(key);
      out.push({ content, category: rule.category, trust: rule.trust, rule: rule.id });
      break; // one rule per sentence is enough
    }
  }
  return out;
}

/**
 * Pick the previous turn's user text out of a message list.
 *
 * At `pre-step` for turn N the transcript already contains turn N's user message, so
 * "the turn that just finished" is the SECOND user message from the end. This is why
 * capture needs no post-step hook: the previous turn is processed when the next one
 * starts, which also means a crashed turn still gets captured.
 */
export function previousUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const userTexts = [];
  for (const m of list) {
    const role = m?.role ?? m?.type;
    if (role !== 'user') continue;
    const content = m?.content;
    if (typeof content === 'string') {
      userTexts.push(content);
    } else if (Array.isArray(content)) {
      const text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join(' ');
      if (text) userTexts.push(text);
    }
  }
  // Skip our own injected memory blocks: they are role user but not user speech.
  const speech = userTexts.filter((t) => !/^\[以下是我记得的事情|^\[dsh-memory context/.test(String(t).trim()));
  if (speech.length < 2) return '';
  return speech[speech.length - 2];
}

/**
 * Capture candidates from the previous turn into the store.
 *
 * Side-effecting helper: cheap, best-effort, and safe to call on every turn. Returns
 * the facts that were newly written (empty when there was nothing durable, which is
 * the common case). The caller must not await latency on the UI path.
 */
export async function captureTurn({ store, messages, logger, sessionId, skip = new Set() } = {}) {
  const log = logger ?? {};
  if (!store || typeof store.upsertFact !== 'function') return [];
  const text = previousUserText(messages);
  if (!text) return [];

  const candidates = extractCandidates(text);
  if (candidates.length === 0) return [];

  const written = [];
  for (const candidate of candidates) {
    if (skip.has(candidate.content.toLowerCase())) continue;
    try {
      // upsertFact dedups by normalised-content hash, so an identical capture is a
      // no-op rather than a duplicate row.
      const fact = await store.upsertFact({
        content: candidate.content,
        category: candidate.category,
        tags: ['auto'],
        trust: candidate.trust,
        source: 'auto',
      });
      if (fact?.id) {
        written.push({ id: String(fact.id), content: candidate.content, rule: candidate.rule });
      }
    } catch {
      /* one bad candidate must not stop the rest */
    }
  }
  if (written.length > 0) {
    try {
      log.info?.(`[dsh-memory] auto-captured ${written.length} fact(s) from the previous turn${sessionId ? ` (session ${sessionId})` : ''}`);
    } catch { /* logging is optional */ }
  }
  return written;
}

export const CAPTURE_INFO = Object.freeze({
  rules: CAPTURE_RULES.map((r) => ({ id: r.id, category: r.category, trust: r.trust })),
  minLength: MIN_LENGTH,
  maxLength: MAX_LENGTH,
});
