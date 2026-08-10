import { getThread, getThreadItems, getPrOverview } from "./db.js";
import type { PrOverview } from "./db.js";
import { loadConfig } from "./config.js";
import type { FeedbackItem, Proposal, ThreadRow, Verdict } from "./types.js";

/**
 * A **Takeover** (see CONTEXT.md): one Thread rendered as a copy-paste prompt for
 * another coding agent, for when the owner has decided to do this Thread by hand.
 *
 * It is a PURE PROJECTION of rows the daemon already holds — no agent runs, nothing
 * is generated or stored, no queue, no lifecycle coupling — so it is deterministic,
 * instant, and available on every Thread in any status. That is what separates it
 * from a **Manual plan** (agent-*planned*, parked in the Thread's single Proposal
 * slot as a fallback) and from an **Explanation** (prose written for the owner, not
 * input for a doer). Read-only by construction: this module has no push/comment
 * path at all, so `dryRun` does not gate it.
 *
 * Rendered server-side rather than in the dashboard so one renderer serves both the
 * Copy button and an agent that fetches the endpoint directly — and so Proposal
 * kinds and `baseSha` provenance stay server vocabulary.
 */

/**
 * Wrap arbitrary text in a fence long enough to survive its own content. Reviewers
 * paste fenced snippets constantly, so a fixed ``` wrapper would let a body
 * terminate the fence early and scramble every section after it.
 */
function fence(text: string, lang = ""): string {
  let longest = 0;
  // `^ {0,3}` because CommonMark lets a closing fence be indented up to three
  // spaces — which is exactly how a snippet nested in a numbered list arrives in a
  // review comment. Anchoring at column 0 would let that close the wrapper early
  // and swallow every later section into one code block.
  for (const m of text.matchAll(/^ {0,3}(`{3,})/gm)) longest = Math.max(longest, m[1].length);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  // Only trailing NEWLINES are trimmed, not trailing whitespace: a diff's context
  // lines are a single space, and eating them corrupts the patch.
  return `${ticks}${lang}\n${text.replace(/\n+$/, "")}\n${ticks}`;
}

/** A sha in the short form used throughout the provenance labels. */
function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : "unknown";
}

/** One feedback item as a labelled block: who said it, where, and what. */
function renderItem(it: FeedbackItem): string {
  const lines: string[] = [];
  const where = it.path ? ` — \`${it.path}${it.line ? `:${it.line}` : ""}\`` : "";
  const kind = it.checkName ? `${it.kind}: ${it.checkName}` : it.kind;
  lines.push(`**${it.author}** (${kind})${where}`);
  lines.push("");
  lines.push(fence(it.body));
  return lines.join("\n");
}

/**
 * The change part of a Proposal, labelled by kind. The imperative is deliberately
 * THIN: each label states what the artifact is, where it came from, and whether it
 * is live — never what should be done with it. The owner copied this Thread out
 * precisely because the judgment is now theirs, so a recommendation here would
 * steer them back down a path they may have just rejected.
 *
 * `baseSha` is the load-bearing fact: it is what lets the receiving agent notice
 * the diff predates the current checkout. That is how staleness is handled without
 * any staleness machinery — a Takeover stores nothing, so it can never itself go
 * stale; only the rows it projects can.
 */
function renderProposal(p: Proposal, dryRun: boolean): string {
  const lines: string[] = [];
  const applied = p.changeApplied && !dryRun;

  if (p.kind === "manual_plan") {
    // Agent-written prose, no diff and no gate run — so no gate claim is made.
    lines.push("## Plan the daemon drafted");
    lines.push("");
    lines.push(
      "The daemon judged this change too large to apply on its own and wrote a plan instead. Nothing was built or verified."
    );
    lines.push("");
    if (p.planMarkdown.trim()) lines.push(p.planMarkdown.trim());
    return lines.join("\n");
  }

  if (p.kind === "pr_body") {
    // The odd kind out: a description rewrite is not a code change, and pasting it
    // into a coding agent would otherwise invite file edits when the pending
    // action is `gh pr edit --body`.
    lines.push("## PR description the daemon drafted");
    lines.push("");
    lines.push(
      applied
        ? "This rewritten PR description has already been applied to the PR. It is a description only — no code change."
        : `This is a rewritten PR description the daemon drafted but has not applied${p.changeApplied ? " (it was approved while the daemon was in dry-run, so nothing reached GitHub)" : ""}. It is a description only — no code change is involved.`
    );
    if (p.planMarkdown.trim()) {
      lines.push("");
      lines.push(p.planMarkdown.trim());
    }
    if (p.proposedBody) {
      lines.push("");
      lines.push("Proposed description:");
      lines.push("");
      lines.push(fence(p.proposedBody, "markdown"));
    }
    return lines.join("\n");
  }

  if (p.kind === "code") {
    lines.push("## Change the daemon proposed");
    lines.push("");
    const gate = p.gatePassed
      ? "It passed the repo's build/test gate."
      : p.gateInconclusive
        ? "Its gate run was inconclusive — the failures it hit were in files this change did not touch."
        : "It did not pass the repo's build/test gate.";
    lines.push(
      applied
        ? `The daemon proposed this change and it has already been pushed to the branch. ${gate} Built against \`${shortSha(p.baseSha)}\`.`
        : `The daemon proposed this change and it has not been pushed${p.changeApplied ? " (it was approved while the daemon was in dry-run, so nothing reached GitHub)" : ""}. ${gate} Built against \`${shortSha(p.baseSha)}\`.`
    );
    if (p.planMarkdown.trim()) {
      lines.push("");
      lines.push(p.planMarkdown.trim());
    }
    if (p.diff) {
      lines.push("");
      lines.push(fence(p.diff, "diff"));
    }
    return lines.join("\n");
  }

  return "";
}

/** The reply part, whatever the Proposal kind — stated with its posted state. */
function renderReply(p: Proposal, dryRun: boolean): string {
  const draft = p.replyDraft?.trim();
  if (!draft) return "";
  const lines: string[] = ["## Reply the daemon drafted", ""];
  lines.push(
    p.replyPosted && !dryRun
      ? "This reply has already been posted to the GitHub thread."
      : p.replyDismissed
        ? "This reply was drafted and then dismissed without being posted."
        : p.replyPosted
          ? "This reply was drafted and has not been posted (it was approved while the daemon was in dry-run, so nothing reached GitHub)."
          : "This reply was drafted and has not been posted."
  );
  lines.push("");
  lines.push(fence(draft, "markdown"));
  return lines.join("\n");
}

/**
 * Render a Takeover. Pure and synchronous over its arguments — every input is a row
 * the caller already has, which is what makes the endpoint instant and the whole
 * document unit-testable without a database or a checkout.
 */
export function buildTakeover(
  s: ThreadRow,
  items: FeedbackItem[],
  pr: PrOverview | undefined,
  verdict: Verdict | null,
  proposal: Proposal | null,
  opts: { dryRun?: boolean } = {}
): string {
  const out: string[] = [];
  // `dryRun` does not GATE a Takeover (it writes nothing), but it must be
  // REFLECTED: the executor sets `changeApplied`/`replyPosted` in its dry-run
  // branches without touching GitHub, so those flags alone would have us report
  // work as landed on a branch that never received it.
  const dryRun = opts.dryRun === true;

  // ---- Header: the checkout facts that make a paste checkable. -------------
  // Pasting a Takeover into the wrong tree is the likeliest way this misfires, so
  // the branch and head are stated as verifiable preconditions rather than assumed.
  out.push(`# ${pr?.title ? `${pr.title} — ` : ""}review thread on ${s.prKey}`);
  out.push("");
  out.push(
    "You are picking up one review thread on a pull request by hand. Everything below is context the babysitting daemon already collected: what the reviewer said, what the daemon concluded, and any change or reply it drafted but did not send. Nothing here has been posted or pushed unless a section says so explicitly."
  );
  out.push("");
  out.push(`- Repo: \`${s.owner}/${s.repo}\``);
  out.push(`- PR: #${s.number}${pr?.url ? ` — ${pr.url}` : ""}`);
  if (pr?.headRef) out.push(`- Branch: \`${pr.headRef}\``);
  out.push(`- Branch head when this was copied: \`${shortSha(pr?.headSha)}\``);
  out.push(`- Thread status in the daemon: \`${s.status}\``);
  out.push("");
  out.push(
    "Work on that branch. If the checkout you are in is not on it, say so instead of guessing."
  );
  out.push("");

  // ---- The original conversation, verbatim. --------------------------------
  if (items.length) {
    out.push("## Review feedback");
    out.push("");
    out.push(items.map(renderItem).join("\n\n"));
    out.push("");
  }

  // ---- What the daemon concluded, and (for an escalation) what it couldn't. -
  if (verdict) {
    out.push("## What the daemon concluded");
    out.push("");
    out.push(`- Decision: \`${verdict.action}\``);
    out.push(`- Assessed risk: \`${verdict.risk}\``);
    if (verdict.summary.trim()) {
      out.push("");
      out.push(verdict.summary.trim());
    }
    // `options` is documented as escalate-only. Framing a stray one on any other
    // decision as an open question would contradict the decision printed above it.
    if (verdict.options?.length) {
      out.push("");
      out.push(
        verdict.action === "escalate"
          ? "It could not settle this itself, between:"
          : "Alternatives it recorded:"
      );
      out.push("");
      for (const o of verdict.options) out.push(`- ${o}`);
    }
    out.push("");
  }

  // ---- The drafted artifacts, labelled by what they are. -------------------
  if (proposal) {
    const change = renderProposal(proposal, dryRun);
    if (change) {
      out.push(change);
      out.push("");
    }
    const reply = renderReply(proposal, dryRun);
    if (reply) {
      out.push(reply);
      out.push("");
    }
  } else if (s.diff?.trim() && !dryRun) {
    // No Proposal, but a diff on the Thread: an auto-push or a fully-settled
    // Approve clears the frozen Proposal and leaves this forensic record of what
    // actually landed. Projecting only the Proposal would render NO change section
    // while the header promises nothing was pushed unless stated.
    out.push("## Change the daemon already pushed");
    out.push("");
    out.push("The daemon made this change and it is already on the branch.");
    out.push("");
    out.push(fence(s.diff, "diff"));
    out.push("");
  }

  // ---- Background prose, only when it is a finished document. --------------
  // A `generating`/`failed` explanation is a partial or discarded doc; including it
  // would hand over text the daemon itself refused to show as an answer.
  if (s.explanationMd?.trim() && s.explanationStatus === "ready") {
    out.push("## Background the daemon wrote for you");
    out.push("");
    out.push(
      `Written to explain this thread to the PR author, never posted to GitHub. Built against \`${shortSha(s.explanationHeadSha)}\`.`
    );
    out.push("");
    out.push(s.explanationMd.trim());
    out.push("");
  }

  // De-blank at the JOIN, never over the finished string: a document-wide
  // `\n{3,}` squeeze also rewrites the quoted feedback bodies and the diff, and a
  // diff whose hunk body loses a blank line no longer applies — while the document
  // still claims it was built against a base sha.
  return out.filter((chunk, i) => chunk !== "" || out[i - 1] !== "").join("\n").trimEnd() + "\n";
}

/**
 * Assemble a Thread's Takeover from the database. Returns null when there is no
 * such Thread. Cheap enough to serve on every request — it is a few indexed reads
 * and a string build, with no agent, no worktree and no `gh` call.
 */
export function takeoverForThread(threadId: number): string | null {
  const s = getThread(threadId);
  if (!s) return null;
  return buildTakeover(
    s,
    getThreadItems(threadId),
    getPrOverview(s.prKey),
    s.verdictJson ? (JSON.parse(s.verdictJson) as Verdict) : null,
    s.proposalJson ? (JSON.parse(s.proposalJson) as Proposal) : null,
    { dryRun: loadConfig().dryRun }
  );
}
