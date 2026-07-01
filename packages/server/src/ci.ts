// CI feedback helpers — see CONTEXT.md and memory/ci-feedback-design.md.
//
// A failing CI check is abstracted as a `ci` author-class Thread. This module
// owns the pure logic: which checks we babysit (the allowlist + gate class),
// the synthetic feedback id (negative, to namespace away from real comment ids),
// and where the failed-check log is materialized (OUTSIDE any worktree, so it
// can never be committed).

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { getChecks, getFailedCheckLogs } from "./gh.js";
import type { CiClass, ThreadRow } from "./types.js";

/** A configured allowlist entry: a case-insensitive name pattern + its gate class. */
export interface CheckAllowEntry {
  /** Substring matched (case-insensitive) against the GitHub check name. */
  pattern: string;
  /** Gate class the matching check maps to. */
  class: CiClass;
}

/** Check conclusions we treat as an actionable failure (decision Q4). */
export const ACTIONABLE_CONCLUSIONS = new Set(["failure", "timed_out"]);

/**
 * Match a check name against the configured allowlist. Returns the gate class of
 * the first matching entry, or null if the check is not babysat. Case-insensitive
 * substring match — handles matrix/sharded names like "test (shard 1)".
 */
export function classifyCheck(checkName: string): CiClass | null {
  const name = checkName.toLowerCase();
  for (const e of loadConfig().ci.checkAllowlist) {
    if (name.includes(e.pattern.toLowerCase())) return e.class;
  }
  return null;
}

/** The threadKey for a CI failure on a given check name. */
export function ciThreadKey(checkName: string): string {
  return `ci:${checkName}`;
}

/**
 * Synthetic feedback id for a CI failure. NEGATIVE by construction so it can
 * never collide with a real (positive) GitHub comment id. Identity is
 * (check-name + head-sha): a new commit yields a new id, which the poller reads
 * as new activity and re-opens the Thread. Re-polling the same failing commit
 * yields the same id (no thrash).
 */
export function ciFeedbackId(checkName: string, headSha: string): number {
  const h = createHash("sha256").update(`${checkName}\0${headSha}`).digest();
  // Take 6 bytes → fits in 2^48, well inside JS safe-integer range, then negate.
  const n = h.readUIntBE(0, 6);
  return -n;
}

/** Absolute path where a CI failure's log is materialized — OUTSIDE any worktree. */
export function ciLogPath(threadId: number): string {
  return join(homedir(), ".babysit-agent", "ci-logs", `${threadId}.log`);
}

/** Best-effort removal of a thread's materialized CI log (called on finalize). */
export function cleanupCiLog(threadId: number): void {
  try {
    rmSync(ciLogPath(threadId), { force: true });
  } catch {
    /* best-effort — the file is outside any repo, harmless if it lingers */
  }
}

/** Hard cap on a materialized log (protects prompt budget / disk). */
const LOG_CAP_BYTES = 512 * 1024;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
/**
 * GitHub Actions `--log-failed` prefixes EVERY line with
 * `"<job>\t<step>\t<ISO-8601 timestamp> "`. That prefix (plus ANSI color codes)
 * is pure noise that (a) bloats the log past the cap and (b) breaks line-anchored
 * failure markers like `FAIL `/`●`. Match and strip it.
 */
const GH_LINE_PREFIX_RE = /^[^\t\n]*\tUNKNOWN STEP\t\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/gm;

/**
 * Normalize a raw GitHub Actions check log: strip ANSI escapes and the per-line
 * `<job>\tUNKNOWN STEP\t<timestamp>` prefix. This makes the log human/grep-able
 * AND typically shrinks it enough to skip elision entirely (the prefix+ANSI are
 * roughly half the bytes). Failure markers (`✕`, `●`, `FAIL `) only match cleanly
 * after this runs.
 */
export function cleanCiLog(raw: string): string {
  return raw.replace(ANSI_RE, "").replace(GH_LINE_PREFIX_RE, "");
}

/**
 * Markers that locate the actual failure in a (cleaned) CI log, most-precise
 * first. Jest's reporter prints `✕`/`✗` on the individual failing TEST line (with
 * its exact name) — a tighter anchor than the `●`/`FAIL ` suite summaries — so we
 * prefer it. The `●`/`FAIL ` forms are line-anchored but allow leading indentation
 * (Jest indents the failing-suite header). Falls back to the GitHub Actions error
 * annotation and the run summary. The first occurrence anchors the kept "focus"
 * window when eliding.
 */
const FAILURE_MARKERS = ["✕ ", "✗ ", /^\s*● /m, /^\s*FAIL /m, "##[error]", /^Tests:/m];

/** Byte offset of the first failure marker in the buffer, or -1 if none. */
function firstFailureOffset(buf: Buffer): number {
  const text = buf.toString("utf8");
  let bestChar = -1;
  for (const m of FAILURE_MARKERS) {
    let charIdx = -1;
    if (typeof m === "string") {
      charIdx = text.indexOf(m);
    } else {
      const match = m.exec(text);
      // For a line-anchored regex, point at the marker token (skip leading
      // whitespace the pattern allowed) so the focus window centers on it.
      if (match) charIdx = match.index + (match[0].length - match[0].trimStart().length);
    }
    if (charIdx !== -1 && (bestChar === -1 || charIdx < bestChar)) bestChar = charIdx;
  }
  if (bestChar === -1) return -1;
  // Convert the char index to a BYTE offset (the log can contain multibyte UTF-8).
  return Buffer.byteLength(text.slice(0, bestChar), "utf8");
}

/**
 * Snap a byte offset to a line boundary so slices never cut mid-line. If no
 * boundary exists within reach (a pathological line longer than the budget), fall
 * back to a hard cut at the raw offset rather than collapsing the region — keeps
 * the kept bytes bounded by the budget instead of swallowing the whole buffer.
 */
function snapToLine(buf: Buffer, offset: number, dir: -1 | 1): number {
  if (offset <= 0) return 0;
  if (offset >= buf.byteLength) return buf.byteLength;
  if (dir < 0) {
    const nl = buf.lastIndexOf(0x0a, offset);
    return nl === -1 ? offset : nl + 1;
  }
  const nl = buf.indexOf(0x0a, offset);
  return nl === -1 ? offset : nl + 1;
}

/**
 * Reduce an over-cap log to <= cap bytes while preserving the parts that matter:
 * the head (run/setup context), the tail (Jest's end-of-run "Summary of all
 * failing tests" + the `##[error]` exit line), and — crucially — a window
 * centered on the FIRST failure marker, which a blind head/tail split would drop
 * for a failure buried in the middle of a sharded run. Regions are snapped to line
 * boundaries and merged; each gap is replaced with a byte-count elision marker.
 */
export function elideLog(log: string, cap = LOG_CAP_BYTES): string {
  const buf = Buffer.from(log, "utf8");
  if (buf.byteLength <= cap) return log;

  // Budget the cap across head / focus / tail. Tail is largest because Jest's
  // failure summary and the exit-code annotation live at the very end.
  const headBudget = Math.floor(cap * 0.2);
  const tailBudget = Math.floor(cap * 0.35);
  const focusBudget = cap - headBudget - tailBudget;

  type Region = { start: number; end: number };
  const regions: Region[] = [
    { start: 0, end: snapToLine(buf, headBudget, -1) },
  ];

  const fail = firstFailureOffset(buf);
  if (fail !== -1) {
    const half = Math.floor(focusBudget / 2);
    regions.push({
      start: snapToLine(buf, Math.max(0, fail - half), -1),
      end: snapToLine(buf, Math.min(buf.byteLength, fail + half), 1),
    });
  }

  regions.push({ start: snapToLine(buf, buf.byteLength - tailBudget, -1), end: buf.byteLength });

  // Merge overlapping/adjacent regions (sorted by start).
  regions.sort((a, b) => a.start - b.start);
  const merged: Region[] = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }

  // Stitch kept regions together, marking each elided gap with its byte count.
  const parts: string[] = [];
  for (let i = 0; i < merged.length; i++) {
    if (i > 0) {
      const gap = merged[i].start - merged[i - 1].end;
      parts.push(`\n\n…[${gap} bytes elided]…\n\n`);
    }
    parts.push(buf.subarray(merged[i].start, merged[i].end).toString("utf8"));
  }
  return parts.join("");
}

/** Retry a transient `gh` call a few times before giving up (decision Q15). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        // Linear backoff (500ms, 1000ms…) — a `gh`/network blip usually clears fast.
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * Fetch the failing check's log for a CI thread (current head) and write it to
 * an absolute path OUTSIDE any worktree, so it can never be committed. Returns
 * the path on success, or null only when the run genuinely has no failed-step
 * log to fetch (caller escalates, decision Q15).
 *
 * A *transient* `gh`/network failure is retried; if it still fails it THROWS, so
 * the pipeline records a recoverable `error` and re-drives the thread next poll
 * cycle — rather than permanently `blocked` on a blip. The raw log is normalized
 * (ANSI + GitHub line-prefix stripped, see `cleanCiLog`) — which also halves its
 * size, usually below the cap; if it still exceeds the cap we keep the head, the
 * tail, and a window around the first failure marker so it is never lost.
 */
export async function materializeCiLog(s: ThreadRow): Promise<string | null> {
  const checkName = s.threadKey.replace(/^ci:/, "");
  const checks = await withRetry(() => getChecks(s.owner, s.repo, s.number));
  const runId = checks.find((c) => c.name === checkName)?.runId ?? null;
  if (runId == null) return null;

  const raw = await withRetry(() => getFailedCheckLogs(s.owner, s.repo, runId));
  if (!raw.trim()) return null;

  const path = ciLogPath(s.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, elideLog(cleanCiLog(raw)));
  return path;
}
