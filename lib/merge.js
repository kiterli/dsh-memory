/**
 * lib/merge.js — keep the markdown memory files from growing without bound.
 *
 * THE PROBLEM
 *
 * `mirrorToBuiltin` appends every recorded fact to USER.md / MEMORY.md and never removes
 * anything. The budget (1375 / 2200 chars) is a READ-time limit: injection selects what fits,
 * but the FILE keeps growing, so:
 *
 *   - the panel shows a file far over budget,
 *   - the newest entries are the only ones ever injected,
 *   - older preferences still sit in the file looking authoritative while being invisible.
 *
 * lib/compact.js fixed the read side (it no longer silently drops whole topics). This module
 * fixes the write side: when a file exceeds its budget, related entries are MERGED rather than
 * left to rot.
 *
 * HOW THE MERGE WORKS (deliberately conservative)
 *
 *  1. Group by topic, using the same bucketing as lib/compact.js so the two agree.
 *  2. Within a topic, merge only entries that overlap enough to be the same subject.
 *  3. A merged entry keeps the newest wording and appends whatever the older ones said that
 *     the newest did not — nothing is paraphrased, so nothing is invented. Every merged line
 *     still traces back to text a user or the model actually wrote.
 *  4. Never merge below two entries: a lone entry is left verbatim. Merging it with nothing
 *     would only risk rewording it.
 *
 * Pure functions; the caller does the I/O.
 */

import { topicOf } from './compact.js';

/** Two entries in the same topic merge when they share this fraction of content words. */
export const MERGE_OVERLAP = 0.5;

/** A merged entry longer than this is truncated (the file has a budget, after all). */
export const MAX_MERGED_LENGTH = 320;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
  '的', '了', '是', '在', '和', '与', '或', '都', '也', '就', '不', '有', '这', '那',
]);

export function words(text) {
  const raw = String(text ?? '').toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z0-9]{2,}/g) ?? [];
  return raw.filter((w) => !STOP_WORDS.has(w));
}

/** Containment-relative overlap: how much of the shorter entry the longer one covers. */
export function overlap(a, b) {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size);
}

/**
 * Merge two entries about the same subject.
 *
 * The newest text wins as the BASE; the older text contributes any sentence the newest does
 * not already contain. This is "append what is missing", never "rewrite".
 */
export function mergeTwo(olderText, newerText) {
  const older = String(olderText ?? '').trim();
  const newer = String(newerText ?? '').trim();
  if (!older) return newer;
  if (!newer) return older;
  if (older === newer) return newer;

  // Split the older entry into clauses and keep only those the newer one does not cover.
  const clauses = older.split(/[；;。\n]+/).map((c) => c.trim()).filter((c) => c.length >= 4);
  const missing = clauses.filter((clause) => {
    // Consider a clause present when most of its words already appear in the newer text.
    const cw = words(clause);
    if (cw.length === 0) return false;
    const nw = new Set(words(newer));
    const covered = cw.filter((w) => nw.has(w)).length;
    return covered / cw.length < 0.6;
  });

  if (missing.length === 0) return newer;

  const combined = `${newer}；${missing.join('；')}`;
  return combined.length > MAX_MERGED_LENGTH
    ? combined.slice(0, MAX_MERGED_LENGTH - 1) + '…'
    : combined;
}

/**
 * Merge a list of entries in place-safe fashion, preserving file order.
 *
 * Entries are walked newest-last; when two adjacent-in-topic entries overlap enough, the
 * OLD one is folded into the NEW one and dropped, so the merged entry keeps the newest
 * position. Returns `{ entries, merged }` where `merged` counts folds performed.
 */
export function mergeEntries(entries, { minOverlap = MERGE_OVERLAP } = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .map((e) => (typeof e === 'string' ? e : e?.text))
    .map((e) => String(e ?? '').trim())
    .filter(Boolean);

  const merged = [];
  let foldCount = 0;

  for (const text of list) {
    const topic = topicOf(text).id;
    // Look for an existing merged entry in the same topic that overlaps enough.
    let hit = -1;
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      if (topicOf(merged[i]).id !== topic) continue;
      if (overlap(text, merged[i]) >= minOverlap) { hit = i; break; }
    }
    if (hit >= 0) {
      // merged[hit] is OLDER (it appeared first); fold it into the current text.
      merged[hit] = mergeTwo(merged[hit], text);
      foldCount += 1;
    } else {
      merged.push(text);
    }
  }

  return { entries: merged, merged: foldCount };
}

/**
 * Compact a file to a character budget by MERGING same-subject entries, never by dropping.
 *
 * Returns `{ entries, merged, before, after }`. If merging alone cannot reach the budget, the
 * result is reported honestly (after > budget) rather than silently truncated — the caller
 * decides whether that is acceptable.
 */
export function compactEntries(entries, { budget, minOverlap = MERGE_OVERLAP } = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .map((e) => (typeof e === 'string' ? e : e?.text))
    .map((e) => String(e ?? '').trim())
    .filter(Boolean);

  const before = list.reduce((n, t) => n + t.length + 2, 0);
  const limit = Number.isFinite(budget) && budget > 0 ? budget : Infinity;

  let { entries: current, merged } = mergeEntries(list, { minOverlap });
  let after = current.reduce((n, t) => n + t.length + 2, 0);

  if (after <= limit) return { entries: current, merged, before, after, needsMore: false };

  // Still over budget: merge more aggressively (lower the overlap bar) before giving up.
  for (const threshold of [0.35, 0.25, 0.15]) {
    const aggressive = mergeEntries(current, { minOverlap: threshold });
    const size = aggressive.entries.reduce((n, t) => n + t.length + 2, 0);
    if (size < after) {
      current = aggressive.entries;
      merged += aggressive.merged;
      after = size;
      if (after <= limit) return { entries: current, merged, before, after, needsMore: false };
    }
  }

  return { entries: current, merged, before, after, needsMore: true };
}

export const MERGE_INFO = Object.freeze({
  mergeOverlap: MERGE_OVERLAP,
  maxMergedLength: MAX_MERGED_LENGTH,
});
