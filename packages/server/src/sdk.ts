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

import { homedir } from "node:os";
import { join } from "node:path";

/** True if an SDK error is the "Reached maximum number of turns" turn-budget cap. */
export function isMaxTurnsError(err: unknown): boolean {
  const message = (err as { message?: string } | null)?.message ?? String(err);
  return /maximum number of turns/i.test(message);
}

/**
 * Where the Agent SDK writes its OWN full JSONL transcript of a run: one folder
 * per `cwd`, named by replacing every non-alphanumeric character of the absolute
 * path with `-`, holding one `<sessionId>.jsonl` per session.
 *
 * That file is the only complete record of what an agent did — every tool call,
 * every result — and nothing in the SDK hands us the path. Our runs make it
 * effectively unreachable: the `cwd` is a per-thread worktree that is DELETED as
 * soon as the run ends, so after the fact you are re-deriving the slug of a
 * directory that no longer exists (a max-turns Verdict took a hand-guessed slug
 * to audit). Recording this at run time is what makes a failed run auditable.
 */
export function transcriptPath(cwd: string, sessionId: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/** The subset of an SDK message `RunTrace` reads. Keeps it usable from any surface. */
type TraceableMessage = {
  type?: string;
  subtype?: string;
  session_id?: string;
  num_turns?: number;
};

/** How much stderr to keep. Enough to see a crash, bounded so a chatty run can't grow it. */
const STDERR_TAIL_LINES = 5;
const STDERR_LINE_CAP = 300;

/**
 * Accumulates the facts you need to audit ONE agent run — turn count, session
 * transcript path, how it ended, blocked scans, tail of stderr — into a single
 * line for `logEvent`.
 *
 * Before this, a Verdict that burned its whole turn budget recorded nothing but
 * the escalation text: `stderr` was piped to a no-op, no turn count was kept,
 * the guard's denials were dropped, and the transcript path was never derived.
 * The daemon log held only poll lines, so "why did this run fail?" had no answer
 * anywhere. Feed every message through `note`, pass `stderr` to the SDK, and log
 * `describe()` once per run — on success too, since the turn counts of runs that
 * PASSED are how you size the budget.
 */
export class RunTrace {
  private turns = 0;
  private sessionId = "";
  private ended = "";
  private denials = 0;
  private stderrTail: string[] = [];

  constructor(private readonly cwd: string) {}

  /** Feed every message from the `query()` loop. */
  note(msg: TraceableMessage): void {
    if (msg.session_id) this.sessionId = msg.session_id;
    if (msg.type === "assistant") this.turns++;
    if (msg.type === "result") {
      if (msg.subtype) this.ended = msg.subtype;
      if (typeof msg.num_turns === "number") this.turns = msg.num_turns;
    }
  }

  /** Pass as the SDK's `stderr` option (bound, so `stderr: trace.stderr` works). */
  stderr = (chunk: string): void => {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      this.stderrTail.push(line.slice(0, STDERR_LINE_CAP));
    }
    if (this.stderrTail.length > STDERR_TAIL_LINES) {
      this.stderrTail = this.stderrTail.slice(-STDERR_TAIL_LINES);
    }
  };

  /** Pass as `agentGuardHooks`' `onDeny` so a blocked filesystem scan is visible. */
  deny = (): void => {
    this.denials++;
  };

  /** How the run ended, once known. Empty until a `result` message or `setEnd`. */
  get endSubtype(): string {
    return this.ended;
  }

  /**
   * Record an ending the SDK never delivered as a message — a turn-budget cutoff
   * rejects the iterator instead of emitting a `result` (see the module note).
   */
  setEnd(subtype: string): void {
    this.ended = this.ended || subtype;
  }

  /** One line for `logEvent`. */
  describe(): string {
    const parts = [`turns=${this.turns}`, `end=${this.ended || "no result"}`];
    if (this.denials > 0) parts.push(`blocked_scans=${this.denials}`);
    if (this.sessionId) parts.push(`transcript=${transcriptPath(this.cwd, this.sessionId)}`);
    if (this.stderrTail.length > 0) parts.push(`stderr: ${this.stderrTail.join(" ⏎ ")}`);
    return parts.join(" ");
  }
}
