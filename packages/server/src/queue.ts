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
 * The process-wide per-repo work queue. Thread processing AND PR-overview
 * generation share this ONE instance so their git-worktree operations on the
 * same repo never collide (decision 8) — a diagram request queues behind any
 * in-flight Thread work for that repo, and vice versa.
 */
export const repoQueue = new SerialQueue();
