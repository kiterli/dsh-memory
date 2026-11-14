/**
 * lib/compact.js — keep a markdown memory file inside its budget WITHOUT silently
 * dropping the oldest entries.
 *
 * THE BUG THIS FIXES
 *
 * `readProfileText()` walks entries newest-first and `break`s the moment the cumulative
 * length would exceed the budget. Because it breaks (not continues), everything older
 * than that point is simply never injected — and nothing says so. A user's earliest
 * preferences, which are often the most load-bearing ("用简体中文", "不要分步问"), quietly
 * disappear as the file grows past 1375 characters. The panel still shows them, so the
 * file looks fine while the model has stopped seeing them.
 *
 * THE FIX
 *
 * Selection is no longer "newest that fits". Every entry is grouped into a topic bucket,
 * and the budget is spent so that:
 *
 *   1. each topic gets AT LEAST one representative (round-robin across topics), so no area
 *      of the profile is ever completely unrepresented;
 *   2. recurring topics keep MORE entries (a topic the user keeps returning to is more
 *      important than a one-off);
 *   3. within a topic, the newest wording wins, because the latest statement of a
 *      preference supersedes the older one.
 *
 * When even one-per-topic does not fit, the oldest entries of the largest topic are the
 * ones sacrificed — and a report is returned saying exactly what was left out, so the
 * caller can surface it instead of hiding it.
 *
 * Pure functions; no I/O.
 */

/** Topic buckets, most specific first. An entry matches the first bucket whose pattern hits. */
export const TOPIC_RULES = Object.freeze([
  { id: 'identity', label: '身份与称呼', pattern: /(?:名字|称号|称呼|叫我|助手名|小智|自称)/ },
  { id: 'language', label: '语言与表达', pattern: /(?:中文|英文|简体|繁体|locale|语言|回复用|措辞|术语)/i },
  // Work mode is checked BEFORE style: "一次性做完" is about how work is delivered, not
  // about how an answer reads, and the style pattern also mentions 一次性.
  { id: 'workflow', label: '工作模式与流程', pattern: /(?:工作模式|流程|先做|按顺序|不要问|别问|分步|步骤|审批|自行|一次性做完)/ },
  { id: 'style', label: '回答风格', pattern: /(?:极简|零废话|简洁|详细|啰嗦|风格|口吻|语气|角色|专家|全量|交付|不留尾巴)/ },
  { id: 'machine', label: '环境与机器', pattern: /(?:环境|硬件|显卡|显存|内存|CPU|GPU|RTX|R9000P|Windows|路径|端口|版本|安装)/i },
  { id: 'stack', label: '技术栈', pattern: /(?:技术栈|Go|Java|Node|Python|TypeScript|Rust|全栈|前端|后端)/i },
  { id: 'tools', label: '工具与插件', pattern: /(?:插件|ComfyUI|DSH|pnpm|corepack|git|vscode|docker)/i },
]);

/** Fallback bucket for anything that matches no rule. */
const OTHER = Object.freeze({ id: 'other', label: '其他' });

/** Which bucket does one entry belong to? */
export function topicOf(text) {
  const s = String(text ?? '');
  for (const rule of TOPIC_RULES) {
    if (rule.pattern.test(s)) return rule;
  }
  return OTHER;
}

/**
 * Select entries for injection under a character budget.
 *
 * @param {string[]} entries  memory entries in file order (oldest first)
 * @param {object}   options
 * @param {number}   options.budget  character budget for the rendered `- entry` lines
 * @param {number}   [options.perLineOverhead=2]  characters added by "- " and the newline
 * @returns {{ kept: string[], dropped: string[], topics: Array<{id:string,label:string,kept:number,total:number}>, used: number, budget: number }}
 */
export function selectWithinBudget(entries, { budget, perLineOverhead = 2 } = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .map((e) => (typeof e === 'string' ? e : e?.text))
    .map((e) => String(e ?? '').trim())
    .filter(Boolean);

  const limit = Number.isFinite(budget) && budget > 0 ? budget : Infinity;

  // Group while remembering original order, so "newest wins" is expressible.
  const groups = new Map();
  list.forEach((text, index) => {
    const topic = topicOf(text);
    if (!groups.has(topic.id)) groups.set(topic.id, { topic, items: [] });
    groups.get(topic.id).items.push({ text, index });
  });

  // Newest first inside each group.
  for (const group of groups.values()) group.items.sort((a, b) => b.index - a.index);

  const cost = (text) => text.length + perLineOverhead;

  // Round-robin across topics: guarantees every topic is represented before any topic
  // gets a second entry.
  const order = [...groups.values()].sort((a, b) => b.items.length - a.items.length);
  const keptSet = new Set();
  let used = 0;

  const tryTake = (item) => {
    const c = cost(item.text);
    if (used + c > limit) return false;
    keptSet.add(item.index);
    used += c;
    return true;
  };

  for (let round = 0; ; round += 1) {
    let progressed = false;
    for (const group of order) {
      const item = group.items[round];
      if (!item) continue;
      if (tryTake(item)) progressed = true;
    }
    if (!progressed) break;
    if (keptSet.size === list.length) break;
  }

  // Restore file order for the caller: memory reads more naturally chronologically.
  const kept = list.filter((_, i) => keptSet.has(i));
  const dropped = list.filter((_, i) => !keptSet.has(i));
  const topics = [...groups.values()].map((g) => ({
    id: g.topic.id,
    label: g.topic.label,
    total: g.items.length,
    kept: g.items.filter((it) => keptSet.has(it.index)).length,
  }));

  return { kept, dropped, topics, used, budget: limit === Infinity ? null : limit };
}

/**
 * A one-line, human-readable note about what was left out — the caller injects it so the
 * truncation is visible to the model (and to a user reading the transcript) instead of
 * being an invisible loss.
 */
export function describeOmission(result) {
  if (!result || result.dropped.length === 0) return '';
  const byTopic = result.topics
    .filter((t) => t.kept < t.total)
    .map((t) => `${t.label} ${t.kept}/${t.total}`);
  return `（受预算限制，另有 ${result.dropped.length} 条未注入：${byTopic.join('、')}）`;
}
