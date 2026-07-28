/** Serial per-key job queue — ensures one repo clone isn't edited concurrently. */
export class SerialQueue {
  private chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(job, job);
    // Keep the chain alive but swallow rejection for the stored tail.
    this.chains.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  }
}

/**
 * The per-repo work queue for OWNER-FACING Thread work (verdict, approve, reply,
 * resolve, instruction). Kept separate from PR-artifact generation so a burst of
 * overview/risks/quiz agents can't make an owner's click wait minutes behind them.
 */
export const repoQueue = new SerialQueue();

/**
 * A SEPARATE per-repo queue for read-only PR-artifact generation (overview,
 * risks/blind-spots, quiz). These run long Claude agents (maxTurns 150) but are
 * read-only (`skipDeps` worktrees on a negative wtKey, never pushed), so they no
 * longer need to serialize against Thread work — only against EACH OTHER (one
 * heavy generation per repo at a time). This is the split that stops artifact
 * generation from preempting interactive actions. The two queues can now run
 * concurrently, so the base clone's git operations are guarded by `withBaseLock`
 * (see below) — that, not this queue, is what preserves decision 8's real
 * invariant (one mutation of a repo's `.git` at a time).
 */
export const overviewQueue = new SerialQueue();

/**
 * Per-repo async mutex guarding operations that mutate a base clone's shared
 * `.git` (fetch / `worktree add` / `worktree remove` / reset). Now that Thread
 * work (repoQueue) and artifact generation (overviewQueue) run concurrently,
 * their `addWorktree`/`removeWorktree` calls could otherwise hit the same base
 * clone at once — git's own index/ref locks would surface as sporadic failures.
 * This serializes just the short base-git critical section per repo, WITHOUT
 * serializing the long agent runs that follow (those work in per-id worktree
 * dirs that never collide). Keyed by `owner/repo`.
 */
const baseLocks = new Map<string, Promise<unknown>>();

export function withBaseLock<T>(key: string, critical: () => Promise<T>): Promise<T> {
  const prev = baseLocks.get(key) ?? Promise.resolve();
  const next = prev.then(critical, critical);
  baseLocks.set(
    key,
    next.catch(() => undefined)
  );
  return next;
}
