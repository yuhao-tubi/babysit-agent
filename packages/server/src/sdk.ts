/**
 * Shared helpers for reading Agent SDK outcomes.
 *
 * The SDK does NOT always deliver a terminal `result` message: when the
 * underlying Claude Code process exits non-zero, `Query.readMessages` replaces
 * the exit error with `Error("Claude Code returned an error result: <text>")`
 * and REJECTS the async iterator. A turn-budget cutoff takes that path — so
 * every `for await (const msg of query(...))` loop that wants to salvage partial
 * output must catch, not just inspect `msg.subtype`.
 */

/** True if an SDK error is the "Reached maximum number of turns" turn-budget cap. */
export function isMaxTurnsError(err: unknown): boolean {
  const message = (err as { message?: string } | null)?.message ?? String(err);
  return /maximum number of turns/i.test(message);
}
