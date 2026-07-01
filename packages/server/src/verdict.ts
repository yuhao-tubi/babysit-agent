import { query } from "@anthropic-ai/claude-agent-sdk";
import { sdkEnv } from "./config.js";
import { addWorktree, removeWorktree } from "./worktrees.js";
import { materializeCiLog } from "./ci.js";
import type { FeedbackItem, ThreadRow, Verdict } from "./types.js";
import { getPrHead, getPrBody } from "./gh.js";

const CI_VERDICT_SYSTEM = `You triage a FAILING CI CHECK on a pull request. You work in a read-only checkout of the PR branch. The failing check's full log has been written to a file on disk. Never guess.

Work efficiently — you have a limited number of turns. The log can be very large, so do NOT read it top-to-bottom: GREP it first for the failure (e.g. patterns like "FAIL ", "● ", "✕", "Error:", "AssertionError", "Expected", "##[error]", "exit code"), then read only the few matching regions and the specific source files they point to. Decide as soon as you have enough evidence; don't keep exploring once the failure and fix (or non-fix) are clear.

You MUST end your response with a single fenced JSON block (\`\`\`json ... \`\`\`) and nothing after it, matching:
{
  "action": "propose" | "escalate",
  "summary": "<one sentence: what failed and your decision>",
  "reply_draft": "<short note describing the fix; not posted to GitHub for CI>",
  "risk": "low" | "medium" | "high",
  "ci_test_target": { "file": "<path>", "nameFilter": "<optional test-name substring>" }
}

Decision rules (CI is NOT a conversation — only these two actions are valid):
- propose: the failure is a concrete code/config defect AND you are confident exactly what the fix is and that it is safe. The change is built and gate-verified, then either pushed (for auto-push-enabled classes) or parked for the owner to approve — you do not need to ask permission here, just make the check pass.
- escalate: anything else — a flaky/infra failure, an ambiguous or risky fix, a failure you cannot localize, or a design decision. Set escalate whenever you are unsure.

Do NOT choose reply or amend_pr_body — they are invalid for CI and will be coerced to escalate.

ci_test_target: ONLY when the failing check is a unit-test suite AND you can identify the specific failing test from the log. Give the test FILE path (repo-relative) and, if you can, a nameFilter (a substring of the failing test's name). The pre-push gate runs this target to verify your fix; if you cannot identify it, omit ci_test_target and the gate runs the whole suite.

Set risk:"high" for anything touching security or correctness.

Citing code: embed file/line references as GitHub permalinks using the provided blob base URL: <base>/<path>#L<line>.`;

const VERDICT_SYSTEM = `You triage code-review feedback on a pull request. You work in a read-only checkout of the PR branch. Investigate the actual code before deciding — never guess.

You MUST end your response with a single fenced JSON block (\`\`\`json ... \`\`\`) and nothing after it, matching:
{
  "action": "propose" | "reply" | "escalate" | "amend_pr_body",
  "summary": "<one sentence: what the feedback wants and your decision>",
  "reply_draft": "<the reply to post on GitHub; for propose this is the acknowledgement posted after the change is applied; for amend_pr_body this accompanies the description edit>",
  "risk": "low" | "medium" | "high",
  "options": ["<ONLY for escalate: 2-4 short choices the owner could pick, each phrased as an instruction>"],
  "proposed_body": "<ONLY for amend_pr_body: the FULL rewritten PR description>"
}

Decision rules:
- propose: a concrete code change is needed AND you are confident exactly what it is and that it is safe. The change is built and gate-verified, then parked for the owner to Approve (or auto-pushed for auto-push-enabled classes) — you are NOT pushing blindly, so propose whenever a clear, safe code change addresses the feedback.
- reply: NO code change needed AND no human judgment needed — e.g. a bot false-positive (prove it by citing the file/lines that already handle the concern), a nit you can decline with reasoning, or a factual question with a clear answer.
- amend_pr_body: the feedback disputes the PR DESCRIPTION text itself (not the code), and the fix is an intent-preserving edit to that description — see the PR-description policy below.
- escalate: a DECISION is needed and there is no single change to propose — a design tradeoff, an ambiguous request, or a real bug whose fix is unclear or risky. Set escalate whenever you are unsure. When you escalate, populate "options" with the concrete choices you see (each phrased as an instruction the owner could send, e.g. "change only this line" / "update all four call sites for consistency"); omit options only when there is genuinely nothing to choose between.

Author-class policy (provided to you):
- If author_class is "human" and the feedback needs NO code change (a decline/rebuttal), you MUST escalate — a human reviewer's pushback should be worded by the PR owner, not auto-replied. The ONLY exception is the PR-description policy below.
- If author_class is "bot", you may reply autonomously to false-positives and nits.

PR-description policy (the amend_pr_body carve-out):
The current PR description is provided below. If the feedback takes issue with how the DESCRIPTION is written — e.g. a claim stated too definitively, an inaccuracy, missing nuance — and you judge the reviewer's point reasonable, you may choose amend_pr_body and propose a rewritten description. This is the one case where human feedback needing no code change does NOT force escalate. It is still NOT auto-applied: the proposal is drafted and parked for the PR owner to Approve.
Hard limits — if the edit would do ANY of these, you MUST escalate instead of amend_pr_body:
  - remove or weaken a SUBSTANTIVE claim the author made (only soften CERTAINTY/wording, never drop the underlying point or its supporting data),
  - change the PR's scope, intent, or what it says was done,
  - adjudicate a genuine technical dispute where you are not confident the reviewer is correct.
When you DO amend: return the COMPLETE new description in proposed_body (not a diff, not a fragment) — preserve all sections, formatting, and every substantive claim and its supporting data; change only what the feedback warrants. Put your one-line rationale (why it's non-breaking) in summary, and the reply that will accompany the edit in reply_draft.

For bot comments: do NOT dismiss as false-positive without verifying the current file state. When it IS a false positive, the reply_draft must cite specific paths/lines/code proving the concern is already handled.
Set risk:"high" for anything touching security or correctness — a high-risk change is still proposed (so the owner can review the exact diff), but it always requires explicit owner approval and is never auto-pushed.

Citing code: whenever you reference a specific file/line to explain or justify something (in summary or reply_draft), embed it as a GitHub permalink instead of a bare path:line. The prompt gives you a repo blob base URL pinned to the PR head commit; build links as \`<base>/<path>#L<line>\` (or \`#L<start>-L<end>\` for a range), and render them as markdown, e.g. \`[\`html5.ts:2726\`](<base>/packages/player/src/adapters/html5.ts#L2726)\`. Keep the visible text as the human-readable \`file:line\` so it stays readable, but make it a clickable link.`;

function buildPrompt(s: ThreadRow, items: FeedbackItem[], blobBase: string, prBody: string): string {
  const lines: string[] = [];
  lines.push(`PR: ${s.prKey}`);
  lines.push(`Comment author_class: ${s.authorClass}`);
  lines.push(`Review/thread: ${s.threadKey}`);
  lines.push(`Repo blob base URL (pinned to PR head): ${blobBase}`);
  lines.push(`  Build code links as <base>/<path>#L<line>, e.g. ${blobBase}/packages/player/src/adapters/html5.ts#L2726`);
  lines.push("");
  lines.push("Current PR description (for the amend_pr_body policy — this is the text the description-feedback refers to):");
  lines.push("<<<PR_DESCRIPTION");
  lines.push(prBody || "(empty)");
  lines.push("PR_DESCRIPTION");
  lines.push("");
  lines.push("Feedback items in this thread:");
  for (const it of items) {
    lines.push("---");
    lines.push(`author: ${it.author} (${it.authorType})  kind: ${it.kind}`);
    if (it.path) lines.push(`location: ${it.path}${it.line ? `:${it.line}` : ""}`);
    lines.push(`body:\n${it.body}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(
    "Investigate the referenced files in this checkout, then return your verdict as the trailing JSON block."
  );
  return lines.join("\n");
}

function buildCiPrompt(
  s: ThreadRow,
  items: FeedbackItem[],
  blobBase: string,
  logPath: string
): string {
  const it = items[0];
  const lines: string[] = [];
  lines.push(`PR: ${s.prKey}`);
  lines.push(`Failing check: ${it?.checkName ?? s.threadKey}  (class: ${it?.ciClass ?? "unknown"})`);
  lines.push(`Repo blob base URL (pinned to PR head): ${blobBase}`);
  lines.push(`Failing check log (read/grep this file for the error): ${logPath}`);
  if (it?.htmlUrl) lines.push(`Run URL: ${it.htmlUrl}`);
  lines.push("");
  lines.push(
    "Read the log file, find the failure, investigate the referenced source files in this checkout, then return your verdict as the trailing JSON block."
  );
  return lines.join("\n");
}

function parseVerdict(text: string, isCi = false): Verdict {
  // Grab the last fenced json block.
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = matches.length ? matches[matches.length - 1][1] : text;
  let obj: any;
  try {
    obj = JSON.parse(raw.trim());
  } catch {
    // Last resort: find the outermost {...}.
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`verdict not parseable: ${text.slice(0, 200)}`);
    obj = JSON.parse(m[0]);
  }
  const action = obj.action;
  // CI verdicts are propose | escalate only (decision Q8); any other action
  // (including a malformed one) coerces to escalate rather than throwing.
  if (!isCi && !["propose", "reply", "escalate", "amend_pr_body"].includes(action)) {
    throw new Error(`invalid verdict action: ${action}`);
  }
  let v: Verdict = {
    action,
    summary: String(obj.summary ?? ""),
    reply_draft: String(obj.reply_draft ?? ""),
    risk: ["low", "medium", "high"].includes(obj.risk) ? obj.risk : "medium",
  };
  // Suggested decision options (only meaningful for escalate).
  if (Array.isArray(obj.options)) {
    const options = obj.options
      .filter((o: unknown) => typeof o === "string" && o.trim())
      .map((o: string) => o.trim());
    if (options.length) v = { ...v, options };
  }
  if (isCi) {
    // CI: only propose | escalate. Anything else (incl. a non-propose action)
    // coerces to escalate. risk:high no longer forces escalate — the proposal is
    // built and parked for approval (autoPushClasses + risk:high veto handle the
    // push decision downstream).
    if (v.action !== "propose") v = { ...v, action: "escalate" };
    const t = obj.ci_test_target;
    if (t && typeof t.file === "string" && t.file.trim()) {
      v = {
        ...v,
        ci_test_target: {
          file: t.file.trim(),
          nameFilter: typeof t.nameFilter === "string" && t.nameFilter.trim() ? t.nameFilter.trim() : undefined,
        },
      };
    }
    return v;
  }
  if (action === "amend_pr_body") {
    const body = obj.proposed_body;
    // A description amendment with no actual proposed text is unusable — fall
    // back to a plain escalation so the owner sees the feedback.
    if (typeof body === "string" && body.trim()) {
      v = { ...v, proposed_body: body };
    } else {
      v = { ...v, action: "escalate" };
    }
  }
  // NOTE: risk:high no longer forces escalate. A high-risk change is still
  // proposed (the owner reviews the exact diff); the auto-push veto for high-risk
  // is enforced in the executor, so the proposal always waits for Approve.
  return v;
}

/** Build a readable old→new diff of the PR body for the dashboard. */
function bodyDiff(oldBody: string, newBody: string): string {
  const out: string[] = ["--- current PR description", "+++ proposed PR description"];
  for (const l of oldBody.split("\n")) out.push(`- ${l}`);
  out.push("~~~");
  for (const l of newBody.split("\n")) out.push(`+ ${l}`);
  return out.join("\n");
}

/** Run the read-only verdict engine for a thread. Performs NO writes. */
export async function runVerdict(s: ThreadRow, items: FeedbackItem[]): Promise<Verdict> {
  const isCi = s.authorClass === "ci";
  const [head, prBody] = await Promise.all([
    getPrHead(s.owner, s.repo, s.number),
    isCi ? Promise.resolve("") : getPrBody(s.owner, s.repo, s.number),
  ]);

  // For CI, materialize the failing log to a file OUTSIDE the worktree first.
  // `materializeCiLog` retries transient `gh`/network failures and THROWS if they
  // persist (→ recoverable `error`, re-driven next poll). A null return means the
  // run genuinely has no failed-step log to self-verify against, so escalate
  // (decision Q15) — a terminal `blocked` is correct only for that real case.
  let ciLogPath: string | null = null;
  if (isCi) {
    ciLogPath = await materializeCiLog(s);
    if (!ciLogPath) {
      const url = items[0]?.htmlUrl ?? "";
      return {
        action: "escalate",
        summary: `CI check failed but no failed-step log is available${url ? ` — see ${url}` : ""}.`,
        reply_draft: "",
        risk: "medium",
      };
    }
  }

  // Read-only investigation runs in a worktree on the PR head (not master), so
  // the agent sees the actual PR code. Torn down in `finally`.
  const { dir } = await addWorktree(s.owner, s.repo, head.headRefName, s.id);
  const blobBase = `https://github.com/${s.owner}/${s.repo}/blob/${head.headSha}`;
  try {
    // `result` only carries text on a `success` result; an `error_max_turns`
    // (etc.) result has none. So we ALSO accumulate the running assistant text —
    // the trailing JSON verdict is usually written before the turn cap is hit,
    // and that text is the only place it survives a non-success run.
    let last = "";
    let assistantText = "";
    let endSubtype = "";
    const { env, modelArn } = await sdkEnv();
    for await (const msg of query({
      prompt: isCi
        ? buildCiPrompt(s, items, blobBase, ciLogPath as string)
        : buildPrompt(s, items, blobBase, prBody),
      options: {
        cwd: dir,
        model: modelArn,
        systemPrompt: isCi ? CI_VERDICT_SYSTEM : VERDICT_SYSTEM,
        permissionMode: "dontAsk",
        allowedTools: ["Read", "Grep", "Glob", "Bash"],
        settingSources: [],
        env,
        // A CI failure means reading a large failing-check log AND investigating
        // source before deciding — that needs materially more turns than a
        // review-comment triage, which is usually localized to a few files.
        maxTurns: isCi ? 60 : 40,
        stderr: () => {},
      },
    })) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") assistantText += block.text;
        }
      } else if (msg.type === "result") {
        endSubtype = msg.subtype;
        if (msg.subtype === "success") last = msg.result;
      }
    }
    // Prefer the clean success result; otherwise fall back to whatever the agent
    // streamed (a max-turns run that still emitted the verdict block).
    const text = last || assistantText;
    if (!text.trim()) {
      // No usable output at all. Don't throw (a throw → `error` → re-run loop that
      // burns the turn budget again and again): degrade to a safe escalate so the
      // owner sees the failure and can act. CI is propose|escalate; reviews allow
      // escalate too, so this is valid for both.
      const url = items[0]?.htmlUrl ?? "";
      return {
        action: "escalate",
        summary: `Could not reach a verdict automatically (${endSubtype || "no result"})${url ? ` — see ${url}` : ""}.`,
        reply_draft: "",
        risk: "medium",
      };
    }
    let v: Verdict;
    try {
      v = parseVerdict(text, isCi);
    } catch (err) {
      // The agent ran but never emitted a parseable verdict block (often a
      // max-turns cutoff). Escalate with context rather than erroring out.
      const url = items[0]?.htmlUrl ?? "";
      return {
        action: "escalate",
        summary: `Investigation did not yield a parseable verdict (${endSubtype || "ended"})${url ? ` — see ${url}` : ""}.`,
        reply_draft: "",
        risk: "medium",
      };
    }
    // Attach a display diff for description amendments.
    if (v.action === "amend_pr_body" && v.proposed_body != null) {
      return { ...v, body_diff: bodyDiff(prBody, v.proposed_body) };
    }
    return v;
  } finally {
    await removeWorktree(s.owner, s.repo, s.id).catch(() => {});
  }
}
