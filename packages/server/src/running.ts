/**
 * The authoritative record of which Threads have an agent/gate job ACTUALLY
 * EXECUTING right now. One structure, two jobs:
 *
 * 1. **The double-run guard.** `processThread` reads `status === "pending"`, then
 *    awaits a network call (the resolution recheck), and only then writes
 *    `in_progress`. That await is a yield point. Today the serial queue is what
 *    keeps two copies of the same Thread apart — not the status check — so the
 *    moment the queue runs more than one job per repo, two copies can both pass
 *    the check and both call `addWorktree` on the SAME path (it is keyed by
 *    thread id), and `addWorktree` deletes whatever sits there first. The loser's
 *    checkout vanishes under a live agent and the diff it produces is garbage —
 *    which is the artifact the owner would Approve and push. `claimRun` closes
 *    that window because it is synchronous: no yield point between check and claim.
 *
 * 2. **Telling QUEUED apart from RUNNING.** `in_progress` overloads two meanings.
 *    `approveThread` flips it synchronously *before* entering the queue (a
 *    deliberate choice — the owner's click must register even while the job waits),
 *    while `processThread` flips it *inside* the queue. The dashboard could not
 *    distinguish them, so it rendered three Threads as "Running 16m" when exactly
 *    one had an agent process and the other two had not executed a line. Reading
 *    "slow" off that display is impossible. A Thread is running iff it holds a
 *    claim; `in_progress` without a claim means queued.
 *
 * In-process by design: this mirrors the in-process `SerialQueue`, and a restart
 * clears it — which is correct, because a restart also kills every child agent.
 * `recoverInterrupted` is what re-drives Threads left `in_progress` by a crash.
 */
const running = new Set<number>();

/**
 * Try to take the run slot for `threadId`. Returns `false` if a job is already
 * executing for it — the caller must then return without doing any work.
 *
 * MUST be called as the first statement inside the queued closure (where work
 * genuinely begins), never at enqueue time — claiming at enqueue would put queued
 * Threads back into the "running" set and re-create the misreporting above.
 */
export function claimRun(threadId: number): boolean {
  if (running.has(threadId)) return false;
  running.add(threadId);
  return true;
}

/** Release the slot. Idempotent, so it is safe in a `finally` after an early return. */
export function releaseRun(threadId: number): void {
  running.delete(threadId);
}

/** Whether a job is executing for this Thread right now (not merely queued). */
export function isRunning(threadId: number): boolean {
  return running.has(threadId);
}

/** Every Thread with a job executing right now — the dashboard's `running` set. */
export function runningThreadIds(): number[] {
  return [...running];
}
