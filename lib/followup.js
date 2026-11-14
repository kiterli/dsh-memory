/**
 * lib/followup.js — remember what is still UNFINISHED, and mention it once.
 *
 * WHY
 *
 * Every other capture path stores facts. None of them store an OBLIGATION. When a session
 * ends mid-task ("先做到这里，明天继续" / a turn that opened with 待办 and never closed), that
 * intent disappears: the next session starts blank, and the user has to re-explain.
 *
 * Remembering that something is unfinished is the difference between "an assistant with good
 * recall" and "someone who was actually paying attention". It is also the one behaviour in
 * this plugin that is unmistakably human, because it is about the FUTURE rather than the past.
 *
 * DESIGN
 *
 *  1. NO MODEL. Rules over the user's own words, same discipline as lib/mood.js.
 *  2. EXPLICIT SIGNALS ONLY. "继续" / "接着做" / "明天再弄" / "先到这" / "待办" / "还没做完".
 *     A vague topic mention is not an obligation; inventing one would be worse than silence
 *     ("上次那个…" said about something the user never asked for is actively annoying).
 *  3. ONE PER SESSION, AND IT EXPIRES. A follow-up is raised once, then marked raised. After
 *     `MAX_AGE_DAYS` it is dropped: an eight-month-old "remember to finish X" is noise.
 *  4. CLOSABLE. "做完了" / "不用了" / "搞定了" closes it — an assistant that keeps asking
 *     about a finished task is the same failure as one that never asked.
 *
 * Pure detection + a small store-backed queue kept in the memory file's sidecar meta, so the
 * whole thing survives a restart without a schema change.
 */

/** How long an open follow-up stays worth mentioning. */
export const MAX_AGE_DAYS = 14;

/** Below this length a "continue" is too vague to record. */
const MIN_TOPIC_LENGTH = 4;

/** Opening a follow-up: the user signalled unfinished work. */
const OPEN_PATTERNS = [
  /(?:先做到|先到这|今天先|暂时先|先停|先缓)(?:里|儿)?/,
  /(?:明天|下次|回头|待会|稍后|晚点)(?:再|继续|接着)/,
  /(?:继续|接着)(?:做|弄|搞|推进|处理|刚才|上次|那个)/,
  /(?:还没|没)(?:做完|弄完|搞完|完成|处理完)/,
  /待办|TODO|todo/,
  /(?:留到|放到)下次/,
];

/** Closing a follow-up: the user said it is done (or not needed). */
const CLOSE_PATTERNS = [
  /(?:做完了|弄完了|搞完了|完成了|搞定了|已经好了|行了|结束吧)/,
  /(?:不用了|不用做|取消|算了|先不弄了|放弃)/,
];

/**
 * The obligation itself is described by what remains after the signal phrasing is removed.
 *
 * ORDER MATTERS and the patterns must be anchored: an early version stripped 先做到第一个,
 * leaving "做到这里" as the topic — the signal word itself became the subject. Each pattern
 * below eats the WHOLE signal clause (including the demonstrative that follows it).
 */
const TOPIC_CLEANUP = [
  /^(?:好|嗯|那|行|ok|OK)[，,。.\s]*/i,
  // "今天先做到这里" / "先到这" / "暂时先这样" — eat only the signal clause up to punctuation.
  // The class must exclude the clause content, not "everything except punctuation": an early
  // version used [^，。;]* and swallowed the real subject that followed the comma.
  /(?:今天|今晚|现在)?(?:先|暂时)(?:做到|弄到|搞到|干到|到这|这样|停下|缓一缓)[^，,。；;]*[，,。；;\s]*/g,
  /(?:今天|今晚|现在)?(?:先|暂时)?(?:停|歇)(?:一下|一会|会儿|吧)?[，,。；;\s]*/g,
  // A bare time word, nothing after it: "明天再继续" -> the 明天 part goes, 继续 is caught below.
  /(?:明天|下次|回头|待会|稍后|晚点)(?:再|继续|接着)?[，,。；;\s]*(?=$|继续|接着|做|弄|搞)/g,
  // "继续做/接着弄" at the start of what remains.
  /^(?:继续|接着)(?:做|弄|搞|推进|处理)?[，,。.\s]*/g,
  // "还没做完" — the incompleteness marker itself, not what follows it.
  /(?:还)?没(?:做完|弄完|搞完|完成|处理完|结束)[，,。；;\s]*/g,
  /^待办[:：]?\s*/,
  /^TODO[:：]?\s*/i,
];

/** Detect whether one message opens or closes a follow-up. */
export function detectFollowup(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length === 0) return null;
  // Never learn an obligation from our own injected block.
  if (/^\[以下是我记得的事情|^\[dsh-memory context/.test(s)) return null;

  const closes = CLOSE_PATTERNS.some((re) => re.test(s));
  const opens = OPEN_PATTERNS.some((re) => re.test(s));

  // A close is checked BEFORE the length gate: "搞定了" is three characters and still the
  // clearest thing a user can say to end an obligation.
  if (closes && !opens) return { action: 'close', text: s };

  if (s.length < MIN_TOPIC_LENGTH) return null;
  if (!opens) return null;

  // A last pass over the derived topic: leading time words and bare action verbs that ended
  // up at the front ("明天把…收尾" -> "把…收尾", "弄召回评测" -> "召回评测").
  const TOPIC_LEAD = /^(?:明天|下次|回头|待会|稍后|晚点|再|继续|接着|把|弄|做|搞|推进|处理)+/;

  const cleanTopic = (value) => {
    let out = String(value ?? '').trim();
    for (const re of TOPIC_CLEANUP) out = out.replace(re, '');
    out = out.replace(/^[，,。.；;\s]+/, '').replace(/[，,。.；;\s]+$/, '');
    out = out.replace(TOPIC_LEAD, '').trim();
    return out;
  };

  let topic = cleanTopic(s);

  if (topic.length < MIN_TOPIC_LENGTH) {
    // Try clause by clause, last first: people put the subject at the end.
    const clauses = s.split(/[，,。；;]/).map((c) => c.trim()).filter((c) => c.length >= MIN_TOPIC_LENGTH);
    for (let i = clauses.length - 1; i >= 0; i -= 1) {
      const candidate = cleanTopic(clauses[i]);
      if (candidate.length >= MIN_TOPIC_LENGTH) { topic = candidate; break; }
    }
  }

  if (topic.length < MIN_TOPIC_LENGTH) {
    // Nothing concrete left ("先到这里吧") — record the intent, not an empty subject.
    return { action: 'open', text: s, topic: null, vague: true };
  }
  return { action: 'open', text: s, topic: topic.slice(0, 160), vague: false };
}

/**
 * Should this open follow-up be raised now?
 *
 * `state` is the persisted record: `{ topic, text, createdAt, raised, closed }`.
 */
export function shouldRaise(state, now = Date.now()) {
  if (!state || state.closed) return false;
  if (state.raised) return false;
  const ageDays = (now - Number(state.createdAt ?? 0)) / 86400000;
  if (!Number.isFinite(ageDays) || ageDays < 0) return false;
  if (ageDays > MAX_AGE_DAYS) return false;
  return true;
}

/**
 * The opening line for the injected block. Deliberately a question, not a statement: it
 * invites the user to redirect, the way a colleague would.
 */
export function followupLine(state) {
  if (!state) return '';
  const topic = state.topic ? `「${state.topic}」` : '那件事';
  return `上次${topic}还没收尾，要不要接着弄？`;
}

/**
 * In-memory queue with explicit persistence hooks, so the caller decides where it lives.
 *
 * Kept tiny and dependency-free: this is a list of at most a few obligations, not a database.
 */
export function createFollowupQueue(initial = []) {
  let items = Array.isArray(initial) ? initial.filter(Boolean).map((x) => ({ ...x })) : [];

  return {
    all() { return items.map((x) => ({ ...x })); },

    /** Apply one detected message. Returns the resulting state or null. */
    apply(detected, { now = Date.now(), sessionId = null } = {}) {
      if (!detected) return null;

      if (detected.action === 'close') {
        // Close the most recent open item: "做完了" refers to whatever was pending.
        const idx = [...items].reverse().findIndex((x) => !x.closed);
        if (idx < 0) return null;
        const real = items.length - 1 - idx;
        items[real] = { ...items[real], closed: true, closedAt: now };
        return items[real];
      }

      // De-duplicate: the same topic open twice is one obligation.
      const key = String(detected.topic ?? detected.text).toLowerCase();
      const existing = items.find((x) => !x.closed && String(x.topic ?? x.text).toLowerCase() === key);
      if (existing) return existing;

      const state = {
        topic: detected.topic ?? null,
        text: detected.text,
        sessionId,
        createdAt: now,
        raised: false,
        closed: false,
      };
      items.push(state);
      // Keep the list bounded; oldest closed items go first, then oldest overall.
      if (items.length > 20) {
        items = items.filter((x) => !x.closed).slice(-10).concat(items.filter((x) => !x.closed).slice(0, 0));
        items = items.slice(-20);
      }
      return state;
    },

    /** The next obligation worth mentioning, marking it raised. */
    take(now = Date.now()) {
      const idx = items.findIndex((x) => shouldRaise(x, now));
      if (idx < 0) return null;
      items[idx] = { ...items[idx], raised: true, raisedAt: now };
      return { ...items[idx] };
    },

    /** Drop expired obligations. */
    prune(now = Date.now()) {
      const before = items.length;
      items = items.filter((x) => {
        if (x.closed) return false;
        const ageDays = (now - Number(x.createdAt ?? 0)) / 86400000;
        return Number.isFinite(ageDays) && ageDays <= MAX_AGE_DAYS;
      });
      return before - items.length;
    },
  };
}

export const FOLLOWUP_INFO = Object.freeze({
  maxAgeDays: MAX_AGE_DAYS,
  openPatterns: OPEN_PATTERNS.length,
  closePatterns: CLOSE_PATTERNS.length,
});
