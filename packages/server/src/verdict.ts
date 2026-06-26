import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "./config.js";
import { ensureClone } from "./worktrees.js";
import type { FeedbackItem, ThreadRow, Verdict } from "./types.js";
import { getPrHead } from "./gh.js";

const VERDICT_SYSTEM = `You triage code-review feedback on a pull request. You work in a read-only checkout of the PR branch. Investigate the actual code before deciding — never guess.

You MUST end your response with a single fenced JSON block (\`\`\`json ... \`\`\`) and nothing after it, matching:
{
  "action": "auto_fix" | "reply" | "escalate",
  "summary": "<one sentence: what the feedback wants and your decision>",
  "reply_draft": "<the reply to post on GitHub; for auto_fix this is the acknowledgement after the fix>",
  "risk": "low" | "medium" | "high"
}

Decision rules:
- auto_fix: a concrete code change is needed AND you are confident exactly what it is and that it is safe.
- reply: NO code change needed AND no human judgment needed — e.g. a bot false-positive (prove it by citing the file/lines that already handle the concern), a nit you can decline with reasoning, or a factual question with a clear answer.
- escalate: anything needing a decision — a design tradeoff, an ambiguous request, or a real bug whose fix is unclear or risky. Set escalate whenever you are unsure.

Author-class policy (provided to you):
- If author_class is "human" and the feedback needs NO code change (a decline/rebuttal), you MUST escalate — a human reviewer's pushback should be worded by the PR owner, not auto-replied.
- If author_class is "bot", you may reply autonomously to false-positives and nits.

For bot comments: do NOT dismiss as false-positive without verifying the current file state. When it IS a false positive, the reply_draft must cite specific paths/lines/code proving the concern is already handled.
Set risk:"high" for anything touching security or correctness — high risk forces escalation regardless of action.`;

function buildPrompt(s: ThreadRow, items: FeedbackItem[]): string {
  const lines: string[] = [];
  lines.push(`PR: ${s.prKey}`);
  lines.push(`Comment author_class: ${s.authorClass}`);
  lines.push(`Review/thread: ${s.threadKey}`);
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

function parseVerdict(text: string): Verdict {
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
  if (!["auto_fix", "reply", "escalate"].includes(action)) {
    throw new Error(`invalid verdict action: ${action}`);
  }
  let v: Verdict = {
    action,
    summary: String(obj.summary ?? ""),
    reply_draft: String(obj.reply_draft ?? ""),
    risk: ["low", "medium", "high"].includes(obj.risk) ? obj.risk : "medium",
  };
  // Enforce: high risk auto_fix → escalate (plan note).
  if (v.action === "auto_fix" && v.risk === "high") {
    v = { ...v, action: "escalate" };
  }
  return v;
}

/** Run the read-only verdict engine for a thread. Performs NO writes. */
export async function runVerdict(s: ThreadRow, items: FeedbackItem[]): Promise<Verdict> {
  const cfg = loadConfig();
  const head = await getPrHead(s.owner, s.repo, s.number);
  const { dir } = await ensureClone(s.owner, s.repo, head.headRefName);

  let last = "";
  for await (const msg of query({
    prompt: buildPrompt(s, items),
    options: {
      cwd: dir,
      model: cfg.model,
      systemPrompt: VERDICT_SYSTEM,
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Grep", "Glob", "Bash"],
      settingSources: [],
      maxTurns: 30,
      stderr: () => {},
    },
  })) {
    if (msg.type === "result" && msg.subtype === "success") {
      last = msg.result;
    }
  }
  if (!last) throw new Error("verdict run produced no result");
  return parseVerdict(last);
}
