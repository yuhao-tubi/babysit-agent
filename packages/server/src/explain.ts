import { query } from "@anthropic-ai/claude-agent-sdk";
import { agentGuardHooks } from "./agent-guard.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_EFFORT, loadConfig, sdkEnv } from "./config.js";
import { isIgnoredRepo } from "./classify.js";
import { getPrHead } from "./gh.js";
import { getThread, getThreadItems, isPrExpired, logEvent, updateThread } from "./db.js";
import { emit } from "./events.js";
import { overviewQueue } from "./queue.js";
import { addWorktree, removeWorktree } from "./worktrees.js";
import type { ExplanationStatus, FeedbackItem, ThreadRow } from "./types.js";

/**
 * The Explanation artifact (see CONTEXT.md). A read-only, on-demand markdown doc
 * that answers the question raised in a Thread — the reviewer's, or the owner's
 * own note-to-self (both are Threads). It is decision support for the OWNER: it
 * is never posted to GitHub, so it needs no gate, no Proposal, and no Approve.
 *
 * Deliberately NOT a `VerdictAction`: every action ends in a GitHub mutation, and
 * this one mutates nothing. It is modeled on the other read-only owner-facing
 * artifacts (`overview.ts` / `risks.ts` / `quiz.ts`) — own status column, own
 * head-sha, in-flight double-click guard, `overviewQueue`, SSE event.
 *
 * The agent's output format is a MARKDOWN FILE (`explanation.md`) rather than
 * JSON: the payload is one long prose document with fenced mermaid, and making a
 * model escape newlines/quotes/backticks through a JSON string over that span is
 * the fragile part of `verdict.ts`'s scrape. There is exactly one document per
 * run, so none of `risks.json`'s per-item structure earns its keep here.
 */

/** Filename the agent writes inside the worktree. Read back, then discarded. */
const EXPLANATION_FILE = "explanation.md";

/**
 * Worktree key for an Explanation run. A worktree lives at
 * `worktrees/<owner>__<repo>/<key>`, and `addWorktree` wipes that path before
 * checking out — so the key namespace is load-bearing, not cosmetic:
 *   -  positive `threadId`  → Thread pipeline (verdict / fix), on `repoQueue`
 *   -  `-pr.number`         → PR-level read-only artifacts (overview/risks/quiz)
 *   -  this offset range    → per-Thread Explanations
 * Explain runs on `overviewQueue`, which is deliberately concurrent with
 * `repoQueue` (see queue.ts), so colliding with either of the first two ranges
 * would delete a live checkout out from under a running agent.
 */
export function explainWorktreeKey(threadId: number): number {
  return -1_000_000 - threadId;
}

const EXPLAIN_SYSTEM = `You explain code to the ENGINEER WHO WROTE IT, on a read-only checkout of their own PR branch.

Your job is to answer ONE question well — not to review the code, not to propose changes, not to draft a reply to anyone. The reader is the PR author sitting at their dashboard.

GROUNDING IS MANDATORY. You are explaining real code, so every claim about how the code behaves must cite the code you read:
- Investigate with Read/Grep/Glob BEFORE writing. Never explain from the question text alone.
- Cite specific lines as markdown links using the provided blob base URL: [file.ts:123](<blobBase>/path/to/file.ts#L123). At least one such citation is REQUIRED — a document with none is discarded by the harness.
- Use the REAL names in the checkout (functions, files, components). Never invent an abstraction to make the story tidy.
- If the checkout does not answer the question, SAY SO plainly and explain what you did find. Speculation presented as fact is the one unacceptable outcome.
- Every citation must actually SUPPORT the claim it sits next to. Never add a citation merely to satisfy the requirement above — if you have nothing real to cite, say the checkout does not answer the question and cite nothing.

FORMAT. Write GitHub-flavored markdown to a file named exactly "explanation.md" in the current working directory (use the Write tool). Lead with the direct answer in the first paragraph — the reader may stop there. Then the supporting detail.

DIAGRAMS. You MAY embed mermaid in fenced \`\`\`mermaid blocks; they are rendered in the dashboard. Include one ONLY when the shape of the thing is what makes it hard (a sequence across components, a state machine, a branching flow). A diagram on a linear answer is noise — most explanations need none. Every node must correspond to something real in the checkout. Keep mermaid syntax simple and valid; prefer few nodes over many.

Do NOT write any file other than explanation.md. Do NOT modify the checkout.`;

/**
 * Build the explain prompt. With no owner question this answers the question
 * raised in the Thread's feedback; with one, the owner's question governs and the
 * feedback stays as context (so "explain the retry ledger instead" works on a
 * Thread that was about something else).
 */
export function buildExplainPrompt(
  s: ThreadRow,
  items: FeedbackItem[],
  blobBase: string,
  question: string | null
): string {
  const lines: string[] = [];
  lines.push(`PR: ${s.prKey}`);
  lines.push(`Thread: ${s.threadKey}  (author_class: ${s.authorClass})`);
  lines.push(`Repo blob base URL (pinned to the PR head you are checked out on): ${blobBase}`);
  lines.push(`  Cite code as [<file>:<line>](<base>/<path>#L<line>), e.g. [html5.ts:2726](${blobBase}/packages/player/src/adapters/html5.ts#L2726)`);
  lines.push("");

  lines.push("Feedback in this thread:");
  for (const it of items) {
    lines.push("---");
    lines.push(`author: ${it.author} (${it.authorType})  kind: ${it.kind}`);
    if (it.path) lines.push(`location: ${it.path}${it.line ? `:${it.line}` : ""}`);
    lines.push(`body:\n${it.body}`);
  }
  lines.push("---");
  lines.push("");

  if (question) {
    lines.push("The PR author asks THIS — it governs, and takes precedence over the thread's own topic:");
    lines.push("<<<QUESTION");
    lines.push(question);
    lines.push("QUESTION");
    lines.push("");
    lines.push(
      `Investigate this checkout and answer that question. Write the answer to ${EXPLANATION_FILE}.`
    );
  } else {
    lines.push(
      `Investigate this checkout and explain the question raised in the feedback above — what the honest answer is and why, grounded in the real code. Note that the thread's author may be the PR author themselves (a note-to-self), in which case there is no reviewer to satisfy: just answer the question. Write the answer to ${EXPLANATION_FILE}.`
    );
  }
  return lines.join("\n");
}

/**
 * Whether a generated explanation is GROUNDED enough to store: it must cite at
 * least one line-anchored permalink into THIS checkout's blob base.
 *
 * This is the mechanical floor under the prompt's grounding rules, and it exists
 * because an explanation is the easiest artifact in this system to get
 * convincingly wrong — a confident mermaid chart reads as authoritative whether
 * or not it matches the code. `RiskCandidate` gets this for free (its parser drops
 * candidates missing `location`); a bare markdown doc has no schema, so we check
 * the one property that makes a claim checkable: a link the owner can click to
 * see the code the claim rests on. Requiring the sha-pinned base (not just any
 * GitHub URL) means a citation into some other tree does not count.
 */
export function isGrounded(md: string, blobBase: string): boolean {
  if (!md.trim()) return false;
  // `#L<n>` is the load-bearing part: a bare blob link doesn't say WHICH code
  // backs the claim. Escape the base — it contains `/` and `.` regex meta.
  const escaped = blobBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}/\\S*#L\\d+`).test(md);
}

/** PRs/Threads with an explanation run in flight — the double-click guard. */
const inFlight = new Set<number>();

/**
 * Fire-and-forget entry point for the dashboard. Marks the Thread's explanation
 * `generating`, then runs generation on the `overviewQueue` — NOT the repo queue:
 * this is artifact generation, and it must never sit in front of an owner's
 * Approve (see queue.ts). Returns immediately; the panel updates over SSE.
 */
export function requestExplanation(
  threadId: number,
  question?: string
): { ok: boolean; reason?: string } {
  const cfg = loadConfig();
  if (!cfg.explain.enabled) return { ok: false, reason: "explain feature disabled" };
  const s = getThread(threadId);
  if (!s) return { ok: false, reason: "no such thread" };
  // Repo scope is enforced HERE, not just in the poller (a guardrail: the pipeline
  // re-checks it), so a thread stored before a repo was ignored can't be worked.
  if (isIgnoredRepo(s.owner, s.repo)) return { ok: false, reason: "repo not in scope" };
  // An expired (merged/closed) PR is read-only history: its branch may be deleted,
  // so `getPrHead`/`addWorktree` would fail after burning a full agent run.
  if (isPrExpired(s.prKey)) return { ok: false, reason: "PR is merged/closed" };
  if (inFlight.has(threadId) || s.explanationStatus === "generating") {
    return { ok: false, reason: "already generating" };
  }

  const q = question?.trim() || null;
  inFlight.add(threadId);
  // Clear the previous doc as we start: a follow-up question REPLACES the answer
  // (one-shot artifact, no transcript), and showing the old answer under a new
  // question would misattribute it.
  updateThread(threadId, {
    explanationStatus: "generating",
    explanationMd: null,
    explanationQuestion: q,
  });
  logEvent(threadId, "explanation", q ? `generating… (asked: ${q})` : "generating…");
  emit({ type: "thread_updated", threadId });

  void overviewQueue.run(`${s.owner}/${s.repo}`, async () => {
    try {
      const r = await generateExplanation(threadId, q);
      logEvent(threadId, "explanation", r.status);
    } catch (err: any) {
      // Never crash the daemon — a failed run lands `failed`, which the panel
      // renders as a re-clickable Explain.
      updateThread(threadId, { explanationStatus: "failed" });
      logEvent(threadId, "explanation", `failed: ${err?.message ?? err}`);
      emit({ type: "thread_updated", threadId });
    } finally {
      inFlight.delete(threadId);
    }
  });

  return { ok: true };
}

/**
 * Run the explain agent for a Thread and persist the doc + the head it was built
 * against. Provisions its own read-only worktree with `skipDeps` — the agent only
 * Reads/Greps/Globs to ground the answer; it never builds or tests, so a
 * multi-GB dep copy would be pure waste (matches verdict/overview/risks/quiz).
 * Torn down in `finally`.
 */
export async function generateExplanation(
  threadId: number,
  question: string | null
): Promise<{ status: ExplanationStatus; headSha: string }> {
  const s = getThread(threadId);
  if (!s) throw new Error(`no thread #${threadId}`);
  const cfg = loadConfig();
  const items = getThreadItems(threadId);

  const head = await getPrHead(s.owner, s.repo, s.number);
  const blobBase = `https://github.com/${s.owner}/${s.repo}/blob/${head.headSha}`;
  // Author-facing reasoning about the owner's own PR → the default model, like
  // author Blind spots. The faster `reviewerModelName` is for reviewer artifacts.
  const { env, modelArn } = await sdkEnv();

  // The worktree key must NOT be the Thread id. A worktree path is keyed solely
  // by that number (`worktrees/<owner>__<repo>/<key>`) and `addWorktree` clears
  // whatever sits at the path first — so reusing `s.id` would delete the live
  // checkout of a verdict/fix running for the SAME Thread under `repoQueue`,
  // which now runs concurrently with `overviewQueue`. Every other read-only
  // artifact avoids this with a negative PR-level key; ours must be distinct from
  // those too (an Explanation can run while an overview/quiz/blind-spot run is in
  // flight on the same PR), hence a separate negative namespace.
  const wtKey = explainWorktreeKey(threadId);
  const { dir } = await addWorktree(s.owner, s.repo, head.headRefName, wtKey, {
    skipDeps: true,
  });
  try {
    for await (const msg of query({
      prompt: buildExplainPrompt(s, items, blobBase, question),
      options: {
        cwd: dir,
        model: modelArn,
        systemPrompt: EXPLAIN_SYSTEM,
        permissionMode: "dontAsk",
        // Same tool set as the other read-only artifact agents (quiz.ts, and the
        // risks finder). `Bash` earns its place for grounding — `git log`/`git
        // blame` on the checkout explain WHY code is the way it is, which is often
        // the actual answer. `Write` is for explanation.md. Nothing here reaches
        // GitHub: the worktree is a throwaway that `finally` deletes, and this
        // module has no push/comment path (unlike the executor).
        allowedTools: ["Read", "Grep", "Glob", "Bash", "Write"],
        effort: ARTIFACT_EFFORT,
        ...agentGuardHooks(dir),
        settingSources: [],
        env,
        maxTurns: cfg.explain.maxTurns,
        stderr: () => {},
      },
    })) {
      void msg;
    }

    const path = join(dir, EXPLANATION_FILE);
    const md = existsSync(path) ? readFileSync(path, "utf8") : "";
    // No file, empty file, or no citation → `failed`. Storing an ungrounded
    // explanation is worse than storing none: it reads as authoritative.
    const status: ExplanationStatus = isGrounded(md, blobBase) ? "ready" : "failed";
    updateThread(threadId, {
      explanationStatus: status,
      explanationMd: status === "ready" ? md : null,
      explanationHeadSha: head.headSha,
      // Recorded HERE as well as in `requestExplanation` so the doc and the
      // question it answers always agree — callers that bypass the request path
      // (the CLI) would otherwise leave a stale/absent question beside a new doc.
      explanationQuestion: question,
    });
    emit({ type: "thread_updated", threadId });
    return { status, headSha: head.headSha };
  } finally {
    await removeWorktree(s.owner, s.repo, wtKey).catch(() => {});
  }
}
