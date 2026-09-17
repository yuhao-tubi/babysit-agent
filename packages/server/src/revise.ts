/**
 * **Revision** — re-run the agent on a Proposal part the owner is looking at,
 * showing it its OWN current output plus a note about what to change ("also cover
 * the null case", "say we'll do this in a follow-up"). It is the third rung of a
 * ladder the dashboard already had two of:
 *
 *   1. **AI refine** (`refine.ts`) — one-shot direct rewrite of text in the
 *      instruction box. No agent, no checkout, nothing persisted.
 *   2. **Instruction** (`processor.applyInstruction`) — a full re-propose. The fix
 *      agent starts from the FEEDBACK again; the diff it already produced is not
 *      in the prompt, so "make it also handle X" can come back as a different fix.
 *   3. **Revision** (this file) — same machinery as (2) for a code change, but the
 *      current artifact is quoted into the prompt, so the agent improves what the
 *      owner just read instead of re-deciding from nothing.
 *
 * Two routes, because the two Proposal parts have different safety needs:
 *
 * - **change part, `code`/`manual_plan`** → composed into an ordinary Instruction
 *   (`buildReviseInstruction`) and run through `applyInstruction`. That keeps every
 *   existing guardrail intact: repo queue, fix→gate loop, size limit, and a re-park
 *   at `awaiting_approval` — a revision is unread bytes, so it NEVER pushes.
 * - **reply part, and the `pr_body` change part** → a read-only agent run here
 *   (`reviseText`). These are text, not a patch: there is nothing to gate, and
 *   re-running the code fix agent for them would be wrong (a description edit is
 *   not a code edit). Modeled on `explain.ts`: own worktree key namespace,
 *   `overviewQueue` so it never sits in front of an owner's Approve, own in-flight
 *   guard, SSE event. The result replaces only that ONE field of the frozen
 *   Proposal — it is still parked, and still needs the owner's Approve/Post.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentGuardHooks } from "./agent-guard.js";
import { isIgnoredRepo } from "./classify.js";
import { ARTIFACT_EFFORT, sdkEnv } from "./config.js";
import { getThread, getThreadItems, isPrExpired, logEvent, updateThread } from "./db.js";
import { emit } from "./events.js";
import { getPrBody, getPrHead } from "./gh.js";
import { applyInstruction } from "./processor.js";
import { overviewQueue } from "./queue.js";
import { isRunning } from "./running.js";
import { bodyDiff } from "./verdict.js";
import { addWorktree, removeWorktree } from "./worktrees.js";
import type { FeedbackItem, Proposal, ThreadRow } from "./types.js";

/** Which independently-approvable part of the Proposal is being revised. */
export type ProposalPart = "change" | "reply";

/** Filename the revise agent writes inside the worktree. Read back, then discarded. */
const REVISION_FILE = "revision.md";

/** Turn budget for a text revision — it reads to ground itself, then writes once. */
const REVISE_MAX_TURNS = 20;

/** How much of the current artifact to quote back into a prompt. */
const QUOTE_CHARS = 6000;

/**
 * Worktree key for a text Revision. A worktree lives at
 * `worktrees/<owner>__<repo>/<key>` and `addWorktree` WIPES that path before
 * checking out, so key namespaces are load-bearing (see `explainWorktreeKey`):
 *   -  positive `threadId`   → Thread pipeline (verdict / fix), on `repoQueue`
 *   -  `-pr.number`          → PR-level read-only artifacts (overview/risks/quiz)
 *   -  `-1_000_000 - id`     → per-Thread Explanations
 *   -  this range            → per-Thread text Revisions
 * A Revision runs on `overviewQueue`, concurrent with both `repoQueue` and an
 * Explanation on the same Thread, so it needs a range of its own.
 */
export function reviseWorktreeKey(threadId: number): number {
  return -3_000_000 - threadId;
}

function truncate(s: string): string {
  return s.length > QUOTE_CHARS ? `${s.slice(0, QUOTE_CHARS)}\n… (truncated)` : s;
}

/**
 * The Instruction that drives a CODE revision: quote the diff the owner is
 * looking at, then the note. Phrased as "improve this", not "start over" — the
 * whole point is that the owner accepted the shape of the fix and wants one thing
 * changed about it.
 *
 * Deliberately produces an ordinary freeform Instruction string rather than a new
 * code path: `execute` forces `action = "propose"` for any freeform instruction,
 * so the revision inherits the fix→gate loop and can never push (CONTEXT.md,
 * "Instruction"). It must therefore not begin with `ignore` or `reply:`, which
 * `execute` intercepts — it begins with "Revise".
 */
export function buildReviseInstruction(proposal: Proposal, note: string): string {
  const lines: string[] = [];
  const artifact = proposal.kind === "manual_plan" ? "implementation brief" : "fix";
  lines.push(
    `Revise the ${artifact} you already produced for this thread, per the note below. Keep everything about it that still holds and change only what the note asks for — do not re-decide the approach from scratch.`
  );
  lines.push("");
  lines.push("The owner's note on your current proposal:");
  lines.push("<<<NOTE");
  lines.push(note.trim());
  lines.push("NOTE");
  lines.push("");
  if (proposal.planMarkdown?.trim()) {
    lines.push("Your current plan:");
    lines.push(truncate(proposal.planMarkdown.trim()));
    lines.push("");
  }
  if (proposal.kind === "code" && proposal.diff?.trim()) {
    lines.push("Your current proposed change (NOT yet pushed — the owner reviewed it and asked for the above):");
    lines.push("```diff");
    lines.push(truncate(proposal.diff.trim()));
    lines.push("```");
    lines.push("");
    lines.push(
      "The checkout is at the branch head and does NOT contain that change — re-make it (as revised) from scratch in the working tree."
    );
  }
  return lines.join("\n");
}

const REPLY_REVISE_SYSTEM = `You revise a draft REPLY to code-review feedback, on a read-only checkout of the PR author's own branch.

The author has read your current draft and told you what to change about it. Apply their note. Keep everything else — the draft's stance, its technical claims, its structure — unless the note asks you to change it. You are improving a draft, not writing a new one.

GROUNDING IS MANDATORY. This text will be posted publicly on the PR under the author's name, so every technical claim in it must be true of the real code:
- Investigate with Read/Grep/Glob BEFORE writing whenever the note asks for something the draft does not already establish (a line number, a reason, "check whether we already do this").
- Use the REAL names in the checkout. Never invent a function, file or behaviour to make the reply tidier.
- If the note asks you to assert something the code does not support, do NOT assert it. Write the honest version and say plainly what you found instead.

VOICE. You are writing AS the PR author, to a reviewer. Concise and professional, no preamble, no sign-off, no "as an AI". GitHub-flavored markdown. Do not thank the reviewer more than once. Do not restate the reviewer's comment back at them.

OUTPUT. Write ONLY the reply text to a file named exactly "revision.md" in the current working directory (use the Write tool). No commentary about your changes, no "here is the revised reply" — the file's whole contents are posted verbatim.

Do NOT write any file other than revision.md. Do NOT modify the checkout.`;

const BODY_REVISE_SYSTEM = `You revise a proposed PULL REQUEST DESCRIPTION, on a read-only checkout of the PR author's own branch.

The author has read your current proposed description and told you what to change about it. Apply their note and keep the rest — you are improving a draft, not rewriting it.

GROUNDING IS MANDATORY. The description must describe the code that is actually on this branch:
- Investigate with Read/Grep/Glob (and \`git log\`/\`git diff\` against the base branch) before claiming what the PR does.
- Use the REAL names in the checkout. Never describe a change the branch does not contain.

OUTPUT. Write the COMPLETE new description — not a patch, not a diff — to a file named exactly "revision.md" in the current working directory (use the Write tool). Its whole contents become the PR description verbatim, so include every section that should survive. No commentary about your changes.

Do NOT write any file other than revision.md. Do NOT modify the checkout.`;

/**
 * Prompt for a text Revision. Leads with the CURRENT artifact and the note (the
 * task), then the thread's feedback as context — the reverse of the verdict
 * prompt's ordering, because here the decision is already made and the job is an
 * edit to a specific piece of text.
 */
export function buildRevisePrompt(o: {
  s: ThreadRow;
  items: FeedbackItem[];
  part: ProposalPart;
  current: string;
  note: string;
}): string {
  const label = o.part === "reply" ? "reply draft" : "PR description";
  const lines: string[] = [];
  lines.push(`PR: ${o.s.prKey}`);
  lines.push(`Thread: ${o.s.threadKey}  (author_class: ${o.s.authorClass})`);
  lines.push("");
  lines.push(`Your current ${label}:`);
  lines.push(`<<<CURRENT`);
  lines.push(o.current.trim() || "(empty)");
  lines.push("CURRENT");
  lines.push("");
  lines.push("The PR author's note on it — this is what to change:");
  lines.push("<<<NOTE");
  lines.push(o.note.trim());
  lines.push("NOTE");
  lines.push("");
  lines.push("Context — the review feedback this thread is about:");
  for (const it of o.items) {
    lines.push("---");
    lines.push(`author: ${it.author} (${it.authorType})  kind: ${it.kind}`);
    if (it.path) lines.push(`location: ${it.path}${it.line ? `:${it.line}` : ""}`);
    lines.push(`body:\n${it.body}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(
    `Investigate this checkout as far as the note requires, then write the revised ${label} to ${REVISION_FILE}.`
  );
  return lines.join("\n");
}

/**
 * Threads with a Revision in flight — the double-click guard, and what the
 * dashboard keys its "Revising…" label off. Covers BOTH routes: the code route
 * flips the Thread to `in_progress` like any Instruction, and without this the
 * card would caption that with the Approve path's "Re-checking & pushing…".
 */
const inFlight = new Set<number>();

/** Whether a Revision is executing for this Thread right now. */
export function isRevising(threadId: number): boolean {
  return inFlight.has(threadId);
}

/**
 * Fire-and-forget entry point for the dashboard's "Revise with agent" buttons.
 * Routes to the code path (an Instruction re-propose) or the text path per the
 * Proposal's kind — see the file header. Returns synchronously; the outcome
 * arrives over SSE.
 */
export function requestRevision(
  threadId: number,
  part: ProposalPart,
  note: string
): { ok: boolean; reason?: string } {
  if (!note.trim()) return { ok: false, reason: "note required" };
  const s = getThread(threadId);
  if (!s) return { ok: false, reason: "no such thread" };
  const proposal: Proposal | null = s.proposalJson ? JSON.parse(s.proposalJson) : null;
  if (!proposal) return { ok: false, reason: "no proposal to revise" };
  // Repo scope is re-checked in the pipeline, not just the poller (a guardrail),
  // and an expired PR's branch may be gone — `addWorktree` would fail after
  // burning an agent run.
  if (isIgnoredRepo(s.owner, s.repo)) return { ok: false, reason: "repo not in scope" };
  if (isPrExpired(s.prKey)) return { ok: false, reason: "PR is merged/closed" };
  // A settled part has nothing to revise: pushed/edited bytes and a posted comment
  // are on GitHub already, and a dismissed reply was deliberately dropped.
  if (part === "change" && proposal.changeApplied) {
    return { ok: false, reason: "the change was already applied" };
  }
  if (part === "reply") {
    if (proposal.replyPosted) return { ok: false, reason: "the reply was already posted" };
    if (proposal.replyDismissed) return { ok: false, reason: "the reply was dismissed" };
    if (!proposal.replyDraft?.trim()) return { ok: false, reason: "no reply draft to revise" };
  }
  // Both routes would race a pipeline job for this Thread — the code route on the
  // repo queue's own worktree, the text route by writing back a Proposal a
  // re-propose is about to replace. Refuse rather than interleave.
  if (isRunning(threadId) || inFlight.has(threadId)) {
    return { ok: false, reason: "already working on this thread" };
  }

  // ---- code / manual_plan change part → Instruction re-propose (repo queue) ----
  if (part === "change" && proposal.kind !== "pr_body") {
    if (proposal.kind === "reply") return { ok: false, reason: "this proposal has no change part" };
    inFlight.add(threadId);
    logEvent(threadId, "revision", `revising the ${proposal.kind} change: ${note.trim().slice(0, 300)}`);
    void applyInstruction(threadId, buildReviseInstruction(proposal, note))
      .catch(() => {
        // applyInstruction lands the Thread on `error` itself; nothing to add here
        // beyond not turning a rejected promise into an unhandled one.
      })
      .finally(() => {
        inFlight.delete(threadId);
        emit({ type: "thread_updated", threadId });
      });
    return { ok: true };
  }

  // ---- reply part, or a pr_body change part → read-only text revision ----
  inFlight.add(threadId);
  logEvent(threadId, "revision", `revising the ${part}: ${note.trim().slice(0, 300)}`);
  emit({ type: "thread_updated", threadId });
  void overviewQueue.run(`${s.owner}/${s.repo}`, async () => {
    try {
      const changed = await reviseText(threadId, part, note);
      logEvent(threadId, "revision", changed ? "revised draft ready for review" : "no revised text produced");
    } catch (err: any) {
      // Never crash the daemon, and never move the Thread to `error`: the frozen
      // Proposal is untouched and still approvable, so a failed revision is a
      // no-op the owner can retry.
      logEvent(threadId, "revision", `failed: ${err?.message ?? err}`);
    } finally {
      inFlight.delete(threadId);
      emit({ type: "thread_updated", threadId });
    }
  });
  return { ok: true };
}

/**
 * Run the text revise agent and patch the ONE field it owns onto the frozen
 * Proposal. Provisions its own read-only worktree with `skipDeps` (Read/Grep/Glob
 * only — it never builds or tests), torn down in `finally`.
 *
 * The Proposal is re-read from the db AFTER the agent finishes and patched
 * field-wise, never overwritten wholesale: `overviewQueue` runs concurrently with
 * the pipeline, so a re-propose may have replaced the parked Proposal while the
 * agent was thinking. Patching the live row means the worst case is a fresher
 * change part beside our revised reply — not a stale diff resurrected over it.
 *
 * Returns whether anything was written.
 */
export async function reviseText(
  threadId: number,
  part: ProposalPart,
  note: string
): Promise<boolean> {
  const s = getThread(threadId);
  if (!s) throw new Error(`no thread #${threadId}`);
  const before: Proposal | null = s.proposalJson ? JSON.parse(s.proposalJson) : null;
  if (!before) throw new Error("no proposal to revise");
  const current = (part === "reply" ? before.replyDraft : before.proposedBody) ?? "";

  const head = await getPrHead(s.owner, s.repo, s.number);
  const { env, modelArn } = await sdkEnv();
  const wtKey = reviseWorktreeKey(threadId);
  const { dir } = await addWorktree(s.owner, s.repo, head.headRefName, wtKey, {
    skipDeps: true,
  });
  try {
    for await (const msg of query({
      prompt: buildRevisePrompt({ s, items: getThreadItems(threadId), part, current, note }),
      options: {
        cwd: dir,
        model: modelArn,
        systemPrompt: part === "reply" ? REPLY_REVISE_SYSTEM : BODY_REVISE_SYSTEM,
        permissionMode: "dontAsk",
        // Same read-only set as the other artifact agents. `Bash` is for grounding
        // (`git log` / `git diff` against the base branch); `Write` is for
        // revision.md. Nothing here reaches GitHub — the worktree is a throwaway
        // and this module has no push/comment path.
        allowedTools: ["Read", "Grep", "Glob", "Bash", "Write"],
        effort: ARTIFACT_EFFORT,
        ...agentGuardHooks(dir),
        settingSources: [],
        env,
        maxTurns: REVISE_MAX_TURNS,
        stderr: () => {},
      },
    })) {
      void msg;
    }

    const path = join(dir, REVISION_FILE);
    const text = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    // No file or an empty one → keep what the owner already has. A blank reply or
    // a blank PR description is strictly worse than the draft it replaced.
    if (!text) return false;

    const live = getThread(threadId);
    const fresh: Proposal | null = live?.proposalJson ? JSON.parse(live.proposalJson) : null;
    if (!fresh) return false;
    if (part === "reply") {
      // Re-check the settled flags on the LIVE row: the owner may have posted or
      // dismissed the reply while the agent ran, and either way our text is moot.
      if (fresh.replyPosted || fresh.replyDismissed) return false;
      updateThread(threadId, { proposal: { ...fresh, replyDraft: text } });
    } else {
      if (fresh.kind !== "pr_body" || fresh.changeApplied) return false;
      // Re-diff against the CURRENT description, not the one snapshotted when the
      // proposal was first drafted — the owner may have edited it on GitHub since,
      // and the card shows this diff as "what Approve will do".
      const baseBody = await getPrBody(s.owner, s.repo, s.number).catch(() => fresh.baseBody ?? "");
      updateThread(threadId, {
        proposal: {
          ...fresh,
          proposedBody: text,
          baseBody,
          bodyDiff: bodyDiff(baseBody, text),
        },
      });
    }
    emit({ type: "thread_updated", threadId });
    return true;
  } finally {
    await removeWorktree(s.owner, s.repo, wtKey).catch(() => {});
  }
}
