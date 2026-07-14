import { loadConfig } from "./config.js";
import {
  collectFeedback,
  compareCommits,
  getPrHead,
  listAuthoredPrs,
  listReviewRequestedPrs,
} from "./gh.js";
import {
  classifyAuthor,
  isCiEnabledRepo,
  isIgnoredAuthor,
  isIgnoredRepo,
  isOwnAuthor,
} from "./classify.js";
import type { FeedbackItem } from "./types.js";
import { cleanupCiLog } from "./ci.js";
import {
  createThread,
  getThreadByKey,
  hasSeenFeedback,
  listWaitingThreads,
  logEvent,
  pruneClosedPrs,
  recordFeedback,
  setThreadItems,
  threadAttemptCount,
  updateThread,
  upsertPr,
} from "./db.js";
import type { ThreadGroup } from "./gh.js";
import { emit } from "./events.js";

export interface PollResult {
  prsChecked: number;
  newThreads: number[];
}

function reviewIdOf(threadKey: string): number | null {
  const m = threadKey.match(/^review:(\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * One poll cycle: discover PRs, group feedback by thread, and upsert a
 * thread-unit per thread that has actionable, non-resolved, non-own feedback.
 * Idempotent — unit existence is derived from live GitHub state each poll.
 */
export async function pollOnce(): Promise<PollResult> {
  const cfg = loadConfig();
  const prs = await listAuthoredPrs();
  const newThreads: number[] = [];
  let checked = 0;

  // Review-requested PRs are OVERVIEW-ONLY: we show them so you can generate an
  // overview/diagram, but they never enter the verdict/gate/push pipeline (that
  // assumes it's your branch). Feature-gated on the overview switch. A PR you
  // both authored and are requested on stays "author" (authored set wins).
  const authoredKeys = new Set(prs.map((p) => `${p.owner}/${p.repo}#${p.number}`));
  const reviewerPrs = cfg.overview.enabled ? await listReviewRequestedPrs() : [];

  // The watch list observes open PRs only: mark EXPIRED any stored PR
  // (merged/closed since last poll) that's no longer in the live open set — it's
  // retained as read-only history, not deleted. Built from every authored-open
  // AND review-requested PR — including ignored repos — so repo scope alone never
  // expires a still-open PR.
  pruneClosedPrs([
    ...authoredKeys,
    ...reviewerPrs.map((p) => `${p.owner}/${p.repo}#${p.number}`),
  ]);

  // Upsert review-requested PRs (role-only; no feedback fetch, no threads).
  for (const pr of reviewerPrs) {
    const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
    if (isIgnoredRepo(pr.owner, pr.repo)) continue;
    if (authoredKeys.has(prKey)) continue; // authored set wins
    try {
      const head = await getPrHead(pr.owner, pr.repo, pr.number);
      upsertPr({
        prKey,
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        headRef: head.headRefName,
        headSha: head.headSha,
        role: "reviewer",
      });
    } catch (err: any) {
      logEvent(null, "poll_error", `${prKey} (reviewer): ${err?.message ?? err}`);
    }
  }

  for (const pr of prs) {
    if (isIgnoredRepo(pr.owner, pr.repo)) continue;
    checked++;
    const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
    try {
      const head = await getPrHead(pr.owner, pr.repo, pr.number);
      upsertPr({
        prKey,
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        headRef: head.headRefName,
        headSha: head.headSha,
      });

      const fb = await collectFeedback(pr.owner, pr.repo, pr.number, {
        ci: isCiEnabledRepo(pr.owner, pr.repo),
      });

      for (const group of fb.threads.values()) {
        const isCi = group.items[0]?.kind === "ci_failure";
        // Skip your own threads (never for CI — its synthetic author isn't you)
        // and any GitHub-resolved thread (never act on resolved).
        if (!isCi && isOwnAuthor(group.rootAuthor)) continue;
        if (fb.resolvedThreadKeys.has(group.threadKey)) continue;

        // Ignored authors (e.g. tubi-laborador, github-actions): never triage —
        // resolve directly, no Verdict. CI is exempt (its synthetic author is
        // classed separately via the CI pipeline).
        if (!isCi && isIgnoredAuthor(group.rootAuthor)) {
          resolveIgnoredAuthor(prKey, pr, group);
          continue;
        }

        const id = upsertThread(prKey, pr, group, cfg.maxThreadAttempts);
        if (id) newThreads.push(id);
      }

      // Sync Threads a human resolved/fixed out-of-band. `resolvedThreadKeys`
      // folds both signals: a review thread marked resolved on GitHub, and a
      // once-failing babysat CI check now passing/neutral on the current head
      // (the latter carries no group above, so it must be reconciled here, not
      // in the group loop). pending / in_progress are already rechecked by the
      // processor before it acts, and resolved is terminal — so only a stale
      // blocked / error Thread needs flipping to resolved.
      for (const threadKey of fb.resolvedThreadKeys) {
        reconcileResolved(prKey, threadKey);
      }

      // A branch push can't re-open a waiting Thread (blocked stays frozen), but
      // the owner may have landed the fix by hand. Annotate any waiting Thread
      // with the commits pushed since it stalled so that's visible under Feedback.
      await annotateBranchAdvances(pr.owner, pr.repo, prKey, head.headSha);
    } catch (err: any) {
      logEvent(null, "poll_error", `${prKey}: ${err?.message ?? err}`);
    }
  }

  emit({ type: "poll", prsChecked: checked, newThreads });
  return { prsChecked: checked, newThreads };
}

/**
 * Reconcile a Thread whose underlying feedback is now resolved on GitHub but
 * which we left in a terminal-but-stale local state (blocked after an escalation,
 * or error). A human who resolves the review thread or fixes/greens the CI check
 * out-of-band should see the Thread fall out of "needs you" without an explicit
 * Instruction. No-op when there's no such Thread (the common case).
 */
function reconcileResolved(prKey: string, threadKey: string): void {
  const existing = getThreadByKey(prKey, threadKey);
  if (!existing) return;
  if (
    existing.status !== "blocked" &&
    existing.status !== "error" &&
    existing.status !== "awaiting_approval"
  )
    return;
  // Resolved out-of-band → drop any parked proposal too (no longer relevant).
  updateThread(existing.id, { status: "resolved", error: null, proposal: null });
  cleanupCiLog(existing.id);
  logEvent(existing.id, "reconciled_resolved", `${threadKey} resolved on GitHub out-of-band`);
  emit({ type: "thread_updated", threadId: existing.id });
}

/**
 * For each WAITING Thread on this PR (`blocked` / `awaiting_approval` / `error`),
 * detect commits pushed to the branch after the Thread stalled and record them as
 * a "branch advanced" annotation. It never changes the Thread's status — a push
 * doesn't re-open a frozen Thread; it only surfaces that a fix may have landed so
 * the owner can resolve it. The base is snapshotted the first poll a Thread is
 * seen waiting (no commits shown until the head actually moves past it); the
 * annotation is cleared by `updateThread` the moment the Thread is re-worked.
 */
async function annotateBranchAdvances(
  owner: string,
  repo: string,
  prKey: string,
  currentHead: string
): Promise<void> {
  if (!currentHead) return;
  const waiting = listWaitingThreads(prKey);
  if (!waiting.length) return;

  for (const t of waiting) {
    const prev: { base?: string } = t.newCommitsJson ? JSON.parse(t.newCommitsJson) : {};
    // First sighting in a waiting state → snapshot the base; nothing to show yet.
    if (!prev.base) {
      updateThread(t.id, { newCommits: { base: currentHead, head: currentHead, commits: [] } });
      continue;
    }
    if (prev.base === currentHead) continue; // branch hasn't moved
    try {
      const commits = await compareCommits(owner, repo, prev.base, currentHead);
      updateThread(t.id, { newCommits: { base: prev.base, head: currentHead, commits } });
      if (commits.length) {
        // Surface the advance via the dedicated "new commits" panel (driven by
        // `newCommits`), NOT a timeline event: every poll re-detects the same
        // advance until the thread clears, so logging it spammed the Activity
        // timeline with duplicate `branch_advanced` entries.
        emit({ type: "thread_updated", threadId: t.id });
      }
    } catch (err: any) {
      logEvent(t.id, "poll_error", `branch-advance check: ${err?.message ?? err}`);
    }
  }
}

/**
 * Handle a thread group whose root author is on `ignoreAuthors`: it is never
 * triaged. We still record its feedback (so it isn't re-seen as "new activity"
 * later) and, if a Thread already exists for it, resolve that Thread directly —
 * dropping any parked proposal. No Verdict, no notification. Idempotent: a group
 * with no pre-existing Thread just gets its items recorded.
 */
function resolveIgnoredAuthor(
  prKey: string,
  pr: { owner: string; repo: string; number: number },
  group: ThreadGroup
): void {
  const reviewId = reviewIdOf(group.threadKey);
  for (const it of group.items) recordFeedback(prKey, it, reviewId);
  const existing = getThreadByKey(prKey, group.threadKey);
  if (!existing || existing.status === "resolved") return;
  updateThread(existing.id, { status: "resolved", error: null, proposal: null });
  cleanupCiLog(existing.id);
  logEvent(existing.id, "skipped_author", `${group.rootAuthor} on ignoreAuthors; resolved without verdict`);
  emit({ type: "thread_updated", threadId: existing.id });
}

/**
 * Create or re-open a thread-unit for a thread group. Returns the thread id if
 * it became (re-)actionable this poll, else null. Lifecycle per design Q11.
 */
function upsertThread(
  prKey: string,
  pr: { owner: string; repo: string; number: number },
  group: ThreadGroup,
  maxThreadAttempts: number
): number | null {
  const reviewId = reviewIdOf(group.threadKey);
  // CI groups carry a synthetic author; class them "ci" rather than via the
  // user-based classifier (decision Q16).
  const authorClass =
    group.items[0]?.kind === "ci_failure"
      ? "ci"
      : classifyAuthor(group.rootAuthor, group.rootAuthorType);

  // Any item we haven't recorded yet signals new activity — but NOT items we
  // authored ourselves. The agent acts as the PR owner (`@me`), so its ack
  // replies (and the owner's own comments) carry our login; counting them as
  // "new activity" is what re-opened a just-resolved thread and re-escalated it.
  // Only a reviewer/bot saying something new should re-open. CI groups carry a
  // synthetic author that is never us, so they're unaffected (decision Q16).
  const isSelf = (it: FeedbackItem) => authorClass !== "ci" && isOwnAuthor(it.author);
  const hasNewActivity = group.items.some((it) => !hasSeenFeedback(it.ghId) && !isSelf(it));
  for (const it of group.items) recordFeedback(prKey, it, reviewId);

  const existing = getThreadByKey(prKey, group.threadKey);
  if (!existing) {
    const id = createThread({
      prKey,
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      reviewId,
      threadKey: group.threadKey,
      authorClass,
      itemGhIds: group.items.map((i) => i.ghId),
    });
    logEvent(id, "thread_created", `${prKey} ${authorClass} ${group.threadKey} (${group.items.length} item(s))`);
    emit({ type: "thread_created", threadId: id });
    return id;
  }

  // Keep the item set current regardless of status (new replies attach).
  setThreadItems(existing.id, group.items.map((i) => i.ghId));

  if (!hasNewActivity) return null;

  // New activity on an existing unit. blocked / pending / in_progress /
  // awaiting_approval: leave as-is (a parked proposal stays frozen until the
  // owner acts). Only a terminal resolved / error thread re-opens.
  if (existing.status === "resolved" || existing.status === "error") {
    // Loop-guard: too many auto-push attempts on this thread → escalate instead.
    if (threadAttemptCount(prKey, group.threadKey) >= maxThreadAttempts) {
      updateThread(existing.id, { status: "blocked" });
      logEvent(existing.id, "loop_guard", `>= ${maxThreadAttempts} attempts on thread; escalating on re-open`);
      emit({ type: "thread_updated", threadId: existing.id });
      return null;
    }
    updateThread(existing.id, { status: "pending", error: null });
    logEvent(existing.id, "reopened", `new activity on ${group.threadKey}`);
    emit({ type: "thread_updated", threadId: existing.id });
    return existing.id;
  }

  return null;
}

/** Background loop. */
export function startPoller(onCycle?: (r: PollResult) => void): NodeJS.Timeout {
  const cfg = loadConfig();
  const tick = async () => {
    try {
      const r = await pollOnce();
      console.log(
        `[poll] checked ${r.prsChecked} PRs, ${r.newThreads.length} new/reopened thread(s)`
      );
      onCycle?.(r);
    } catch (err: any) {
      console.error("[poll] cycle failed:", err?.message ?? err);
    }
  };
  void tick();
  return setInterval(tick, cfg.pollIntervalMs);
}
