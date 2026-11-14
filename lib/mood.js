/**
 * lib/mood.js — notice how the user sounded, so the assistant can remember more than
 * *what* was said.
 *
 * WHY
 *
 * `events` has carried `emotion` and `importance` since the first version, and until now
 * nothing ever wrote a meaningful value into them: the only writer was `memory_record`,
 * which the model calls without any emotional context. So the store could always answer
 * "what did we work on" and never "how were you that day" — and the prompt injection that
 * reads emotion back was dead weight.
 *
 * DESIGN
 *
 *  1. RULE-BASED AND CHEAP. This runs on every turn boundary, so no model call, no worker.
 *  2. LOW FALSE-POSITIVE TOLERANCE. A wrong emotion injected into the prompt is worse than
 *     no emotion: "上次你有点烦" said to someone who was not is actively irritating. Only
 *     explicit lexical markers count, and neutral text yields nothing.
 *  3. IMPORTANCE IS SEPARATE. A calm turn can still matter ("部署上线了"): intensity words
 *     raise importance without inventing a feeling.
 *  4. AGREE WITH THE PROJECTION. Emotions are stored under the same names the injection
 *     maps to Chinese (frustrated / tired / happy / …), so the two files cannot drift.
 *
 * Pure functions + one side-effecting helper.
 */

/**
 * Emotion lexicon. Order matters: the first match wins, and the strongest signals are
 * listed first so "烦死了" reads as frustration rather than "dead" being interesting.
 */
const EMOTION_RULES = [
  {
    emotion: 'frustrated',
    // 中文的烦躁/不满，以及英文同义表达。刻意避开单字（「烦」单独出现常是名词性用法）。
    pattern: /(?:烦死|好烦|很烦|有点烦|真烦|烦躁|恼火|上火|郁闷|崩溃|服了|无语|受不了|又(?:错|失败|挂)|怎么又|坑爹|气死|太坑|搞什么)/,
  },
  {
    emotion: 'tired',
    pattern: /(?:好累|很累|太累|累死|累趴|熬夜|通宵|没睡|困死|好困|撑不住|顶不住|干不动|脑子木)/,
  },
  {
    emotion: 'anxious',
    pattern: /(?:急死|来不及|赶时间|赶紧|快点|催|deadline|ddl|来不及了|有点急|慌了)/i,
  },
  {
    emotion: 'happy',
    pattern: /(?:太好了|搞定|成了|跑通了|成功|完美|漂亮|终于(?:好|可以|能|行)|顺了|nice|great|awesome|好用|真香|爽)/i,
  },
  {
    emotion: 'satisfied',
    pattern: /(?:可以了|够了|挺好|不错|满意|没问题|就这样|稳了|靠谱)/,
  },
  {
    emotion: 'confused',
    pattern: /(?:看不懂|没看懂|不明白|不懂|怎么回事|为啥|为什么(?:会|不)|什么鬼|懵|疑惑)/,
  },
];

/**
 * Wording that raises importance without naming a feeling.
 *
 * Broadened after a week of real use: `detectMood` was only firing on open frustration, so
 * pure technical sessions produced zero events and the "上次你有点烦" line could never have
 * anything to say. A calm but consequential turn ("上线了", "定了", "交付") deserves a record
 * too — it is the difference between remembering a mood and remembering a moment.
 */
const IMPORTANCE_RULES = [
  { weight: 0.9, pattern: /(?:上线|发布|部署|生产环境|正式环境|回滚|事故|故障|宕机|数据(?:丢|坏)|不可用)/ },
  { weight: 0.85, pattern: /(?:决定|确定|定了|敲定|拍板|就这么办|采用这个方案)/ },
  { weight: 0.8, pattern: /(?:交付|验收|提交|合并|merge|release|deploy|完成|搞定|跑通)/i },
  { weight: 0.75, pattern: /(?:第一次|最后一次|最终|定稿|确认了)/ },
  // A long working session is itself worth noting: "那晚我们一起把这个啃下来了".
  { weight: 0.7, pattern: /(?:通宵|熬夜|一整天|忙了一|干了一|弄了一)/ },
];

/**
 * Text that is mostly filler carries no mood. Kept small on purpose: the emotion patterns
 * are specific enough that a genuine signal inside a short message is still caught.
 */
const MIN_MOOD_LENGTH = 4;

/** Detect the user's apparent state from one message. */
export function detectMood(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < MIN_MOOD_LENGTH) return null;

  // Our own injected blocks are role=user but not the user speaking; never learn mood from them.
  if (/^\[以下是我记得的事情|^\[dsh-memory context/.test(s)) return null;

  let emotion = null;
  for (const rule of EMOTION_RULES) {
    if (rule.pattern.test(s)) {
      emotion = rule.emotion;
      break;
    }
  }

  let importance = null;
  for (const rule of IMPORTANCE_RULES) {
    if (rule.pattern.test(s)) {
      importance = rule.weight;
      break;
    }
  }

  if (emotion === null && importance === null) return null;

  return {
    emotion: emotion ?? 'neutral',
    // Important-but-calm turns get a high score; emotional-but-minor ones a middling one.
    importance: importance ?? 0.6,
    hasFeeling: emotion !== null,
  };
}

/**
 * Persist the mood of the turn that just finished.
 *
 * Runs from `agent/pre-step`, which sees the previous turn's user text — the same trick
 * that lets auto-capture work without a post-step hook. Fire-and-forget at the call site.
 *
 * Deduped per session by (emotion, first 40 chars) so a long frustrated stretch does not
 * write twenty identical events.
 */
export async function recordMood({ store, messages, logger, sessionId, skip = new Set() } = {}) {
  const log = logger ?? {};
  if (!store || typeof store.addEvent !== 'function') return null;

  const text = lastUserSpeech(messages);
  if (!text) return null;

  const mood = detectMood(text);
  if (!mood) return null;

  const key = `${mood.emotion}|${text.slice(0, 40)}`;
  if (skip.has(key)) return null;

  try {
    await store.addEvent({
      sessionId: sessionId ?? null,
      content: text.slice(0, 300),
      emotion: mood.emotion,
      importance: mood.importance,
      factId: null,
    });
    skip.add(key);
    try {
      log.info?.(`[dsh-memory] noted mood: ${mood.emotion} (importance ${mood.importance})`);
    } catch { /* logging is optional */ }
    return mood;
  } catch {
    return null;
  }
}

/**
 * The most recent real user utterance, skipping our injected memory blocks.
 * Unlike lib/autocapture.js#previousUserText this takes the LAST one, because mood is
 * about how the user sounds right now, not about the turn that just completed.
 */
function lastUserSpeech(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    const role = m?.role ?? m?.type;
    if (role !== 'user') continue;
    const content = m?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join(' ');
    }
    text = String(text ?? '').trim();
    if (!text) continue;
    if (/^\[以下是我记得的事情|^\[dsh-memory context/.test(text)) continue;
    return text;
  }
  return '';
}

export const MOOD_INFO = Object.freeze({
  emotions: EMOTION_RULES.map((r) => r.emotion),
  importanceSignals: IMPORTANCE_RULES.length,
});
