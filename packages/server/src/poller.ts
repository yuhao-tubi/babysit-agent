import { loadConfig } from "./config.js";
import { collectFeedback, getPrHead, listAuthoredPrs } from "./gh.js";
import { classifyAuthor, isIgnoredRepo, isOwnAuthor } from "./classify.js";
import {
  createThread,
  getThreadByKey,
  hasSeenFeedback,
  logEvent,
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
      });

      const fb = await collectFeedback(pr.owner, pr.repo, pr.number);

      for (const group of fb.threads.values()) {
        // Skip your own threads and any GitHub-resolved thread (never act on resolved).
        if (isOwnAuthor(group.rootAuthor)) continue;
        if (fb.resolvedThreadKeys.has(group.threadKey)) continue;

        const id = upsertThread(prKey, pr, group, cfg.maxThreadAttempts);
        if (id) newThreads.push(id);
      }
    } catch (err: any) {
      logEvent(null, "poll_error", `${prKey}: ${err?.message ?? err}`);
    }
  }

  emit({ type: "poll", prsChecked: checked, newThreads });
  return { prsChecked: checked, newThreads };
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
  const authorClass = classifyAuthor(group.rootAuthor, group.rootAuthorType);

  // Any item we haven't recorded yet signals new activity on the thread.
  const hasNewActivity = group.items.some((it) => !hasSeenFeedback(it.ghId));
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

  // New activity on an existing unit. blocked / pending / in_progress: leave as-is.
  if (existing.status === "resolved" || existing.status === "error") {
    // Loop-guard: too many auto-fix attempts on this thread → escalate instead.
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
