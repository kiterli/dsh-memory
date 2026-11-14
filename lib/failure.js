/**
 * lib/failure.js — turn tool failures into durable "don't do that again" memories.
 *
 * WHY
 *
 * The most valuable memory an assistant can hold is the one that stops it repeating a
 * mistake: "裸 spawn venv python main.py 会静默退出，必须跑 .bat". Today that only
 * reaches the store if the user types it out and it matches an auto-capture rule. But
 * the evidence already flows past the plugin on every turn — a tool call that failed.
 *
 * DESIGN CONSTRAINTS
 *
 *  1. `message.isError` is the ONLY failure signal. Do not infer failure from text:
 *     measuring this account's own session log, 66 of 354 tool results *contained* an
 *     error word (file contents being read included the word 错误) while exactly one was
 *     an actual failure. Text heuristics would have written 65 false "pitfalls".
 *
 *  2. ABORTS ARE NOT FAILURES. `AbortError` / `ABORTED` / cancellation and approval
 *     denials mean a human or policy stopped the call — repeating that as a lesson would
 *     teach the model to avoid something that is perfectly fine.
 *
 *  3. ONLY FAILURES WITH A REUSABLE CAUSE ARE KEPT. "ENOENT: file not found" for a path
 *     that never existed is noise. A permission error, a missing dependency, a non-zero
 *     exit, a rejected command — those repeat.
 *
 *  4. LOW TRUST, DISTINCT CATEGORY. Captured at trust 0.55 under `auto:failure`, so it
 *     ranks below anything the user stated and never masquerades as a fact.
 *
 *  5. IDEMPOTENT. The same signature (tool + normalised error line) is written once per
 *     session; a flapping command cannot flood the store.
 *
 * Pure functions + one side-effecting helper, so the classifier is unit-testable.
 */

/** Failures that mean "a human/policy stopped this", never "this is a bad approach". */
const ABORT_PATTERNS = [
  /AbortError/i,
  /\bABORTED\b/i,
  /\bcancell?ed\b/i,
  /\btool call aborted\b/i,
  /was aborted/i,
  /user interrupt/i,
  /approval (?:was )?(?:denied|rejected)/i,
  /Permission denied by (?:the )?user/i,
  /EPIPE/,
];

/**
 * Error shapes worth remembering: they describe a property of the environment or the
 * approach, so the same wall will be hit again. Ordered most specific first.
 */
const DURABLE_FAILURE_PATTERNS = [
  { id: 'permission', pattern: /EPERM|EACCES|access is denied|Permission denied|沙箱|sandbox: file access denied/i },
  // Environment/config walls: the same machine will hit them again on the next attempt,
  // which is exactly what makes them worth remembering. Calibrated on this account's own
  // session log, where all five real failures were one such message repeated.
  { id: 'env-config', pattern: /must be outside the workspace|ACL temp root|temp root must be|is not configured|environment variable .* is not set|PYTHONPATH|PYTHONHOME/i },
  { id: 'missing-binary', pattern: /(?:command not found|is not recognized as|not recognized as the name of)/i },
  { id: 'missing-dep', pattern: /(?:Cannot find module|MODULE_NOT_FOUND|No such file or directory|ENOENT)/i },
  { id: 'nonzero-exit', pattern: /(?:exit code \[?[1-9]|exited with code [1-9]|non-zero exit|\[exit code: [1-9])/i },
  { id: 'timeout', pattern: /(?:timed out|timeout|ETIMEDOUT)/i },
  { id: 'port-conflict', pattern: /(?:EADDRINUSE|address already in use)/i },
  { id: 'network', pattern: /(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|getaddrinfo)/i },
  { id: 'syntax', pattern: /(?:SyntaxError|Unexpected token|invalid JSON|JSON\.parse)/i },
  { id: 'assertion', pattern: /(?:AssertionError|assert\.\w+ failed|expect(?:ed)? .* to)/i },
  // Generic runtime error. Kept LAST and requires BOTH a concrete subject and the absence
  // of vague-filler wording (see RE_CONCRETE / RE_VAGUE below), so "Error: something went
  // wrong" is not turned into a lesson while "Error: ENOENT ... C:\x\y.json" still is.
  { id: 'runtime-error', pattern: /(?:^|\s)(?:Error|TypeError|RangeError|ReferenceError|URIError|EvalError)\s*:/ },
];

/**
 * A failure worth remembering must name something concrete: a filesystem path, a known
 * file type, a known binary, a SCREAMING_CASE env var/code, or a `backticked` identifier.
 *
 * An earlier version also accepted `--flag` shapes, which matched the hyphen inside
 * ordinary words ("some-thing went wrong") and let content-free noise through. Flags are
 * deliberately NOT a signal here: the concrete subject is what makes a failure reusable.
 */
const RE_CONCRETE = /(?:[A-Za-z]:\\|\\\\|[\w.-]+\.(?:js|mjs|cjs|json|md|py|ps1|bat|cmd|exe|db|log|yml|yaml|toml|lock)\b|\b(?:npm|pnpm|node|git|python|pwsh|powershell|cmd|docker|ffmpeg|comfyui)\b|\b[A-Z][A-Z0-9_]{3,}\b|`[^`]+`)/i;

/** Whole-word filler that marks a message as content-free even if it matches a pattern. */
const RE_VAGUE = /^(?:error|failed|failure|something went wrong|see the documentation|失败|出错了?)[\s:：.,，]*(?:something went wrong|see the documentation)?$/i;

const MAX_MEMORY_LENGTH = 300;
const MIN_MEMORY_LENGTH = 12;

/** Normalise text for signature/dedup and for the stored sentence. */
export function normalizeFailure(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    // Drop stack frames and progress noise: they differ run to run and carry no lesson.
    .filter((l) => !/^\s*at\s+\S/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the failure was caused by a human/policy stopping the call. */
export function isAbortFailure(text) {
  const s = String(text ?? '');
  return ABORT_PATTERNS.some((re) => re.test(s));
}

/**
 * Classify one failed tool result.
 *
 * @param {object} args
 * @param {string} args.tool   tool name (bash / write / edit / …)
 * @param {string} args.text   the tool's textual error output
 * @param {object} [args.error] structured error object, if the runtime supplied one
 * @returns {{keep: boolean, reason?: string, category?: string, signature?: string, content?: string}}
 */
export function classifyFailure({ tool, text, error } = {}) {
  const raw = String(text ?? '');
  const errorText = error ? [error.name, error.code, error.message].filter(Boolean).join(' ') : '';
  const combined = (raw + ' ' + errorText).trim();

  if (!combined) return { keep: false, reason: 'empty' };
  if (isAbortFailure(combined)) return { keep: false, reason: 'aborted' };

  const match = DURABLE_FAILURE_PATTERNS.find((p) => p.pattern.test(combined));
  if (!match) return { keep: false, reason: 'not-a-durable-failure' };

  const normalized = normalizeFailure(raw || errorText);
  if (normalized.length < MIN_MEMORY_LENGTH) return { keep: false, reason: 'too-short' };
  // Content-free messages teach nothing, even when they match an error shape.
  const subject = normalized.replace(/^(?:Error|TypeError|RangeError|ReferenceError|URIError|EvalError)\s*:\s*/i, '');
  if (RE_VAGUE.test(subject) || RE_VAGUE.test(normalized)) return { keep: false, reason: 'vague' };
  if (!RE_CONCRETE.test(normalized)) return { keep: false, reason: 'no-concrete-subject' };

  const clipped = normalized.length > MAX_MEMORY_LENGTH
    ? normalized.slice(0, MAX_MEMORY_LENGTH - 1) + '…'
    : normalized;

  // One memory per tool, so the sentence reads as a lesson, not a log line.
  const toolLabel = String(tool ?? '').trim() || '工具';
  const content = `${toolLabel} 失败（${match.id}）：${clipped}`;

  return {
    keep: true,
    category: 'auto:failure',
    kind: match.id,
    content,
    // Signature drives per-session dedup: same tool + same first error line = same wall.
    signature: `${toolLabel}|${match.id}|${clipped.slice(0, 80).toLowerCase()}`,
  };
}

/**
 * Scan a message list for failed tool results and turn them into memories.
 *
 * Called from `agent/pre-step`: at that moment the finished turn's tool results are part
 * of the transcript, so no extra hook is needed (see the note in lib/autocapture.js about
 * why the previous turn is the right unit of work).
 *
 * @returns {Promise<Array<{id: string, content: string, kind: string}>>}
 */
export async function captureFailures({ store, messages, logger, skip = new Set() } = {}) {
  const log = logger ?? {};
  if (!store || typeof store.upsertFact !== 'function') return [];
  const list = Array.isArray(messages) ? messages : [];

  // Tool call ids -> tool names, so a result can be labelled.
  const nameByCall = new Map();
  for (const m of list) {
    for (const c of (Array.isArray(m?.content) ? m.content : [])) {
      if (c?.type !== 'tool-call') continue;
      const id = c.callId ?? c.toolCallId ?? c.id;
      if (id && (c.name ?? c.toolName)) nameByCall.set(String(id), String(c.name ?? c.toolName));
    }
  }

  const written = [];
  for (const m of list) {
    // Only real tool results carry `isError`; this is the sole failure signal.
    const isToolResult = m?.role === 'tool' || m?.source?.kind === 'tool';
    if (!isToolResult || m?.isError !== true) continue;

    const text = (Array.isArray(m.content) ? m.content : [])
      .map((c) => (c?.type === 'text' ? c.text : ''))
      .join('\n');
    const callId = m.toolCallId ?? m.source?.callId ?? m.id;
    const tool = nameByCall.get(String(callId)) ?? 'tool';

    const verdict = classifyFailure({ tool, text });
    if (!verdict.keep) continue;
    if (skip.has(verdict.signature)) continue;

    try {
      const fact = await store.upsertFact({
        content: verdict.content,
        category: verdict.category,
        tags: ['auto', 'failure', verdict.kind],
        trust: 0.55,
        source: 'auto',
      });
      if (fact?.id) {
        skip.add(verdict.signature);
        written.push({ id: String(fact.id), content: verdict.content, kind: verdict.kind });
      }
    } catch {
      /* one bad capture must not stop the rest */
    }
  }

  if (written.length > 0) {
    try {
      log.info?.(`[dsh-memory] captured ${written.length} failure lesson(s) from the last turn`);
    } catch { /* logging is optional */ }
  }
  return written;
}

export const FAILURE_INFO = Object.freeze({
  kinds: DURABLE_FAILURE_PATTERNS.map((p) => p.id),
  abortPatterns: ABORT_PATTERNS.length,
  maxLength: MAX_MEMORY_LENGTH,
});
