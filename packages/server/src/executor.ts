import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, sdkEnv } from "./config.js";
import {
  addWorktree,
  removeWorktree,
  gitDiff,
  commitAll,
  headSha,
  remoteHeadSha,
  pushFastForward,
  applyPatch,
  applyPatchCheck,
} from "./worktrees.js";
import { runGate } from "./gate.js";
import {
  postIssueComment,
  replyToReviewComment,
  getPrHead,
  getPrBody,
  updatePrBody,
} from "./gh.js";
import { getThreadItems, logEvent, updateThread } from "./db.js";
import { notifyEscalation } from "./notify.js";
import { emit } from "./events.js";
import { materializeCiLog } from "./ci.js";
import type { FeedbackItem, Proposal, ThreadRow, Verdict } from "./types.js";

/** Whether this thread's class may push without owner approval (and not high-risk). */
function mayAutoPush(s: ThreadRow, verdict: Verdict): boolean {
  const cfg = loadConfig();
  if (verdict.risk === "high") return false; // risk:high always vetoes auto-push
  return cfg.autoPushClasses.includes(s.authorClass);
}

const FIX_SYSTEM = `You are fixing code-review feedback on a checkout of a PR branch. Make ONLY the change the feedback requests — do not refactor surrounding code. Use Edit/Write to change files. Do NOT commit, push, or run git; the harness handles that. When done, briefly state what you changed.`;

/** Pick a feedback item suitable for posting a reply against (inline thread root). */
function replyTarget(items: FeedbackItem[]): FeedbackItem | undefined {
  return items.find((i) => i.kind === "review_comment") ?? items[0];
}

// ---- Two-part proposal progress -------------------------------------------
// A parked Proposal carries up to two independently-approvable parts: a CHANGE
// (code diff or PR-description rewrite) and a REPLY. Each is approved on its own;
// the Thread only resolves once both are done (applied/posted or dismissed/absent).

/** True if the proposal has a change part that hasn't been applied yet. */
function changePending(p: Proposal): boolean {
  if (p.kind === "code" || p.kind === "pr_body") return !p.changeApplied;
  return false; // `reply` / `manual_plan` carry no pushable change part
}

/** True if the proposal has a drafted reply that's neither posted nor dismissed. */
function replyPending(p: Proposal): boolean {
  return !!p.replyDraft?.trim() && !p.replyPosted && !p.replyDismissed;
}

/**
 * Persist a mutated Proposal and derive the Thread's status from what's left:
 * `resolved` when neither part is pending, else `awaiting_approval`. Clears the
 * frozen proposal on resolve. Returns the new status.
 */
function settleProposal(s: ThreadRow, p: Proposal): ThreadRow["status"] {
  const done = !changePending(p) && !replyPending(p);
  updateThread(s.id, { proposal: done ? null : p });
  emit({ type: "thread_updated", threadId: s.id });
  return done ? "resolved" : "awaiting_approval";
}

export async function postReply(
  s: ThreadRow,
  items: FeedbackItem[],
  body: string
): Promise<void> {
  const target = replyTarget(items);
  if (target && target.kind === "review_comment") {
    await replyToReviewComment(s.owner, s.repo, s.number, target.ghId, body);
  } else {
    // Review summaries / issue comments → top-level issue comment.
    await postIssueComment(s.owner, s.repo, s.number, body);
  }
}

/**
 * Execute a thread's verdict (or a user instruction). Code changes are NEVER
 * pushed from here unless the thread's author class is in `autoPushClasses` (and
 * the change isn't high-risk) — otherwise a gate-verified proposal is built and
 * the thread parks at `awaiting_approval` for the owner to Approve. Honors
 * dryRun. Returns the new status.
 */
export async function execute(
  s: ThreadRow,
  verdict: Verdict,
  opts: { instruction?: string } = {}
): Promise<ThreadRow["status"]> {
  const cfg = loadConfig();
  const items = getThreadItems(s.id);

  // Resolve effective action: a user instruction can override the verdict.
  // Per the approval design, a freeform instruction ALWAYS re-proposes (it never
  // pushes directly — only Approve pushes). Only the non-code verbs short-circuit.
  let action = verdict.action;
  let replyBody = verdict.reply_draft;
  let instruction = opts.instruction?.trim() || undefined;
  if (instruction) {
    if (/^ignore\b/i.test(instruction)) {
      logEvent(s.id, "instruction", "ignored by user");
      return "resolved";
    }
    const replyMatch = instruction.match(/^reply:\s*([\s\S]+)/i);
    if (replyMatch) {
      // `reply:` => park this text as a reply Proposal to review and Post (the
      // owner composes/refines the text in the instruction box, optionally with
      // the AI-refine helper — we don't run an agent here). It still goes through
      // Approve, not posted directly; verbatim immediate posting is the "Reply on
      // GitHub" button.
      action = "reply";
      replyBody = replyMatch[1].trim();
      instruction = undefined;
    } else {
      action = "propose"; // freeform => re-propose (build a fresh proposal)
    }
  }

  // ---- amend_pr_body ----
  // A PR-description proposal: drafted, parked at awaiting_approval, and applied
  // only on Approve (never autonomously). It carries no code diff, so there is
  // no gate to run — we park it directly with the proposed body.
  if (action === "amend_pr_body") {
    if (!verdict.proposed_body?.trim()) {
      logEvent(s.id, "amend_noop", "no proposed_body to propose — escalating");
      notifyEscalation(s.id, s.prKey, "description amendment had no proposed text; needs review");
      return "blocked";
    }
    const baseBody = await getPrBody(s.owner, s.repo, s.number).catch(() => "");
    const proposal: Proposal = {
      kind: "pr_body",
      planMarkdown: verdict.summary || "Proposed PR-description edit.",
      baseSha: "",
      gatePassed: true, // no build gate applies to a description edit
      proposedBody: verdict.proposed_body,
      bodyDiff: verdict.body_diff,
      baseBody,
      replyDraft: replyBody || "Updated the PR description to address this.",
    };
    updateThread(s.id, { proposal });
    logEvent(s.id, "proposed", "PR-description amendment drafted; awaiting approval");
    if (verdict.risk === "high") notifyEscalation(s.id, s.prKey, verdict.summary || "high-risk description edit; review");
    emit({ type: "thread_updated", threadId: s.id });
    return "awaiting_approval";
  }

  // ---- reply ----
  // A reply is a Proposal too: it is parked at awaiting_approval and posted to
  // GitHub only on the owner's Approve (never autonomously). This keeps Approve
  // the sole write path for replies just as it is for code/description.
  if (action === "reply") {
    if (!replyBody?.trim()) {
      logEvent(s.id, "reply_noop", "no reply text to propose — escalating");
      notifyEscalation(s.id, s.prKey, "reply had no text; needs review");
      return "blocked";
    }
    const proposal: Proposal = {
      kind: "reply",
      planMarkdown: verdict.summary || "Proposed reply.",
      baseSha: "",
      gatePassed: true, // no build gate applies to a reply
      replyDraft: replyBody,
    };
    updateThread(s.id, { proposal, diff: null });
    logEvent(s.id, "proposed", "reply drafted; awaiting approval");
    emit({ type: "thread_updated", threadId: s.id });
    return "awaiting_approval";
  }

  // ---- escalate (decision needed; no diff to approve) ----
  if (action === "escalate") {
    notifyEscalation(s.id, s.prKey, verdict.summary || "needs your input");
    logEvent(s.id, "escalated", verdict.summary);
    return "blocked";
  }

  // ---- propose (code) ----
  return proposeCode(s, verdict, items, instruction);
}

/**
 * Build a gate-verified code proposal in a throwaway worktree, then either
 * auto-push it (when the thread's class is in `autoPushClasses` and it isn't
 * high-risk) or freeze it and park at `awaiting_approval`. The worktree is always
 * torn down in `finally`; the frozen diff + baseSha survive in `proposal_json`.
 */
async function proposeCode(
  s: ThreadRow,
  verdict: Verdict,
  items: FeedbackItem[],
  instruction?: string
): Promise<ThreadRow["status"]> {
  const cfg = loadConfig();
  const isCi = s.authorClass === "ci";
  const ciClass = items.find((i) => i.ciClass)?.ciClass;
  // For a CI fix, re-materialize the failing log (current head) so the fix agent
  // grounds on the raw error. Written OUTSIDE the worktree → never committed.
  const ciLogPath = isCi ? await materializeCiLog(s) : null;

  const head = await getPrHead(s.owner, s.repo, s.number);
  const { dir, remoteSha } = await addWorktree(s.owner, s.repo, head.headRefName, s.id);
  const baseSha = remoteSha;
  try {
    // Fix→gate loop. The agent makes the change, then the gate runs; if the
    // gate fails ONLY because of files the agent touched, re-run the agent with
    // the gate output to repair, bounded by maxGateFixAttempts. Gate failures in
    // files the agent didn't touch (pre-existing/environmental) escalate as-is.
    // For CI threads the failing check IS the target, so we skip the relatedness
    // guard and retry on any gate failure (decision Q21).
    let fixSummary = "";
    let diff = "";
    let gateFixAttempt = 0;
    let prompt = isCi
      ? buildCiFixPrompt(s, ciLogPath, verdict, instruction)
      : buildFixPrompt(s, items, instruction);

    for (;;) {
      try {
        fixSummary = await runFixAgent(dir, prompt);
      } catch (err: any) {
        // Turn-budget exhausted: the change is too large to apply autonomously.
        // Don't error out — pivot to a read-only planning pass that emits a
        // self-contained handoff the owner can paste into Claude Code by hand,
        // park it as a `manual_plan` proposal, and block on it.
        if (isMaxTurnsError(err)) {
          logEvent(s.id, "fix_too_large", "fix exceeded turn budget; generating a manual plan");
          return await proposeManualPlan(s, verdict, items, dir, instruction);
        }
        throw err;
      }

      diff = await gitDiff(dir);
      if (!diff.trim()) {
        logEvent(s.id, "fix_noop", "agent made no changes — escalating");
        notifyEscalation(s.id, s.prKey, "proposal produced no changes; needs review");
        return "blocked";
      }

      // Pre-push gate. For CI fixes the gate runs the failing check's class
      // (build / unit test) in addition to the typecheck+lint floor (Q9b/Q22).
      const gate = await runGate(dir, s.repo, isCi ? { ciClass, testTarget: verdict.ci_test_target } : {});
      logEvent(s.id, "gate", gate.detail.slice(0, 1000));
      if (gate.ran && gate.passed) break;

      // Gate couldn't run at all — can't self-verify.
      if (!gate.ran) {
        notifyEscalation(s.id, s.prKey, "no check to self-verify; needs review");
        return "blocked";
      }

      // Gate failed. For CI, the failing check is the target — retry on any
      // failure (skip the relatedness guard). For comment fixes, only retry if
      // the failure references files the agent changed.
      const changed = changedFiles(diff);
      if (!isCi && !gateMentionsChangedFiles(gate.detail, changed)) {
        logEvent(s.id, "gate_unrelated", "gate errors are in files the fix didn't touch; escalating");
        notifyEscalation(s.id, s.prKey, "proposal failed checks (pre-existing/unrelated errors); needs review");
        return "blocked";
      }
      if (gateFixAttempt >= cfg.maxGateFixAttempts) {
        logEvent(s.id, "gate_fix_exhausted", `>= ${cfg.maxGateFixAttempts} gate-fix attempts; escalating`);
        notifyEscalation(s.id, s.prKey, "proposal still failing checks after repair attempts; needs review");
        return "blocked";
      }
      gateFixAttempt += 1;
      logEvent(s.id, "gate_fix_retry", `attempt ${gateFixAttempt}/${cfg.maxGateFixAttempts}`);
      prompt = buildGateFixPrompt(gate.detail, changed);
    }

    // Gate passed. Either auto-push (scoped classes) or freeze + park.
    if (mayAutoPush(s, verdict)) {
      return await pushVerifiedDiff(s, verdict, items, head.headRefName, baseSha, dir, diff, fixSummary, isCi);
    }

    // Park: freeze the gate-passed diff for the owner to Approve. Writes nothing
    // to GitHub, so dryRun is irrelevant here — the push happens only on Approve.
    const proposal: Proposal = {
      kind: "code",
      planMarkdown: verdict.summary || fixSummary || "Proposed code change.",
      baseSha,
      gatePassed: true,
      diff,
      replyDraft: verdict.reply_draft || fixSummary || "",
    };
    updateThread(s.id, { proposal, diff: null });
    logEvent(s.id, "proposed", `gate-passed proposal ready; awaiting approval (base ${baseSha.slice(0, 7)})`);
    if (verdict.risk === "high") notifyEscalation(s.id, s.prKey, verdict.summary || "high-risk change; review the proposal");
    emit({ type: "thread_updated", threadId: s.id });
    return "awaiting_approval";
  } finally {
    await removeWorktree(s.owner, s.repo, s.id).catch(() => {});
  }
}

/**
 * Commit + fast-forward push a gate-verified diff from an open worktree (the
 * auto-push path for classes in `autoPushClasses`). Honors dryRun and the
 * branch-moved safety check. Returns the resulting status.
 */
async function pushVerifiedDiff(
  s: ThreadRow,
  verdict: Verdict,
  items: FeedbackItem[],
  headRef: string,
  baseSha: string,
  dir: string,
  diff: string,
  fixSummary: string,
  isCi: boolean
): Promise<ThreadRow["status"]> {
  const cfg = loadConfig();
  if (cfg.dryRun) {
    logEvent(s.id, "dry_run", `gate passed; would commit+push.\n${diff.slice(0, 1000)}`);
    updateThread(s.id, { diff });
    return "resolved";
  }

  // Branch-safety: only push if remote hasn't advanced past our base.
  const currentRemote = await remoteHeadSha(dir, headRef);
  if (currentRemote !== baseSha) {
    logEvent(s.id, "branch_moved", `remote advanced ${baseSha.slice(0, 7)}->${currentRemote.slice(0, 7)}; aborting push`);
    notifyEscalation(s.id, s.prKey, "branch advanced during fix; needs rebase/your call");
    return "blocked";
  }

  const commitMsg = isCi
    ? `[CI] ${verdict.summary || "fix failing check"}`
    : `[PR Feedback] ${verdict.summary || "address review comment"}`;
  await commitAll(dir, commitMsg);
  await pushFastForward(dir, headRef);
  const pushed = await headSha(dir);
  updateThread(s.id, { diff });
  logEvent(s.id, "pushed", `pushed ${pushed.slice(0, 7)} to ${headRef}`);

  // CI fixes push SILENTLY — the green check is the acknowledgement, no PR
  // comment (decision Q10). Comment threads get an ack reply.
  if (!isCi) {
    const ack = verdict.reply_draft || `Addressed in ${pushed.slice(0, 7)}. ${fixSummary}`;
    await postReply(s, items, ack);
    logEvent(s.id, "replied", ack);
  }

  updateThread(s.id, { attemptCount: s.attemptCount + 1 });
  emit({ type: "thread_updated", threadId: s.id });
  return "resolved";
}

/**
 * Approve and apply a proposal's CHANGE part — the SOLE push path. Posts NO
 * reply: the drafted reply is a separate, independently-approvable part (see
 * `postReplyProposal`). For a `code` proposal: re-fetch HEAD, verify the frozen
 * diff still applies (apply-check), re-run the gate against current HEAD, then
 * fast-forward push the EXACT frozen bytes (WYSIWYG). For a `pr_body` proposal:
 * `gh pr edit --body`. A `reply`-only proposal has no change part — approving it
 * just posts the reply. After applying, the Thread resolves only if no reply part
 * is still pending; otherwise it stays at `awaiting_approval` for the reply.
 * Any safety check failing moves the thread to `blocked`. Honors dryRun.
 */
export async function approveProposal(s: ThreadRow): Promise<ThreadRow["status"]> {
  const cfg = loadConfig();
  if (!s.proposalJson) {
    logEvent(s.id, "approve_noop", "no proposal to approve");
    return s.status;
  }
  const proposal: Proposal = JSON.parse(s.proposalJson);
  const items = getThreadItems(s.id);

  // ---- manual_plan: never pushed by the daemon; it is a copy-paste handoff. ----
  if (proposal.kind === "manual_plan") {
    logEvent(s.id, "approve_noop", "manual plan is run by the owner in Claude Code, not pushed");
    return "blocked";
  }

  // ---- reply: no change part — approving the proposal posts the reply. ----
  if (proposal.kind === "reply") {
    return postReplyProposal(s);
  }

  // Change already applied (e.g. owner clicked twice) — nothing more to push.
  if (proposal.changeApplied) {
    logEvent(s.id, "approve_noop", "change already applied");
    return settleProposal(s, proposal);
  }

  // ---- pr_body: no patch/gate; just update the description ----
  if (proposal.kind === "pr_body") {
    if (!proposal.proposedBody?.trim()) {
      logEvent(s.id, "approve_noop", "pr_body proposal had no text");
      return "blocked";
    }
    if (cfg.dryRun) {
      logEvent(s.id, "dry_run", `would update PR description.\n${proposal.bodyDiff ?? ""}`.slice(0, 1000));
      return settleProposal(s, { ...proposal, changeApplied: true });
    }
    await updatePrBody(s.owner, s.repo, s.number, proposal.proposedBody);
    logEvent(s.id, "pr_body_updated", "applied approved PR description");
    return settleProposal(s, { ...proposal, changeApplied: true });
  }

  // ---- code: apply-check + re-gate against current HEAD, then push ----
  if (!proposal.diff?.trim()) {
    logEvent(s.id, "approve_noop", "code proposal had no diff");
    return "blocked";
  }
  const head = await getPrHead(s.owner, s.repo, s.number);
  const { dir, remoteSha } = await addWorktree(s.owner, s.repo, head.headRefName, s.id);
  try {
    // Does the reviewed diff still land on today's tree?
    if (!(await applyPatchCheck(dir, proposal.diff))) {
      logEvent(s.id, "approve_stale", `branch advanced ${proposal.baseSha.slice(0, 7)}->${remoteSha.slice(0, 7)}; reviewed lines changed upstream`);
      notifyEscalation(s.id, s.prKey, "the lines you reviewed were modified upstream; send an instruction to re-propose");
      return "blocked";
    }
    await applyPatch(dir, proposal.diff);

    // Re-gate the EXACT frozen bytes on current HEAD — confirm they still build.
    const isCi = s.authorClass === "ci";
    const ciClass = items.find((i) => i.ciClass)?.ciClass;
    const verdict: Verdict | null = s.verdictJson ? JSON.parse(s.verdictJson) : null;
    const gate = await runGate(dir, s.repo, isCi ? { ciClass, testTarget: verdict?.ci_test_target } : {});
    logEvent(s.id, "gate", `re-gate on approve: ${gate.detail.slice(0, 1000)}`);
    if (!gate.ran || !gate.passed) {
      notifyEscalation(s.id, s.prKey, "proposal still applies but checks now fail on current HEAD; send an instruction to re-propose");
      return "blocked";
    }

    if (cfg.dryRun) {
      logEvent(s.id, "dry_run", `approved; would commit+push.\n${proposal.diff.slice(0, 1000)}`);
      updateThread(s.id, { diff: proposal.diff });
      return settleProposal(s, { ...proposal, changeApplied: true });
    }

    const commitMsg = isCi
      ? `[CI] ${proposal.planMarkdown.split("\n")[0] || "fix failing check"}`
      : `[PR Feedback] ${proposal.planMarkdown.split("\n")[0] || "address review comment"}`;
    await commitAll(dir, commitMsg);
    await pushFastForward(dir, head.headRefName);
    const pushed = await headSha(dir);
    logEvent(s.id, "pushed", `pushed ${pushed.slice(0, 7)} to ${head.headRefName}`);

    updateThread(s.id, { diff: proposal.diff, attemptCount: s.attemptCount + 1 });
    return settleProposal(s, { ...proposal, changeApplied: true });
  } finally {
    await removeWorktree(s.owner, s.repo, s.id).catch(() => {});
  }
}

/**
 * Post a parked proposal's drafted REPLY to GitHub — the reply half of the
 * two-part approval. Marks `replyPosted` and resolves the Thread if the change
 * part is also done. For a CI thread there is no comment to reply to, so this is
 * a no-op that just marks it posted. Honors dryRun.
 */
export async function postReplyProposal(s: ThreadRow): Promise<ThreadRow["status"]> {
  const cfg = loadConfig();
  if (!s.proposalJson) return s.status;
  const proposal: Proposal = JSON.parse(s.proposalJson);
  const reply = proposal.replyDraft?.trim();
  if (!reply) {
    logEvent(s.id, "reply_noop", "no reply to post");
    return settleProposal(s, { ...proposal, replyDismissed: true });
  }
  if (s.authorClass === "ci") {
    logEvent(s.id, "reply_noop", "CI thread has no comment to reply to");
    return settleProposal(s, { ...proposal, replyPosted: true });
  }
  if (cfg.dryRun) {
    logEvent(s.id, "dry_run", `would reply: ${reply}`);
    return settleProposal(s, { ...proposal, replyPosted: true });
  }
  await postReply(s, getThreadItems(s.id), reply);
  logEvent(s.id, "replied", reply);
  return settleProposal(s, { ...proposal, replyPosted: true });
}

/**
 * Dismiss a parked proposal's drafted reply without posting it (the owner will
 * reply by hand, or no reply is needed). Resolves the Thread if the change part
 * is also done.
 */
export async function dismissReplyProposal(s: ThreadRow): Promise<ThreadRow["status"]> {
  if (!s.proposalJson) return s.status;
  const proposal: Proposal = JSON.parse(s.proposalJson);
  logEvent(s.id, "reply_dismissed", "owner dismissed the drafted reply");
  return settleProposal(s, { ...proposal, replyDismissed: true });
}

/** True if an SDK error is the "Reached maximum number of turns" turn-budget cap. */
function isMaxTurnsError(err: any): boolean {
  return /maximum number of turns/i.test(err?.message ?? String(err));
}

/**
 * Fallback when the fix agent runs out of turns: the change is too large to apply
 * autonomously. Run a read-only planning pass in the existing worktree (it has the
 * real checkout, deps, and whatever partial edits the fix agent left) to produce a
 * self-contained handoff prompt the owner pastes into Claude Code by hand. The plan
 * is parked as a `manual_plan` Proposal and the Thread blocks on it — the daemon
 * never pushes a manual plan. The frozen prompt survives restarts like any Proposal.
 */
async function proposeManualPlan(
  s: ThreadRow,
  verdict: Verdict,
  items: FeedbackItem[],
  dir: string,
  instruction?: string
): Promise<ThreadRow["status"]> {
  const planMarkdown = await runPlanAgent(dir, buildPlanPrompt(s, items, verdict, instruction));
  const proposal: Proposal = {
    kind: "manual_plan",
    planMarkdown:
      planMarkdown.trim() ||
      `The requested change was too large to apply automatically. Open this PR's branch in Claude Code and address:\n\n${verdict.summary}`,
    baseSha: "",
    gatePassed: false,
    replyDraft: verdict.reply_draft || "",
  };
  updateThread(s.id, { proposal, diff: null });
  logEvent(s.id, "manual_plan", "change too large for autonomous fix; manual plan ready to copy");
  notifyEscalation(s.id, s.prKey, "change too large to auto-fix; a copy-paste plan is ready");
  emit({ type: "thread_updated", threadId: s.id });
  return "blocked";
}

const PLAN_SYSTEM = `You are writing a self-contained task brief for a senior engineer who will run it in Claude Code on a fresh checkout of THIS PR branch. The brief must be copy-paste runnable: it gets no other context. Investigate the checkout (Read/Grep/Glob/Bash, read-only) enough to be concrete, then output ONLY the brief as Markdown — no preamble. The brief should state the goal, list the exact files and symbols to change (with paths and line ranges where useful), describe the approach step by step, and note constraints (build/lint/tests must pass, keep the change minimal, don't refactor unrelated code). Do NOT make any edits yourself.`;

/**
 * Run the read-only planning agent in `dir`; returns its final Markdown brief.
 * Like the verdict engine, this never throws on a turn-budget cutoff: the brief
 * is usually streamed before the cap is hit, so we accumulate the running
 * assistant text and fall back to it when there is no clean `success` result.
 * (The fix-agent path that called us already exhausted its turns; throwing here
 * too would drop the Thread to `error` and lose the partial brief.)
 */
async function runPlanAgent(dir: string, prompt: string): Promise<string> {
  let last = "";
  let assistantText = "";
  const { env, modelArn } = await sdkEnv();
  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: dir,
        model: modelArn,
        systemPrompt: PLAN_SYSTEM,
        permissionMode: "dontAsk",
        allowedTools: ["Read", "Grep", "Glob", "Bash"],
        settingSources: [],
        env,
        // Read-only investigation of a large change needs headroom; the brief is
        // streamed before the cap and salvaged below even if turns run out.
        maxTurns: 60,
        stderr: () => {},
      },
    })) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") assistantText += block.text;
        }
      } else if (msg.type === "result" && msg.subtype === "success") {
        last = msg.result;
      }
    }
  } catch (err) {
    // A turn-budget cutoff surfaces as a thrown error in the SDK; the streamed
    // assistant text is still our best brief, so swallow it and use what we have.
    if (!isMaxTurnsError(err)) throw err;
  }
  return last || assistantText;
}

/** Prompt for the planning pass — restates the feedback the fix agent couldn't finish. */
function buildPlanPrompt(
  s: ThreadRow,
  items: FeedbackItem[],
  verdict: Verdict,
  instruction?: string
): string {
  const lines: string[] = [];
  lines.push(
    "An automated attempt to make the following change ran out of turns because the change is large. Write a concrete implementation brief a human will run in Claude Code to finish it."
  );
  lines.push("");
  if (instruction) {
    lines.push(`Owner's instruction: ${instruction}`);
    lines.push("");
  }
  if (verdict.summary) {
    lines.push(`Context: ${verdict.summary}`);
    lines.push("");
  }
  lines.push("Review feedback to address:");
  for (const it of items) {
    lines.push("---");
    if (it.path) lines.push(`file: ${it.path}${it.line ? `:${it.line}` : ""}`);
    lines.push(it.body);
  }
  lines.push("---");
  return lines.join("\n");
}

/** Run the fixing agent in `dir` with the given prompt; returns its final text. */
async function runFixAgent(dir: string, prompt: string): Promise<string> {
  let summary = "";
  const { env, modelArn } = await sdkEnv();
  for await (const msg of query({
    prompt,
    options: {
      cwd: dir,
      model: modelArn,
      systemPrompt: FIX_SYSTEM,
      permissionMode: "acceptEdits",
      allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
      settingSources: [],
      env,
      maxTurns: 40,
      stderr: () => {},
    },
  })) {
    if (msg.type === "result" && msg.subtype === "success") summary = msg.result;
  }
  return summary;
}

/** Repo-relative paths touched by a `git diff HEAD`. */
function changedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const m of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    if (m[1] && m[1] !== "/dev/null") files.add(m[1]);
  }
  return [...files];
}

/**
 * True if the gate output references at least one of the changed files. This is
 * the relatedness guard: we only re-run the fix agent for errors it plausibly
 * caused, never for pre-existing or environmental breakage elsewhere.
 */
function gateMentionsChangedFiles(gateDetail: string, changed: string[]): boolean {
  if (!changed.length) return false;
  return changed.some((f) => {
    if (gateDetail.includes(f)) return true;
    // Tools often print just the basename or a differently-rooted path.
    const base = f.split("/").pop();
    return base ? gateDetail.includes(base) : false;
  });
}

/** Prompt for a follow-up agent run that repairs gate errors it introduced. */
function buildGateFixPrompt(gateDetail: string, changed: string[]): string {
  return [
    "Your previous change broke the build/lint check. Fix the errors below so the check passes.",
    "Only address errors caused by your change to these files; do NOT touch unrelated pre-existing errors:",
    ...changed.map((f) => `  - ${f}`),
    "",
    "Check output:",
    gateDetail.slice(0, 4000),
    "",
    "Make the minimal correction. Do not commit or push.",
  ].join("\n");
}

/** Fix prompt for a CI failure: ground the agent on the raw log (decision Q18). */
function buildCiFixPrompt(
  s: ThreadRow,
  ciLogPath: string | null,
  verdict: Verdict,
  instruction?: string
): string {
  const lines: string[] = [];
  if (instruction) {
    lines.push(`The PR owner instructs: ${instruction}`);
    lines.push("");
  }
  lines.push(`A CI check is failing: ${s.threadKey.replace(/^ci:/, "")}.`);
  if (verdict.summary) lines.push(`Diagnosis: ${verdict.summary}`);
  if (ciLogPath) {
    lines.push(`The failing check's full log is at: ${ciLogPath}`);
    lines.push("Read/grep that file for the exact error, then make the minimal change to make the check pass.");
  } else {
    lines.push("Investigate the failure in the checkout and make the minimal change to make the check pass.");
  }
  lines.push("Do not commit or push.");
  return lines.join("\n");
}

function buildFixPrompt(s: ThreadRow, items: FeedbackItem[], instruction?: string): string {
  const lines: string[] = [];
  if (instruction) {
    lines.push(`The PR owner instructs: ${instruction}`);
    lines.push("");
  }
  lines.push("Review feedback to address:");
  for (const it of items) {
    lines.push("---");
    if (it.path) lines.push(`file: ${it.path}${it.line ? `:${it.line}` : ""}`);
    lines.push(it.body);
  }
  lines.push("---");
  lines.push("Make the minimal change. Do not commit or push.");
  return lines.join("\n");
}
