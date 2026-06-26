import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "./config.js";
import {
  ensureClone,
  gitDiff,
  commitAll,
  headSha,
  remoteHeadSha,
  pushFastForward,
} from "./worktrees.js";
import { runGate } from "./gate.js";
import {
  postIssueComment,
  replyToReviewComment,
  getPrHead,
} from "./gh.js";
import { getThreadItems, logEvent, updateThread } from "./db.js";
import { notifyEscalation } from "./notify.js";
import { emit } from "./events.js";
import type { FeedbackItem, ThreadRow, Verdict } from "./types.js";

const FIX_SYSTEM = `You are fixing code-review feedback on a checkout of a PR branch. Make ONLY the change the feedback requests — do not refactor surrounding code. Use Edit/Write to change files. Do NOT commit, push, or run git; the harness handles that. When done, briefly state what you changed.`;

/** Pick a feedback item suitable for posting a reply against (inline thread root). */
function replyTarget(items: FeedbackItem[]): FeedbackItem | undefined {
  return items.find((i) => i.kind === "review_comment") ?? items[0];
}

async function postReply(
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
 * Execute a thread's verdict (or a user instruction). Honors dryRun.
 * Returns the new status.
 */
export async function execute(
  s: ThreadRow,
  verdict: Verdict,
  opts: { instruction?: string } = {}
): Promise<ThreadRow["status"]> {
  const cfg = loadConfig();
  const items = getThreadItems(s.id);
  const tag = `[${s.prKey}#${s.id}]`;

  // Resolve effective action: a user instruction can override the verdict.
  let action = verdict.action;
  let replyBody = verdict.reply_draft;
  if (opts.instruction) {
    const ins = opts.instruction.trim();
    if (/^ignore\b/i.test(ins)) {
      logEvent(s.id, "instruction", "ignored by user");
      return "resolved";
    }
    const replyMatch = ins.match(/^reply:\s*([\s\S]+)/i);
    if (replyMatch) {
      action = "reply";
      replyBody = replyMatch[1].trim();
    } else {
      action = "auto_fix"; // freeform => treat as a fix directive
    }
  }

  // ---- reply ----
  if (action === "reply") {
    if (cfg.dryRun) {
      logEvent(s.id, "dry_run", `would reply: ${replyBody.slice(0, 200)}`);
      return "resolved";
    }
    await postReply(s, items, replyBody);
    logEvent(s.id, "replied", replyBody.slice(0, 200));
    return "resolved";
  }

  // ---- escalate ----
  if (action === "escalate") {
    notifyEscalation(s.id, s.prKey, verdict.summary || "needs your input");
    logEvent(s.id, "escalated", verdict.summary);
    return "blocked";
  }

  // ---- auto_fix ----
  const head = await getPrHead(s.owner, s.repo, s.number);
  const { dir, remoteSha } = await ensureClone(s.owner, s.repo, head.headRefName);
  const baseSha = remoteSha;

  // Run the fixing agent.
  const prompt = buildFixPrompt(s, items, opts.instruction);
  let fixSummary = "";
  for await (const msg of query({
    prompt,
    options: {
      cwd: dir,
      model: cfg.model,
      systemPrompt: FIX_SYSTEM,
      permissionMode: "acceptEdits",
      allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
      settingSources: [],
      maxTurns: 40,
      stderr: () => {},
    },
  })) {
    if (msg.type === "result" && msg.subtype === "success") fixSummary = msg.result;
  }

  const diff = await gitDiff(dir);
  updateThread(s.id, { diff });
  if (!diff.trim()) {
    logEvent(s.id, "fix_noop", "agent made no changes — escalating");
    notifyEscalation(s.id, s.prKey, "auto-fix produced no changes; needs review");
    return "blocked";
  }

  // Pre-push gate.
  const gate = await runGate(dir, s.repo);
  logEvent(s.id, "gate", gate.detail.slice(0, 1000));
  if (!gate.ran || !gate.passed) {
    notifyEscalation(
      s.id,
      s.prKey,
      gate.ran ? "fix failed checks; needs review" : "no check to self-verify; needs review"
    );
    return "blocked";
  }

  if (cfg.dryRun) {
    logEvent(s.id, "dry_run", `gate passed; would commit+push.\n${diff.slice(0, 1000)}`);
    return "resolved";
  }

  // Branch-safety: only push if remote hasn't advanced past our base.
  const currentRemote = await remoteHeadSha(dir, head.headRefName);
  if (currentRemote !== baseSha) {
    logEvent(s.id, "branch_moved", `remote advanced ${baseSha.slice(0, 7)}->${currentRemote.slice(0, 7)}; aborting push`);
    notifyEscalation(s.id, s.prKey, "branch advanced during fix; needs rebase/your call");
    return "blocked";
  }

  await commitAll(dir, `[PR Feedback] ${verdict.summary || "address review comment"}`);
  await pushFastForward(dir, head.headRefName);
  const pushed = await headSha(dir);
  logEvent(s.id, "pushed", `pushed ${pushed.slice(0, 7)} to ${head.headRefName}`);

  // Acknowledge on the thread.
  const ack = replyBody || `Addressed in ${pushed.slice(0, 7)}. ${fixSummary.slice(0, 300)}`;
  await postReply(s, items, ack);
  logEvent(s.id, "replied", ack.slice(0, 200));

  // Loop-guard bookkeeping: count this autonomous fix attempt.
  updateThread(s.id, { attemptCount: s.attemptCount + 1 });
  emit({ type: "thread_updated", threadId: s.id });
  return "resolved";
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
