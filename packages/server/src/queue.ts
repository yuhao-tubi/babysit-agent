/**
 * Bounded per-key job queue. `limit` jobs run at once per key, the rest wait FIFO.
 *
 * `limit` defaults to 1, which is the original strictly-serial behaviour and what
 * anything guarding a shared mutable resource still wants. A higher limit is only
 * sound for work whose jobs touch disjoint state: the Thread/artifact jobs here
 * each own a worktree directory keyed by id, and the one genuinely shared thing —
 * the base clone's `.git` — is serialized separately by `withBaseLock` below,
 * regardless of this limit.
 *
 * Why a limit at all: with limit 1, a repo with 24 queued Threads runs them
 * strictly end-to-end, so measured wall clock per Thread was 63-78% pure queue
 * waiting (one Thread: 2721s of its 3478s) while the machine sat mostly idle. The
 * work was never the slow part; the single lane was.
 *
 * Implemented with a counter plus a FIFO waiter list rather than the previous
 * promise chain, because a chain can only express limit 1 — and a chain also grows
 * a `.then` link per job for the lifetime of the key.
 */
export class SerialQueue {
  private active = new Map<string, number>();
  private waiters = new Map<string, (() => void)[]>();

  constructor(private readonly limit: number = 1) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`SerialQueue limit must be a positive integer, got ${limit}`);
    }
  }

  async run<T>(key: string, job: () => Promise<T>): Promise<T> {
    await this.acquire(key);
    try {
      return await job();
    } finally {
      // In `finally`, so a throwing job can never wedge the key — the failure is
      // still propagated to this caller, and only to this caller.
      this.release(key);
    }
  }

  /** Slots currently executing for a key. Exposed for diagnostics/tests. */
  activeCount(key: string): number {
    return this.active.get(key) ?? 0;
  }

  private acquire(key: string): Promise<void> {
    const n = this.active.get(key) ?? 0;
    if (n < this.limit) {
      this.active.set(key, n + 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const q = this.waiters.get(key) ?? [];
      q.push(resolve);
      this.waiters.set(key, q);
    });
  }

  private release(key: string): void {
    const q = this.waiters.get(key);
    const next = q?.shift();
    if (next) {
      // Hand the slot straight to the next waiter — the active count is unchanged,
      // so a burst can never transiently exceed `limit`.
      if (q!.length === 0) this.waiters.delete(key);
      next();
      return;
    }
    const n = (this.active.get(key) ?? 1) - 1;
    if (n <= 0) this.active.delete(key);
    else this.active.set(key, n);
  }
}

/**
 * How many jobs one repo may run at once on each queue.
 *
 * 3 is chosen against what a job actually consumes: a Thread or artifact job is
 * an agent run that sits at ~0% CPU waiting on the model (measured: 84% of a
 * run's wall clock was model latency, 4% was tool execution), so three in
 * parallel cost almost nothing in CPU and roughly 340 MB RSS each. The expensive
 * step — the gate — is capped at 1 per repo by `withGateLock` regardless of these
 * numbers, so raising them does not stack whole-app typechecks.
 *
 * Not config keys: these are a property of how the pipeline uses machine
 * resources, not a per-user preference, and a wrong value here is a
 * memory/thrash hazard rather than a taste question. Revisit them together with
 * `withGateLock`, never separately.
 */
const REPO_CONCURRENCY = 3;

/**
 * The artifact lane is deliberately MUCH wider than the Thread lane, because its
 * jobs are the cheapest work in the system and the most latency-sensitive to the
 * owner (a brief is worth having before you open the PR).
 *
 * Every job on this queue is read-only by construction: a `skipDeps` worktree on a
 * negative key, no `node_modules` provisioning, no build, no gate, and no GitHub
 * write. So the ceiling is set by what an idle-waiting agent costs, measured on
 * this machine with 6 concurrent runs:
 *
 *     RSS          219 MB per agent  (7 processes = 1.5 GB of 48 GB)
 *     CPU          4% total          (agents block on the model, not the CPU)
 *     disk         141 MB per skipDeps worktree
 *     throttling   zero 429/overloaded from Bedrock, GitHub quota untouched
 *
 * At 8, that is ~1.8 GB and ~1.1 GB of disk — well inside headroom, and the real
 * limit becomes model round-trip latency, which concurrency is what hides.
 *
 * The Thread lane stays at 3 on purpose: its job is not read-only. One job spans
 * verdict → fix → gate → push, so widening it multiplies the expensive half too
 * (the gate is separately capped at 1 per repo by `withGateLock`, which is what
 * makes even 3 safe there).
 */
const ARTIFACT_CONCURRENCY = 8;

/**
 * The per-repo work queue for OWNER-FACING Thread work (verdict, approve, reply,
 * resolve, instruction). Kept separate from PR-artifact generation so a burst of
 * overview/risks/quiz agents can't make an owner's click wait minutes behind them.
 *
 * Runs `REPO_CONCURRENCY` Threads at once per repo. Safe because each job owns a
 * worktree directory keyed by Thread id, the shared base `.git` is serialized by
 * `withBaseLock`, the gate is serialized by `withGateLock`, and a Thread cannot be
 * processed twice concurrently (`running.ts`'s claim — the guard that the old
 * limit-1 queue was implicitly providing).
 */
export const repoQueue = new SerialQueue(REPO_CONCURRENCY);

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
export const overviewQueue = new SerialQueue(ARTIFACT_CONCURRENCY);

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

/**
 * Per-repo mutex around the PRE-PUSH GATE — at most one gate per repo, whatever
 * the queue widths are.
 *
 * The gate is the one step in the pipeline that is genuinely expensive in machine
 * resources rather than in model latency: on `adRise/www` it runs a scoped
 * `lerna run build` plus `tsc --noEmit`, and a single `tsc` on that repo was
 * measured at 1.1 GB RSS (a full jest run, 961% CPU across 12 workers). Agent
 * runs, by contrast, sit at ~0% CPU waiting on the model — which is exactly why
 * widening the queues is safe and worthwhile for them.
 *
 * So the two are widened separately: several Threads may investigate concurrently,
 * but they file through the gate one at a time. Without this, raising `repoQueue`
 * to 3 would put three whole-app typechecks side by side and reproduce the
 * out-of-memory thrash the wider queue is meant to relieve.
 *
 * Deliberately NOT the same lock as `withBaseLock`: that one is a short git
 * critical section, this one wraps a multi-minute build. Sharing them would make
 * every `worktree add` wait behind someone else's typecheck.
 */
const gateLocks = new SerialQueue(1);

export function withGateLock<T>(key: string, gate: () => Promise<T>): Promise<T> {
  return gateLocks.run(key, gate);
}
