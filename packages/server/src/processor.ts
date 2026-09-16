import { loadConfig } from "./config.js";
import {
  getThread,
  getThreadItems,
  interruptedInstruction,
  isPrExpired,
  listThreads,
  logEvent,
  threadAttemptCount,
  updateThread,
  wasInterruptedApproving,
} from "./db.js";
import { getChecks, getResolvedThreadKeys, resolveReviewThread } from "./gh.js";
import { ACTIONABLE_CONCLUSIONS, cleanupCiLog } from "./ci.js";
import { isIgnoredAuthor, isIgnoredRepo } from "./classify.js";
import { runVerdict } from "./verdict.js";
import {
  approveProposal,
  dismissReplyProposal,
  execute,
  postReply,
  parkAlreadyNotified,
  postReplyProposal,
  type StaleProposal,
} from "./executor.js";
import { notifyEscalation } from "./notify.js";
import { onEvent, emit } from "./events.js";
import { repoQueue } from "./queue.js";
import { claimRun, releaseRun } from "./running.js";
import type { ThreadRow } from "./types.js";

const queue = repoQueue;

/**
 * Enqueue Thread work, holding the Thread's run claim for exactly as long as the
 * job actually executes.
 *
 * Every queued closure below goes through this rather than `queue.run` directly,
 * for two reasons (see running.ts):
 *
 *  - It is the double-run guard. The `status !== "pending"` re-check inside these
 *    closures is not sufficient on its own — there is an `await` between reading
 *    the status and writing `in_progress`, and today only the serial queue keeps
 *    two copies of one Thread from interleaving there. The claim is synchronous,
 *    so it holds no matter how wide the queue gets.
 *  - It is what makes RUNNING observable. The claim is taken inside the closure,
 *    where work genuinely starts — so a Thread sitting in the queue with
 *    `status: "in_progress"` (which `approveThread` sets before enqueueing, on
 *    purpose) is correctly reported as queued, not running.
 *
 * A refused claim returns without doing any work: something is already running for
 * this Thread, and it will settle the Thread itself.
 */
function runClaimed(repoKey: string, id: number, job: () => Promise<void>): Promise<void> {
  return queue.run(repoKey, async () => {
    if (!claimRun(id)) return;
    try {
      await job();
    } finally {
      releaseRun(id);
    }
  });
}

/** Process one pending thread: re-check resolution → verdict → loop-guard → execute. */
export async function processThread(id: number): Promise<void> {
  const s = getThread(id);
  if (!s || s.status !== "pending") return;
  const cfg = loadConfig();

  // Repo scope is authoritative for the whole pipeline, not just polling: a
  // thread that predates the allow/ignore lists must not be acted on.
  if (isIgnoredRepo(s.owner, s.repo)) {
    logEvent(id, "skipped_repo", `${s.owner}/${s.repo} not in scope`);
    finalize(id, "resolved");
    return;
  }

  // Never act on a thread whose PR has expired (merged/closed since last poll).
  // The PR + its threads are retained for history in the "Expired" section, but
  // the pipeline must not push/reply against a PR that is no longer open. Leave
  // the thread in its current state rather than finalizing — it's frozen history.
  if (isPrExpired(s.prKey)) {
    logEvent(id, "skipped_expired", `${s.prKey} is merged/closed; not acting`);
    return;
  }

  // Ignored-author scope is authoritative for the whole pipeline too, not just
  // polling: a Thread queued before `ignoreAuthors` gained an entry must resolve
  // without a Verdict rather than get triaged. CI threads are exempt (synthetic
  // author). The root author is the earliest item's (items are created-at ordered).
  if (s.authorClass !== "ci") {
    const rootAuthor = getThreadItems(id)[0]?.author;
    if (rootAuthor && isIgnoredAuthor(rootAuthor)) {
      logEvent(id, "skipped_author", `${rootAuthor} on ignoreAuthors; resolved without verdict`);
      finalize(id, "resolved");
      return;
    }
  }

  await runClaimed(`${s.owner}/${s.repo}`, id, async () => {
    const fresh = getThread(id);
    if (!fresh || fresh.status !== "pending") return;

    // Q5: never act on a thread that turned resolved since it was queued. For CI
    // threads there is no GitHub "resolved" flag — a check that is now passing or
    // absent on the current head is the resolved condition (decision Q5/Q20).
    try {
      if (fresh.authorClass === "ci") {
        const checkName = fresh.threadKey.replace(/^ci:/, "");
        const checks = await getChecks(fresh.owner, fresh.repo, fresh.number);
        const match = checks.find((c) => c.name === checkName);
        const stillFailing =
          match && match.status === "completed" && match.conclusion && ACTIONABLE_CONCLUSIONS.has(match.conclusion);
        if (!stillFailing) {
          logEvent(id, "skipped_resolved", `${fresh.threadKey} passing/absent before action`);
          finalize(id, "resolved");
          return;
        }
      } else {
        const resolved = await getResolvedThreadKeys(fresh.owner, fresh.repo, fresh.number);
        if (resolved.has(fresh.threadKey)) {
          logEvent(id, "skipped_resolved", `${fresh.threadKey} resolved before action`);
          finalize(id, "resolved");
          return;
        }
      }
    } catch {
      // If the resolution check fails, proceed — the verdict step is read-only.
    }

    updateThread(id, { status: "in_progress" });
    emit({ type: "thread_updated", threadId: id });
    try {
      const items = getThreadItems(id);
      const verdict = await runVerdict(fresh, items);
      updateThread(id, { verdict, replyDraft: verdict.reply_draft });
      logEvent(id, "verdict", `${verdict.action} (risk=${verdict.risk}) ${verdict.summary}`);

      // Loop-guard: if this thread already auto-pushed >= maxThreadAttempts
      // times, escalate instead of proposing again. (Only auto-pushed attempts
      // increment attemptCount; parked proposals don't, so this guards the
      // autonomous-push classes from thrashing — owner-approved pushes are the
      // owner's call and aren't loop-limited here.)
      if (
        verdict.action === "propose" &&
        threadAttemptCount(fresh.prKey, fresh.threadKey) >= cfg.maxThreadAttempts
      ) {
        logEvent(id, "loop_guard", `>= ${cfg.maxThreadAttempts} attempts on thread; escalating`);
        notifyEscalation(id, fresh.prKey, "bot still objecting after repeated fixes");
        finalize(id, "blocked");
        return;
      }

      const status = await execute(fresh, verdict);
      finalize(id, status);
    } catch (err: any) {
      logEvent(id, "error", err?.message ?? String(err));
      updateThread(id, { status: "error", error: err?.message ?? String(err) });
      emit({ type: "thread_updated", threadId: id });
    }
  });
}

/**
 * Apply a user instruction to a blocked / awaiting_approval thread and re-run the
 * executor. A freeform instruction always RE-PROPOSES (it never pushes — only
 * Approve pushes); `reply:`/`ignore` short-circuit. The thread typically lands
 * back at `awaiting_approval` with a fresh proposal to review.
 */
export async function applyInstruction(id: number, instruction: string): Promise<void> {
  const s = getThread(id);
  if (!s) throw new Error(`no thread #${id}`);
  // Reflect the click SYNCHRONOUSLY — before entering the serial queue — so a
  // refresh reads the working state even while this job waits behind other
  // in-flight repo work (mirrors approveThread). This is a Group-2 action: it
  // runs a fix agent in a worktree, so it MUST stay on the queue; the pre-flip is
  // what keeps it from looking dead while queued.
  updateThread(id, { status: "in_progress", error: null });
  emit({ type: "thread_updated", threadId: id });
  await runClaimed(`${s.owner}/${s.repo}`, id, async () => {
    const fresh = getThread(id);
    if (!fresh) return;
    try {
      const verdict = fresh.verdictJson
        ? JSON.parse(fresh.verdictJson)
        : { action: "propose", summary: "", reply_draft: "", risk: "medium" };
      logEvent(id, "instruction", instruction.slice(0, 300));
      const status = await execute(fresh, verdict, { instruction });
      finalize(id, status);
    } catch (err: any) {
      logEvent(id, "error", err?.message ?? String(err));
      updateThread(id, { status: "error", error: err?.message ?? String(err) });
      emit({ type: "thread_updated", threadId: id });
    }
  });
}

/**
 * Approve a parked proposal — the sole push path. Applies the frozen proposal
 * (code: apply-check + re-gate + ff-push; pr_body: gh pr edit) and finalizes.
 * The `approve` event (with no later `finalized`) lets restart-recovery re-drive
 * an interrupted apply+push deterministically.
 */
export async function approveThread(id: number): Promise<void> {
  const s = getThread(id);
  if (!s) throw new Error(`no thread #${id}`);
  if (!s.proposalJson) return;
  // Reflect the click SYNCHRONOUSLY — before entering the serial queue — so a
  // refresh reads the approved/working state even while this job waits behind
  // other in-flight repo work. (Previously the status only flipped once the queued
  // job started running; a long re-gate ahead of it made the click look ignored.)
  // The `approve` event with no later `finalized` also lets restart-recovery
  // re-drive an interrupted apply+push.
  updateThread(id, { status: "in_progress", error: null });
  logEvent(id, "approve", "owner approved the proposal");
  emit({ type: "thread_updated", threadId: id });
  await applyFrozenProposal(id, s.owner, s.repo);
}

/**
 * Apply a Thread's frozen proposal on the repo queue and settle it — the shared body
 * of Approve and Retry (and so of restart recovery, which re-drives Retry).
 *
 * When Approve finds the frozen diff conflicting with upstream, `approveProposal`
 * hands back a rebuild instruction instead of a status. We run it as an ordinary
 * instruction re-propose, but only AFTER the queue job returns: `SerialQueue` is not
 * re-entrant and the rebuild needs the queue for its own worktree, so re-entering
 * here would deadlock. The rebuilt proposal parks at `awaiting_approval` and is
 * never pushed — the diff is different bytes than the owner reviewed, so it takes a
 * second Approve. That park is the only banner for the whole stale→rebuild trip: the
 * conflict itself is silent, and a rebuild that fails notifies from its own path.
 *
 * Routing the rebuild through `applyInstruction` does NOT replay the stored Verdict
 * decision (the thing restart recovery is forbidden from doing): a freeform
 * instruction forces `action = "propose"` in `execute`, ahead of every verb branch,
 * so a Thread whose verdict was `escalate`/`reply`/`amend_pr_body` cannot re-run that
 * action here. Only the verdict's non-deciding fields (its summary, its `risk`) are
 * still read.
 */
async function applyFrozenProposal(id: number, owner: string, repo: string): Promise<void> {
  // A box, not a plain `let`: the assignment happens inside the queued closure, which
  // control-flow analysis can't see.
  const box: { stale: StaleProposal | null } = { stale: null };
  await runClaimed(`${owner}/${repo}`, id, async () => {
    const fresh = getThread(id);
    if (!fresh || !fresh.proposalJson) return;
    try {
      const outcome = await approveProposal(fresh);
      // Stale: not an ending. Leave the Thread `in_progress` (no `blocked` flash, no
      // `finalized` event) — the rebuild below carries it to its real resting state.
      if (typeof outcome === "object" && "stale" in outcome) {
        box.stale = outcome;
        return;
      }
      finalize(id, outcome);
    } catch (err: any) {
      logEvent(id, "error", err?.message ?? String(err));
      updateThread(id, { status: "error", error: err?.message ?? String(err) });
      emit({ type: "thread_updated", threadId: id });
    }
  });
  if (!box.stale) return;
  // Same catch shape as every other action body here: a throw must land the Thread
  // on `error`, not strand it `in_progress` and reject into the HTTP caller.
  try {
    await applyInstruction(id, box.stale.instruction);
    const after = getThread(id);
    // One banner for the whole trip: skip ours when parking the rebuilt proposal
    // already raised one (inconclusive gate / high risk) — those also send the owner
    // to the card, and two banners for one click is noise.
    if (after?.status === "awaiting_approval" && !parkAlreadyNotified(after)) {
      notifyEscalation(id, after.prKey, "upstream changed those lines; rebuilt the fix — approve again");
    }
  } catch (err: any) {
    logEvent(id, "error", err?.message ?? String(err));
    updateThread(id, { status: "error", error: err?.message ?? String(err) });
    emit({ type: "thread_updated", threadId: id });
  }
}

/**
 * Approve and post a parked proposal's drafted REPLY — the reply half of the
 * two-part approval. Logs an `approve` event so an interrupted reply-post is
 * re-driven by restart recovery (idempotent: `postReplyProposal` no-ops once
 * `replyPosted`).
 */
export async function approveReply(id: number): Promise<void> {
  const s = getThread(id);
  if (!s) throw new Error(`no thread #${id}`);
  if (!s.proposalJson) return;
  // Flip status + log the approval synchronously (see approveThread) so a refresh
  // sees the click immediately even while queued behind other repo work.
  updateThread(id, { status: "in_progress", error: null });
  logEvent(id, "approve", "owner approved the reply");
  emit({ type: "thread_updated", threadId: id });
  await runClaimed(`${s.owner}/${s.repo}`, id, async () => {
    const fresh = getThread(id);
    if (!fresh || !fresh.proposalJson) return;
    try {
      const status = await postReplyProposal(fresh);
      finalize(id, status);
    } catch (err: any) {
      logEvent(id, "error", err?.message ?? String(err));
      updateThread(id, { status: "error", error: err?.message ?? String(err) });
      emit({ type: "thread_updated", threadId: id });
    }
  });
}

/** Dismiss a parked proposal's drafted reply without posting it. */
export async function dismissReply(id: number): Promise<void> {
  const s = getThread(id);
  if (!s) throw new Error(`no thread #${id}`);
  // NOT on the repo queue (see replyDirect): dismissing only mutates the frozen
  // proposal in the DB row — no worktree, no GitHub write — so it runs inline and
  // stays responsive behind long repo-queue work.
  const fresh = getThread(id);
  if (!fresh || !fresh.proposalJson) return;
  try {
    const status = await dismissReplyProposal(fresh);
    finalize(id, status);
  } catch (err: any) {
    logEvent(id, "error", err?.message ?? String(err));
    updateThread(id, { status: "error", error: err?.message ?? String(err) });
    emit({ type: "thread_updated", threadId: id });
  }
}

/**
 * Post a direct reply to a Thread's GitHub thread, using the instruction text
 * verbatim as the reply body (no agent, no verdict). For inline review-comment
 * threads this replies in-thread; otherwise it posts a top-level issue comment.
 * The Thread is then marked resolved. Honors dryRun.
 */
export async function replyDirect(id: number, body: string): Promise<void> {
  const s = getThread(id);
  if (!s) throw new Error(`no thread #${id}`);
  const text = body.trim();
  if (!text) return;
  const cfg = loadConfig();
  // NOT on the repo queue: a direct reply only posts a GitHub comment + updates
  // the DB row — it touches no worktree, so the queue's "one clone edited at a
  // time" invariant doesn't apply. Running it inline keeps the owner's click
  // responsive even while a long verdict/fix job holds the repo queue. Outcome
  // (resolved/error) reaches the UI via the emitted `thread_updated` event.
  const fresh = getThread(id);
  if (!fresh) return;
  try {
    if (cfg.dryRun) {
      logEvent(id, "dry_run", `would reply: ${text}`);
    } else {
      await postReply(fresh, getThreadItems(id), text);
      logEvent(id, "replied", text);
    }
    finalize(id, "resolved");
  } catch (err: any) {
    logEvent(id, "error", err?.message ?? String(err));
    updateThread(id, { status: "error", error: err?.message ?? String(err) });
    emit({ type: "thread_updated", threadId: id });
  }
}

/**
 * Manually mark a Thread resolved. For an inline review-comment thread we also
 * resolve the GitHub thread (so it stops resurfacing each poll). Honors dryRun.
 */
export async function resolveThread(id: number): Promise<void> {
  const s = getThread(id);
  if (!s) throw new Error(`no thread #${id}`);
  const cfg = loadConfig();
  // NOT on the repo queue (see replyDirect): resolving only calls `gh` to resolve
  // the review thread + updates the DB row — no worktree is touched, so it runs
  // inline and stays responsive behind long repo-queue work.
  const fresh = getThread(id);
  if (!fresh) return;
  try {
    // Only inline review-comment threads have a resolvable GitHub thread.
    const rootId = fresh.threadKey.match(/^thread:(\d+)$/)?.[1];
    if (rootId) {
      if (cfg.dryRun) {
        logEvent(id, "dry_run", `would resolve GitHub thread ${fresh.threadKey}`);
      } else {
        const ok = await resolveReviewThread(fresh.owner, fresh.repo, fresh.number, Number(rootId));
        logEvent(id, ok ? "gh_resolved" : "gh_resolve_miss", fresh.threadKey);
      }
    }
    logEvent(id, "manual_resolved", "marked resolved by user");
    finalize(id, "resolved");
  } catch (err: any) {
    logEvent(id, "error", err?.message ?? String(err));
    updateThread(id, { status: "error", error: err?.message ?? String(err) });
    emit({ type: "thread_updated", threadId: id });
  }
}

/**
 * Retry a thread after a transient failure, from its most durable artifact —
 * never by replaying a stored verdict DECISION (that is what re-escalated a
 * resolved thread before). The recovery ladder:
 *  - a frozen proposal exists → re-attempt applying it (apply-check + re-gate +
 *    push for code; gh pr edit for pr_body). Deterministic; never re-decides.
 *  - otherwise → fall back to a fresh re-run of the verdict pipeline.
 */
export async function retryThread(id: number): Promise<void> {
  const s = getThread(id);
  if (!s) throw new Error(`no thread #${id}`);
  if (!s.proposalJson) return rerunThread(id); // no frozen artifact → recompute
  // Reflect the click SYNCHRONOUSLY — before entering the serial queue (mirrors
  // approveThread/applyInstruction) — so a queued retry doesn't look dead while it
  // waits behind other in-flight repo work. Group-2 action: re-applies the frozen
  // proposal in a worktree, so it MUST stay on the queue.
  updateThread(id, { status: "in_progress", error: null });
  logEvent(id, "retry", "re-applying frozen proposal");
  emit({ type: "thread_updated", threadId: id });
  await applyFrozenProposal(id, s.owner, s.repo);
}

/**
 * Manually re-run a thread from scratch: reset it to pending (clearing any
 * blocked/resolved/error state) and re-run the full verdict pipeline. Used by
 * the "Fresh Rerun" button so a stored verdict can be regenerated on demand.
 */
export async function rerunThread(id: number): Promise<void> {
  const s = getThread(id);
  if (!s) throw new Error(`no thread #${id}`);
  updateThread(id, { status: "pending", error: null });
  logEvent(id, "rerun", "manual re-run requested");
  emit({ type: "thread_updated", threadId: id });
  await processThread(id);
}

function finalize(id: number, status: ThreadRow["status"]): void {
  updateThread(id, { status });
  // Drop any materialized CI log; harmless no-op for non-CI threads.
  if (status === "resolved" || status === "blocked" || status === "error") cleanupCiLog(id);
  logEvent(id, "finalized", status);
  emit({ type: "thread_updated", threadId: id });
}

/**
 * Recover threads left `in_progress` by a crash/restart, keyed on the most
 * durable ARTIFACT rather than on "a verdict exists" (replaying a stale verdict
 * decision is exactly what re-escalated an already-resolved thread). No agent run
 * survives the process, so each is re-driven from its last durable input — never
 * resumed mid-stream. The verdict step is read-only and `addWorktree` clears
 * stale residue, so nothing double-acts.
 *
 * Ladder (most specific first):
 *  - interrupted Approve → re-attempt applying the frozen proposal (deterministic).
 *  - interrupted instruction → re-apply it (re-propose); the directive isn't lost.
 *  - a frozen proposal exists → re-apply it (covers a kill before the approve
 *    event landed); deterministic, never re-decides.
 *  - else → re-run the verdict pipeline from `pending` (fresh decision).
 *
 * `awaiting_approval` threads are NOT recovered: their frozen proposal is the
 * durable truth, nothing is in flight, and the UI re-renders it on reconnect.
 */
export function recoverInterrupted(): void {
  for (const t of listThreads("in_progress")) {
    if (wasInterruptedApproving(t.id) && t.proposalJson) {
      logEvent(t.id, "recovered", "re-applying frozen proposal after interrupted approve");
      void retryThread(t.id);
      continue;
    }
    const instruction = interruptedInstruction(t.id);
    if (instruction) {
      logEvent(t.id, "recovered", "re-driving interrupted instruction after restart");
      void applyInstruction(t.id, instruction);
    } else if (t.proposalJson) {
      logEvent(t.id, "recovered", "re-applying frozen proposal after restart");
      void retryThread(t.id);
    } else {
      logEvent(t.id, "recovered", "re-queuing interrupted thread after restart");
      updateThread(t.id, { status: "pending", error: null });
      emit({ type: "thread_updated", threadId: t.id });
      void processThread(t.id);
    }
  }
}

/** Subscribe to new threads and drain any pending ones on startup. */
export function startProcessor(): void {
  // Resume anything left pending across a restart.
  for (const s of listThreads("pending")) void processThread(s.id);

  onEvent((ev) => {
    // thread_created → new unit; thread_updated → possibly a reopened (pending)
    // unit. processThread no-ops unless the thread is actually pending, so
    // reacting to both is safe and never double-processes in-progress work.
    if (ev.type === "thread_created" || ev.type === "thread_updated") {
      void processThread(ev.threadId);
    }
  });
}
