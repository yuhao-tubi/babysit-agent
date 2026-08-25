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
  applyPatchRebasing,
  branchChangedFiles,
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
import { isMaxTurnsError } from "./sdk.js";
import { markAgentAuthored } from "./classify.js";
import type { FeedbackItem, Proposal, ThreadRow, Verdict } from "./types.js";

/** Whether this thread's class may push without owner approval (and not high-risk). */
function mayAutoPush(s: ThreadRow, verdict: Verdict): boolean {
  const cfg = loadConfig();
  if (verdict.risk === "high") return false; // risk:high always vetoes auto-push
  return cfg.autoPushClasses.includes(s.authorClass);
}

const FIX_SYSTEM = `You are fixing code-review feedback on a checkout of a PR branch. Make ONLY the change the feedback requests — do not refactor surrounding code. Use Edit/Write to change files. Do NOT commit, push, or run git; the harness handles that. Keep the change small: an autonomous fix should touch only a handful of files. If addressing the feedback properly would require editing many files (a large refactor), do NOT attempt it — stop and briefly explain that it is too large. When done, briefly state what you changed.`;

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
 * Persist a mutated Proposal and derive the Thread's status. OR semantics: a
 * positive approval of EITHER part (change pushed/applied OR reply posted) resolves
 * the Thread — the owner has acted, so it no longer blocks on the other part. The
 * un-acted part stays available: we keep the frozen proposal until BOTH parts are
 * settled (applied/posted or dismissed/absent), so its button still works after
 * the Thread resolves. Returns the new status.
 */
function settleProposal(s: ThreadRow, p: Proposal): ThreadRow["status"] {
  const bothSettled = !changePending(p) && !replyPending(p);
  const anyApproved = !!p.changeApplied || !!p.replyPosted;
  // Only clear the frozen proposal once nothing is left to act on; otherwise keep
  // it so the remaining part remains approvable on the (now resolved) Thread.
  updateThread(s.id, { proposal: bothSettled ? null : p });
  emit({ type: "thread_updated", threadId: s.id });
  return anyApproved || bothSettled ? "resolved" : "awaiting_approval";
}

/**
 * Carry a prior Proposal's settled REPLY progress onto the Proposal that replaces
 * it. Re-proposing builds a fresh Proposal from scratch, so without this the reply
 * part silently regresses to "pending": a reply already sitting on GitHub would be
 * offered for posting a second time (a duplicate comment on the reviewer's thread),
 * and one the owner deliberately dismissed would come back.
 *
 * Only the SETTLED reply flags carry. `changeApplied` deliberately does not: the
 * rebuilt change is different bytes that have never been pushed, and inheriting
 * "applied" would hide it from Approve entirely. When the prior reply was posted we
 * also keep its text, so the card shows what actually went to GitHub rather than a
 * newer draft nobody sent.
 */
export function carryReplyProgress(prior: Proposal | null, next: Proposal): Proposal {
  if (!prior) return next;
  const out = { ...next };
  if (prior.replyPosted) {
    out.replyPosted = true;
    if (prior.replyDraft?.trim()) out.replyDraft = prior.replyDraft;
  }
  if (prior.replyDismissed) out.replyDismissed = true;
  return out;
}

/**
 * Returned by `approveProposal` instead of a status when the frozen diff conflicted
 * with upstream: the Thread is NOT finished (it stays `in_progress`) and the caller
 * must drive the rebuild with `instruction`.
 */
export type StaleProposal = { stale: true; instruction: string };

/**
 * True if parking this Thread's proposal already raised a banner of its own — an
 * inconclusive gate, or a high-risk change (see the tail of `proposeCode`). The
 * stale-rebuild path checks this so the round trip stays at ONE banner instead of
 * stacking "approve again" on top of a warning that already says to go look.
 */
export function parkAlreadyNotified(s: ThreadRow): boolean {
  const proposal: Proposal | null = s.proposalJson ? JSON.parse(s.proposalJson) : null;
  if (!proposal) return false;
  if (proposal.gateInconclusive) return true;
  const verdict: Verdict | null = s.verdictJson ? JSON.parse(s.verdictJson) : null;
  return verdict?.risk === "high";
}

/** How much of the stale diff to quote back to the fix agent. */
const STALE_DIFF_CHARS = 4000;

/**
 * The instruction that drives an automatic re-propose after Approve found the
 * frozen diff conflicting with upstream (see `approveProposal`). It quotes the diff
 * that no longer applies so the agent re-applies the same INTENT on today's code
 * instead of re-deciding from nothing — and explicitly licenses the other outcome,
 * making no change at all, because upstream touching those exact lines often means
 * the feedback was already addressed there. An empty rebuild then lands the Thread
 * at `blocked` for the owner to close, which we prefer to guessing.
 */
export function buildStaleRebuildInstruction(o: {
  baseSha: string;
  remoteSha: string;
  diff: string;
}): string {
  const quoted =
    o.diff.length > STALE_DIFF_CHARS
      ? `${o.diff.slice(0, STALE_DIFF_CHARS)}\n… (diff truncated)`
      : o.diff;
  return [
    `The branch advanced ${o.baseSha.slice(0, 7)} -> ${o.remoteSha.slice(0, 7)} and upstream edited the same lines the proposed fix changed, so it no longer applies. Re-apply the SAME intent on the current code.`,
    "",
    "The fix that no longer applies:",
    "```diff",
    quoted,
    "```",
    "",
    "If upstream has already addressed the feedback, make no change at all and say so — do not invent a different fix.",
  ].join("\n");
}

export async function postReply(
  s: ThreadRow,
  items: FeedbackItem[],
  body: string
): Promise<void> {
  const target = replyTarget(items);
  // Every reply carries the agent marker (see AGENT_MARKER): replies post under
  // the owner's `gh` login, so the login alone can't distinguish the agent's own
  // ack from a genuine note the owner typed. The poller needs that distinction
  // now that a self-rooted thread is triaged like any other.
  const marked = markAgentAuthored(body);
  if (target && target.kind === "review_comment") {
    await replyToReviewComment(s.owner, s.repo, s.number, target.ghId, marked);
  } else {
    // Review summaries / issue comments → top-level issue comment.
    await postIssueComment(s.owner, s.repo, s.number, marked);
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

  // ---- dismiss ----
  // Nothing was asked (bot summary header, boilerplate, LGTM, an echo of our own
  // reply). Resolve the Thread locally: no Proposal to park, no reply to post, and
  // deliberately NO GitHub write — not even resolving an inline review thread,
  // which stays the owner's call via "Mark resolved". `dryRun` is therefore moot.
  // The poller only re-opens a resolved Thread on genuinely new activity
  // (poller.ts upsertThread), so this stays quiet without touching GitHub.
  if (action === "dismiss") {
    logEvent(s.id, "dismissed", verdict.summary || "nothing actionable in this thread");
    emit({ type: "thread_updated", threadId: s.id });
    return "resolved";
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
  // lightDeps: a non-CI fix is verified by the LIGHT gate (typecheck/lint of the
  // changed files), which doesn't need exact dep versions — so shareDeps may
  // symlink base node_modules instead of a multi-GB copy when the PR only bumped
  // already-installed packages. CI fixes run the real suite → full copy+install.
  const { dir, remoteSha } = await addWorktree(s.owner, s.repo, head.headRefName, s.id, {
    lightDeps: !isCi,
  });
  const baseSha = remoteSha;
  // The PR's own diff against the base branch. Feeds the light gate's stale-
  // artifact rebuild (see gate.ts runLightGate): the worktree's seeded
  // `packages/*/lib` declarations are built from the base branch, so every
  // workspace package the PR modified needs rebuilding before the app typecheck —
  // otherwise the gate fails on the PR's own new symbols and parks inconclusive.
  const branchFiles = isCi ? [] : await branchChangedFiles(dir);
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
    // Set when the gate failed but only on files the fix didn't touch. The
    // proposal is still parked (gate inconclusive), never auto-pushed.
    let gateInconclusive = false;
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

      // Size guard: an autonomous fix must stay an easy, reviewable change. A
      // diff touching more than `maxProposalFiles` files (source + test + config,
      // no exemptions) is too large to apply automatically — pivot to a Manual
      // plan (the copy-paste-into-Claude-Code handoff) instead of parking a
      // Proposal. The fix prompt also softly hints this limit so the agent bails
      // early; this is the deterministic backstop that actually enforces it.
      const touched = changedFiles(diff);
      if (touched.length > cfg.maxProposalFiles) {
        logEvent(s.id, "fix_too_large", `fix touched ${touched.length} files (> ${cfg.maxProposalFiles}); generating a manual plan`);
        return await proposeManualPlan(s, verdict, items, dir, instruction);
      }

      // Pre-push gate. For CI fixes the gate runs the failing check's class
      // (build / unit test) in addition to the typecheck+lint floor (Q9b/Q22).
      // Non-CI (owner-reviewed) proposals use the light gate: verify the diff
      // (incremental typecheck + lint on changed files) instead of the whole repo.
      const gate = await runGate(
        dir,
        s.repo,
        isCi
          ? { ciClass, testTarget: verdict.ci_test_target }
          : { light: true, changedFiles: changedFiles(diff), branchFiles }
      );
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
        // Every failure is outside the diff — a dirty baseline the fix agent
        // can't (and shouldn't) repair. Don't dead-end: park the proposal
        // flagged inconclusive so the owner can review the diff and make an
        // informed Approve. The re-gate on Approve applies the same filter.
        logEvent(s.id, "gate_inconclusive", "gate failed only on files the fix didn't touch (pre-existing); parking proposal for owner review");
        gateInconclusive = true;
        break;
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

    // Gate passed cleanly. Either auto-push (scoped classes) or freeze + park.
    // An inconclusive gate never auto-pushes — it always waits for the owner's
    // informed Approve, even for autoPushClasses (mayAutoPush vetoes it).
    // `!instruction`: an instruction-driven run ALWAYS re-proposes and never pushes
    // (CONTEXT.md, "Instruction") — the owner asked for a revision, so the revised
    // bytes are unread and must be approved. This is load-bearing for the automatic
    // stale rebuild, which arrives here as a synthesized instruction: its whole point
    // is that the diff the owner approved no longer exists.
    if (!gateInconclusive && !instruction && mayAutoPush(s, verdict)) {
      return await pushVerifiedDiff(s, verdict, items, head.headRefName, baseSha, dir, diff, fixSummary, isCi);
    }

    // Park: freeze the diff for the owner to Approve. Writes nothing to GitHub,
    // so dryRun is irrelevant here — the push happens only on Approve.
    // A re-propose REPLACES whatever proposal was parked here, so any reply part
    // the owner already settled must survive the swap — otherwise a reply already
    // on GitHub is offered for posting again.
    const prior: Proposal | null = s.proposalJson ? JSON.parse(s.proposalJson) : null;
    const proposal: Proposal = carryReplyProgress(prior, {
      kind: "code",
      planMarkdown: verdict.summary || fixSummary || "Proposed code change.",
      baseSha,
      gatePassed: !gateInconclusive,
      gateInconclusive: gateInconclusive || undefined,
      diff,
      replyDraft: verdict.reply_draft || fixSummary || "",
    });
    updateThread(s.id, { proposal, diff: null });
    logEvent(
      s.id,
      "proposed",
      gateInconclusive
        ? `proposal ready (gate inconclusive — pre-existing errors elsewhere); awaiting approval (base ${baseSha.slice(0, 7)})`
        : `gate-passed proposal ready; awaiting approval (base ${baseSha.slice(0, 7)})`
    );
    if (gateInconclusive) notifyEscalation(s.id, s.prKey, "proposal ready but gate couldn't pass cleanly (pre-existing errors); review & approve");
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
 *
 * One outcome is not a status: when upstream edited the same lines the frozen diff
 * changes, this returns a `StaleProposal` asking the CALLER to re-propose. It can't
 * do that itself — a re-propose runs a fix agent through the repo queue, and this
 * already runs inside a queue job (`SerialQueue` is not re-entrant, so re-entering
 * would deadlock).
 */
export async function approveProposal(s: ThreadRow): Promise<ThreadRow["status"] | StaleProposal> {
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
  // lightDeps: this approve re-gates a non-CI proposal with the LIGHT gate
  // (typecheck/lint of changed files), which doesn't need exact dep versions —
  // so shareDeps may symlink base node_modules instead of a multi-GB copy when
  // the PR only bumped already-installed packages. CI fixes run the real suite,
  // so they keep the full copy+install.
  const { dir, remoteSha } = await addWorktree(s.owner, s.repo, head.headRefName, s.id, {
    lightDeps: s.authorClass !== "ci",
  });
  try {
    // Does the reviewed diff still land on today's tree? Plain apply first
    // (exact frozen bytes); on context drift, a 3-way merge re-seats the same
    // edit. `landed.diff` is what will actually be pushed — from here on, use it
    // instead of `proposal.diff` for the gate, the stored diff, and the log.
    const landed = await applyPatchRebasing(dir, proposal.diff);
    if (landed.mode === "conflict") {
      // Don't dead-end on `blocked` waiting for the owner to hand-type "redo it":
      // signal the caller to run that re-propose itself. No banner here — the one
      // banner comes when the rebuilt proposal is ready (or when the rebuild fails,
      // from its own failure path). The stale diff is logged before it is
      // overwritten so the timeline keeps what was reviewed.
      logEvent(s.id, "approve_stale", `branch advanced ${proposal.baseSha.slice(0, 7)}->${remoteSha.slice(0, 7)}; upstream edited the same lines this proposal changes`);
      logEvent(s.id, "auto_repropose", `rebuilding the fix on ${remoteSha.slice(0, 7)}; the proposal that no longer applies:\n${proposal.diff.slice(0, 1000)}`);
      emit({ type: "thread_updated", threadId: s.id });
      return {
        stale: true,
        instruction: buildStaleRebuildInstruction({
          baseSha: proposal.baseSha,
          remoteSha,
          diff: proposal.diff,
        }),
      };
    }
    if (landed.mode === "invalid") {
      // Nothing landed even with a 3-way merge: a malformed frozen diff, or the
      // pre-image blob is missing so no merge was possible. Distinct from a conflict
      // so it isn't misdiagnosed as upstream drift — and NOT auto-rebuilt, because
      // the cause is our own artifact, not the branch moving.
      const moved = remoteSha !== proposal.baseSha;
      logEvent(s.id, "approve_patch_invalid", `frozen diff could not be applied at ${remoteSha.slice(0, 7)}${moved ? ` (branch advanced from ${proposal.baseSha.slice(0, 7)})` : " (unchanged HEAD)"}; re-propose to rebuild it`);
      notifyEscalation(s.id, s.prKey, "the saved proposal could not be applied; send an instruction to re-propose");
      return "blocked";
    }

    // A rebased landing is no longer WYSIWYG — the pushed bytes are the reviewed
    // edit re-seated on new context, not the exact bytes shown at review time. Two
    // guardrails: it may not touch any file the frozen diff didn't (a merge that
    // widens the blast radius is not the change the owner approved), and the
    // rebased diff is logged and stored so the timeline shows what really went out.
    if (landed.mode === "rebased") {
      const frozenFiles = new Set(changedFiles(proposal.diff));
      const widened = changedFiles(landed.diff).filter((f) => !frozenFiles.has(f));
      if (widened.length) {
        logEvent(s.id, "approve_patch_invalid", `3-way merge widened the change to ${widened.join(", ")}; re-propose to rebuild it`);
        notifyEscalation(s.id, s.prKey, "the saved proposal no longer applies cleanly; send an instruction to re-propose");
        return "blocked";
      }
      logEvent(s.id, "approve_rebased", `frozen diff re-seated onto ${remoteSha.slice(0, 7)} via 3-way merge (base ${proposal.baseSha.slice(0, 7)}); pushing this rebased diff:\n${landed.diff.slice(0, 1000)}`);
    }

    // Re-gate the bytes that will actually be pushed on current HEAD.
    const isCi = s.authorClass === "ci";
    const ciClass = items.find((i) => i.ciClass)?.ciClass;
    const verdict: Verdict | null = s.verdictJson ? JSON.parse(s.verdictJson) : null;
    const gate = await runGate(
      dir,
      s.repo,
      isCi
        ? { ciClass, testTarget: verdict?.ci_test_target }
        : {
            light: true,
            changedFiles: changedFiles(landed.diff),
            // Same stale-seeded-artifact rebuild as the propose path. Unaffected by
            // the applied patch: the three-dot diff reads committed HEAD, and the
            // landed patch is still only in the working tree.
            branchFiles: await branchChangedFiles(dir),
          }
    );
    logEvent(s.id, "gate", `re-gate on approve: ${gate.detail.slice(0, 1000)}`);
    if (!gate.ran) {
      notifyEscalation(s.id, s.prKey, "proposal still applies but checks now fail on current HEAD; send an instruction to re-propose");
      return "blocked";
    }
    if (!gate.passed) {
      // Failures only in files the diff didn't touch = the same dirty baseline
      // the owner already saw flagged. Approve is their informed override, so
      // push anyway. A failure that DOES reference the diff means the frozen
      // bytes no longer build on current HEAD — block and ask for a re-propose.
      const changed = changedFiles(landed.diff);
      if (isCi || gateMentionsChangedFiles(gate.detail, changed)) {
        notifyEscalation(s.id, s.prKey, "proposal still applies but checks now fail on current HEAD; send an instruction to re-propose");
        return "blocked";
      }
      logEvent(s.id, "gate_inconclusive", "re-gate failed only on files the diff didn't touch (pre-existing); pushing per owner approval");
    }

    if (cfg.dryRun) {
      logEvent(s.id, "dry_run", `approved; would commit+push.\n${landed.diff.slice(0, 1000)}`);
      updateThread(s.id, { diff: landed.diff });
      return settleProposal(s, { ...proposal, changeApplied: true });
    }

    const commitMsg = isCi
      ? `[CI] ${proposal.planMarkdown.split("\n")[0] || "fix failing check"}`
      : `[PR Feedback] ${proposal.planMarkdown.split("\n")[0] || "address review comment"}`;
    await commitAll(dir, commitMsg);
    await pushFastForward(dir, head.headRefName);
    const pushed = await headSha(dir);
    logEvent(s.id, "pushed", `pushed ${pushed.slice(0, 7)} to ${head.headRefName}`);

    updateThread(s.id, { diff: landed.diff, attemptCount: s.attemptCount + 1 });
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

/**
 * Repo-relative paths touched by a `git diff HEAD` — additions, modifications and
 * deletions alike.
 *
 * Two header forms, because neither alone is complete: `+++ b/<path>` covers every
 * text hunk but is absent for a BINARY file (git emits only the `diff --git`
 * header + `GIT binary patch`) and points at `/dev/null` for a DELETION. The
 * `diff --git a/<p> b/<p>` line is always present, so it backfills both — the
 * backreference keeps it to same-path entries, leaving renames (differing a/b) to
 * the `+++` form. Under-reporting here weakens real guardrails: the size limit,
 * the gate relatedness check, and Approve's blast-radius comparison.
 */
function changedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const m of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    if (m[1] && m[1] !== "/dev/null") files.add(m[1]);
  }
  for (const m of diff.matchAll(/^diff --git a\/(.+) b\/\1$/gm)) {
    if (m[1]) files.add(m[1]);
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
