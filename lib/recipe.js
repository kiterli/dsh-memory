/**
 * lib/recipe.js — remember the things that WORKED, not only the things that broke.
 *
 * WHY
 *
 * The store already learns from failure (`lib/failure.js`): a tool that errored becomes a
 * "don't do that again" lesson. But the most valuable thing an agent can carry between
 * sessions is a procedure it got RIGHT — the exact model name, the sampler settings, the
 * flag that finally made the pipeline run. Today that only reaches the store if the user
 * types it out and it happens to match a preference pattern.
 *
 * Evidence from this very machine: the most useful memory in the store (the Qwen-Image
 * text-to-image recipe with its five required sampling parameters) was recorded by hand
 * after a long debugging session. Nothing in the plugin would have written it.
 *
 * WHAT COUNTS AS A RECIPE
 *
 * A turn that:
 *   1. ran two or more successful tool calls (real work, not one `read`), and
 *   2. never failed during the turn (a retried-and-eventually-succeeded run is not a
 *      clean recipe — the user had to intervene), and
 *   3. produced concrete specifics worth repeating: a model/checkpoint name, a file path,
 *      a command with flags, or several `key=value` settings.
 *
 * Condition 3 is what separates a recipe from "we edited some files". Without it the store
 * fills with noise like "改了 3 个文件".
 *
 * LOW TRUST, MARKED, IDEMPOTENT — same discipline as the other capture paths: trust 0.6,
 * source 'auto', category 'auto:recipe', one per session per action signature.
 *
 * Pure functions + one side-effecting helper.
 */

/** A recipe needs at least this many successful tool calls in the turn. */
export const MIN_STEPS = 2;

/**
 * Tools whose output describes the RESULT rather than the METHOD. Reading a file or
 * searching the web is evidence-gathering, not a procedure worth repeating.
 */
const EVIDENCE_TOOLS = new Set([
  'read', 'glob', 'grep', 'webfetch', 'websearch', 'memory_search', 'memory_list',
  'list_toolsets', 'comfyui_object_info', 'comfyui_workflow_list', 'ocr_image',
]);

/** Tools that change the world: these are the steps of a procedure. */
const ACTION_TOOLS = new Set([
  'bash', 'pwsh', 'shell', 'write', 'edit', 'apply_patch', 'comfyui_run',
  'comfyui_workflow', 'comfyui_server_submit', 'subagent', 'workflow',
]);

/**
 * Concrete specifics that make a procedure reproducible, MOST REPRODUCIBLE FIRST.
 *
 * Order matters: the first specific becomes the recipe's signature and headline. A bare
 * output path identifies one run; a command with its flags or a model name identifies the
 * METHOD, which is the thing worth repeating. Extraction therefore sweeps the method-shaped
 * patterns first and only falls back to paths.
 */
const SPEC_PATTERNS = [
  // Several settings at once: key=value pairs (sampler/temperature/port/…)
  /(?:\b[\w.-]+\s*=\s*[\w./-]+\s*[,;]?\s*){2,}/,
  // A model / checkpoint / weight file name — the single most re-usable fact in a recipe
  /\b[\w.-]+\.(?:safetensors|gguf|ckpt|onnx|pt|pth|bin)\b/i,
  // A command with flags
  /\b[\w-]+\s+(?:--?[\w-]+(?:[= ]\S+)?\s*){2,}/,
  // An explicit tool/node invocation with structured args
  /(?:ComfyUI|n8n|docker|pnpm|npm|git|python|ffmpeg|node|corepack)\s+[\w-]{2,}[^\s]*/i,
  // A file path LAST: it identifies where output went, not how to do the thing again.
  /[A-Za-z]:\\[^\s"'<>|,]+/,
];

const MAX_RECIPE_LENGTH = 400;
const MIN_RECIPE_LENGTH = 20;

/**
 * Method-shaped specifics: every pattern except the bare filesystem path at the end.
 * A recipe whose only specifics are output paths teaches nothing repeatable.
 */
const METHOD_PATTERNS = SPEC_PATTERNS.slice(0, -1);

/** Normalise text for storage and for the dedup signature. */
export function normalizeRecipe(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // Extraction reads the JSON form of tool arguments, so escape artefacts leak into a
    // snippet ("--cfg 2.5\"}"). Strip the quoting debris before it reaches memory.
    .replace(/\\{2,}/g, '\\')
    .replace(/["']\s*[}\]]/g, '')
    .replace(/\\"/g, '"')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Collect the concrete specifics out of a turn's tool calls.
 *
 * Returns the snippets that a future run would need to reproduce the outcome, in the order
 * they appeared. Deliberately shallow: this reads tool ARGUMENTS (what was asked for), not
 * results, because the arguments are what a repeat run must match.
 */
export function extractSpecifics(calls, { max = 6 } = {}) {
  const found = [];
  const seen = new Set();
  for (const call of Array.isArray(calls) ? calls : []) {
    const args = call?.args ?? call?.input ?? {};
    const text = typeof args === 'string' ? args : JSON.stringify(args);
    for (const re of SPEC_PATTERNS) {
      const m = String(text).match(re);
      if (!m) continue;
      const snippet = normalizeRecipe(m[0]).slice(0, 160);
      if (snippet.length < 4) continue;
      const key = snippet.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(snippet);
      if (found.length >= max) return found;
    }
  }
  return found;
}

/**
 * Decide whether a finished turn is a recipe worth keeping.
 *
 * @param {object} args
 * @param {Array}  args.calls   tool calls of the turn: [{ name, args, isError? }]
 * @param {string} [args.summary] optional human summary of the turn
 * @returns {{keep: boolean, reason?: string, content?: string, signature?: string, steps?: number}}
 */
export function classifyRecipe({ calls, summary } = {}) {
  const list = Array.isArray(calls) ? calls : [];
  if (list.length === 0) return { keep: false, reason: 'no-calls' };

  // 1. No failures in the turn. A run that needed repair is a debugging story, which
  //    lib/failure.js already records from the other side.
  if (list.some((c) => c?.isError === true)) return { keep: false, reason: 'had-failure' };

  // 2. Real work: at least MIN_STEPS successful ACTION calls, and not merely evidence reads.
  const actions = list.filter((c) => {
    const name = String(c?.name ?? '').toLowerCase();
    if (c?.isError === true) return false;
    if (EVIDENCE_TOOLS.has(name)) return false;
    // Unknown tools count if they are not known evidence-gatherers.
    return ACTION_TOOLS.has(name) || name !== '';
  });
  if (actions.length < MIN_STEPS) return { keep: false, reason: 'too-few-steps' };

  // 3. Concrete specifics worth repeating.
  const specifics = extractSpecifics(list);
  if (specifics.length === 0) return { keep: false, reason: 'no-specifics' };

  // 3b. Those specifics must describe a METHOD, not merely where output landed. A turn that
  // only wrote files produces a "recipe" like "C:\out\a.json", which teaches nothing.
  const hasMethod = specifics.some((s) => METHOD_PATTERNS.some((re) => re.test(s)));
  if (!hasMethod) return { keep: false, reason: 'paths-only' };

  const tools = [...new Set(actions.map((c) => String(c?.name ?? 'tool')))];
  const summaryText = normalizeRecipe(summary ?? '');
  const head = summaryText
    ? summaryText.slice(0, 120)
    : `${tools.join(' + ')} 的成功流程`;

  const content = normalizeRecipe(
    `${head}（${actions.length} 步）：${specifics.join('；')}`,
  ).slice(0, MAX_RECIPE_LENGTH);

  if (content.length < MIN_RECIPE_LENGTH) return { keep: false, reason: 'too-short' };

  return {
    keep: true,
    category: 'auto:recipe',
    content,
    steps: actions.length,
    // Signature: the tool set plus the first specific. Same procedure twice in a session
    // should collapse.
    signature: `${tools.join('+')}|${specifics[0].slice(0, 60).toLowerCase()}`,
  };
}

/**
 * Capture the previous turn's successful procedure, if it was one.
 *
 * Called from `agent/pre-step` alongside the other capture passes.
 */
export async function captureRecipe({ store, messages, logger, skip = new Set() } = {}) {
  const log = logger ?? {};
  if (!store || typeof store.upsertFact !== 'function') return null;
  const list = Array.isArray(messages) ? messages : [];

  // Gather this turn's tool calls and their outcomes.
  const calls = [];
  const resultByCall = new Map();
  for (const m of list) {
    for (const c of (Array.isArray(m?.content) ? m.content : [])) {
      if (c?.type === 'tool-call') {
        calls.push({ name: c.name ?? c.toolName, args: c.arguments ?? c.input ?? c.args, callId: c.callId ?? c.toolCallId });
      }
    }
    if (m?.role === 'tool' || m?.source?.kind === 'tool') {
      const id = m.toolCallId ?? m.source?.callId;
      if (id) resultByCall.set(String(id), m.isError === true);
    }
  }
  for (const call of calls) {
    if (call.callId && resultByCall.has(String(call.callId))) {
      call.isError = resultByCall.get(String(call.callId));
    }
  }

  const verdict = classifyRecipe({ calls });
  if (!verdict.keep) return null;
  if (skip.has(verdict.signature)) return null;

  try {
    const fact = await store.upsertFact({
      content: verdict.content,
      category: verdict.category,
      tags: ['auto', 'recipe'],
      trust: 0.6,
      source: 'auto',
    });
    if (!fact?.id) return null;
    skip.add(verdict.signature);
    try {
      log.info?.(`[dsh-memory] captured a recipe (${verdict.steps} steps)`);
    } catch { /* logging is optional */ }
    return { id: String(fact.id), content: verdict.content, steps: verdict.steps };
  } catch {
    return null;
  }
}

export const RECIPE_INFO = Object.freeze({
  minSteps: MIN_STEPS,
  maxLength: MAX_RECIPE_LENGTH,
  evidenceTools: [...EVIDENCE_TOOLS],
  actionTools: [...ACTION_TOOLS],
});
