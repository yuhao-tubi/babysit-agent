import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sdkEnv } from "./config.js";
import { addWorktree, removeWorktree } from "./worktrees.js";
import { getPrHead } from "./gh.js";
import { getPrOverview, updatePrOverview, logEvent } from "./db.js";
import type { PrOverview } from "./db.js";
import type { QuizQuestion } from "./types.js";
import { isIgnoredRepo } from "./classify.js";
import { repoQueue } from "./queue.js";
import { emit } from "./events.js";

/**
 * PR-comprehension QUIZ — a Session-level artifact (like the overview/risks)
 * that lives OUTSIDE the Thread/Verdict lifecycle. On-demand, read-only w.r.t.
 * GitHub (so `dryRun` does not gate it); the only persistence is the DB.
 *
 * One agent investigates the read-only checkout (fed the existing overview as
 * grounding context) and authors 3–6 multiple-choice questions that test whether
 * the reader really understands what the PR changes — a MIX of purpose/motivation
 * and change-mechanics, with wrong answers drawn from the OLD behavior or
 * plausible misreadings. Each question carries its correct-answer index and an
 * explanation; grading happens entirely client-side (no second agent round-trip).
 *
 * Delivery contract: the agent writes the quiz to a FIXED path in the worktree
 * (`overview/quiz.json`), and the server reads it back after the agent returns.
 * The agent has NO GitHub/push tools — the read-only guarantee is preserved.
 *
 * Staleness: the quiz stores the head sha it was built against; when the live PR
 * head moves the API treats the quiz as absent (served-as-stale) — a Regenerate
 * rebuilds it against the new head.
 */

/** Fixed worktree-relative path the agent writes and the server reads back. */
const QUIZ_FILE = join("overview", "quiz.json");

const QUIZ_SYSTEM = `You author a short MULTIPLE-CHOICE QUIZ that tests whether a reader truly understands a pull request. You work in a read-only checkout of the PR branch. Investigate the ACTUAL code before writing questions — never guess.

You are given the PR's existing overview (what it does + its traced blast radius) as context. Build on it — do NOT re-derive the diff understanding from scratch. GREP/GLOB/READ the checkout and \`git diff origin/master...HEAD\` to ground every question and every answer in real code.

# What makes a good quiz (the point: confirm real comprehension)
Write between 3 and 6 questions — FEWER for a small/trivial PR, up to 6 for a substantial one. Never fewer than 3. Mix TWO kinds:
- PURPOSE/motivation: why the PR exists, what problem it solves, the intended behavior change.
- CHANGE-MECHANICS: what a specific changed function/guard/branch now does, an edge case it handles, or a consequence for code that DEPENDS ON the change (the blast radius).
Favor mechanics questions — they test comprehension a title-skim cannot fake.

# Answer options (this is where the test lives)
Each question has 2–4 options and exactly ONE correct answer. Make the WRONG options genuinely plausible: draw them from the OLD (pre-PR) behavior, a common misreading of the diff, or an adjacent-but-wrong file/symbol. Avoid joke answers and obvious throwaways — a reader who only skimmed the title should be able to pick a wrong one. Vary which position the correct answer sits in.

# explanation
For each question write a 1–3 sentence explanation of WHY the correct answer is right (and, where useful, why a tempting wrong one is wrong), citing the specific file/symbol. This is shown to the reader AFTER they answer — it is the teaching moment.

# Output — write ${QUIZ_FILE}
Create the directory \`overview/\` if needed, then write EXACTLY a JSON ARRAY of question objects to ${QUIZ_FILE}:
[
  {
    "question": "<the question stem>",
    "options": ["<option A>", "<option B>", "<option C>"],
    "correctIndex": 1,                 // 0-based index into options of the correct answer
    "explanation": "<why the correct answer is right, citing file/symbol>"
  }
]
Write ONLY that file. Your final text message just states how many questions you wrote — the durable output is the FILE.`;

function buildQuizPrompt(pr: PrOverview): string {
  return [
    `PR: ${pr.prKey}`,
    `Title: ${pr.title}`,
    `Branch: ${pr.headRef}`,
    "",
    "Existing PR overview (context — build on it, do not repeat it):",
    "<<<OVERVIEW",
    pr.overviewMd || "(none)",
    "OVERVIEW",
    "",
    `Investigate the checkout, then write your grounded quiz array to ${QUIZ_FILE}.`,
  ].join("\n");
}

export interface QuizResult {
  quiz: QuizQuestion[];
  headSha: string;
  status: "ready" | "failed";
}

/**
 * Tolerantly parse the agent's `quiz.json` (an array of questions). Drops any
 * entry missing the required fields or with an out-of-range `correctIndex`;
 * returns `[]` on malformed / non-array JSON (which drives a `failed` status).
 */
export function parseQuizFile(raw: string): QuizQuestion[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: QuizQuestion[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const o = e as any;
    if (
      typeof o.question !== "string" || !o.question.trim() ||
      !Array.isArray(o.options) || o.options.length < 2 || o.options.length > 4 ||
      !o.options.every((x: unknown) => typeof x === "string" && x.trim()) ||
      typeof o.correctIndex !== "number" ||
      !Number.isInteger(o.correctIndex) ||
      o.correctIndex < 0 || o.correctIndex >= o.options.length ||
      typeof o.explanation !== "string"
    ) {
      continue;
    }
    out.push({
      question: o.question,
      options: o.options,
      correctIndex: o.correctIndex,
      explanation: o.explanation,
    });
  }
  return out;
}

/**
 * Run the read-only quiz investigation for a PR and persist the artifact.
 * Performs NO GitHub writes. A run that yields no usable question ⇒ `failed`
 * (the daemon is never crashed — the caller records `failed` on the row).
 */
export async function generateQuiz(prKey: string): Promise<QuizResult> {
  const pr = getPrOverview(prKey);
  if (!pr) throw new Error(`no PR ${prKey}`);
  const cfg = loadConfig();

  const head = await getPrHead(pr.owner, pr.repo, pr.number);
  const wtKey = -pr.number;
  const { dir } = await addWorktree(pr.owner, pr.repo, head.headRefName, wtKey, {
    skipDeps: true,
  });
  try {
    let endSubtype = "";
    const { env, modelArn } = await sdkEnv();
    for await (const msg of query({
      prompt: buildQuizPrompt(pr),
      options: {
        cwd: dir,
        model: modelArn,
        systemPrompt: QUIZ_SYSTEM,
        permissionMode: "dontAsk",
        // Write lets the agent author quiz.json in the ephemeral worktree; it has
        // NO gh/push tool — GitHub stays untouched.
        allowedTools: ["Read", "Grep", "Glob", "Bash", "Write"],
        settingSources: [],
        env,
        maxTurns: cfg.overview.maxTurns,
        stderr: () => {},
      },
    })) {
      if (msg.type === "result") endSubtype = msg.subtype;
    }

    const quizPath = join(dir, QUIZ_FILE);
    let quiz: QuizQuestion[] = [];
    if (existsSync(quizPath)) {
      try {
        quiz = parseQuizFile(readFileSync(quizPath, "utf8"));
      } catch {
        quiz = [];
      }
    }
    if (quiz.length === 0) {
      const reason = existsSync(quizPath)
        ? `quiz at ${quizPath} was empty or malformed`
        : `agent ended '${endSubtype || "no result"}' but wrote no quiz at ${quizPath}`;
      logEvent(null, "quiz_error", `${prKey}: ${reason}`);
      const result: QuizResult = { quiz: [], headSha: head.headSha, status: "failed" };
      persist(prKey, result);
      return result;
    }

    const result: QuizResult = { quiz, headSha: head.headSha, status: "ready" };
    persist(prKey, result);
    return result;
  } finally {
    await removeWorktree(pr.owner, pr.repo, wtKey).catch(() => {});
  }
}

/** Persist the quiz artifact (questions + head sha + status). */
function persist(prKey: string, r: QuizResult): void {
  updatePrOverview(prKey, {
    quiz: r.quiz,
    quizStatus: r.status,
    quizHeadSha: r.headSha,
  });
}

/** PRs with a quiz generation currently running — the in-flight double-click guard. */
const inFlight = new Set<string>();

/**
 * Fire-and-forget entry point for the API/dashboard: mark the PR quiz
 * `generating`, run generation inside the shared per-repo SerialQueue (worktree
 * collision-safety), and emit `pr_quiz_updated` around it. Requires an existing
 * overview (the quiz is grounded on it). Never throws to the caller — failures
 * land on the row as `failed`.
 */
export function requestQuiz(prKey: string): { ok: boolean; reason?: string } {
  const cfg = loadConfig();
  if (!cfg.overview.enabled) return { ok: false, reason: "overview feature disabled" };
  const pr = getPrOverview(prKey);
  if (!pr) return { ok: false, reason: "no such PR" };
  if (isIgnoredRepo(pr.owner, pr.repo)) return { ok: false, reason: "repo not in scope" };
  if (!pr.overviewMd) return { ok: false, reason: "generate an overview first" };
  if (inFlight.has(prKey) || pr.quizStatus === "generating") {
    return { ok: false, reason: "already generating" };
  }

  inFlight.add(prKey);
  updatePrOverview(prKey, { quizStatus: "generating" });
  logEvent(null, "quiz", `${prKey}: generating…`);
  emit({ type: "pr_quiz_updated", prKey });

  void repoQueue.run(`${pr.owner}/${pr.repo}`, async () => {
    try {
      const r = await generateQuiz(prKey);
      logEvent(null, "quiz", `${prKey}: ${r.status} (questions=${r.quiz.length})`);
    } catch (err: any) {
      updatePrOverview(prKey, { quizStatus: "failed" });
      logEvent(null, "quiz_error", `${prKey}: ${err?.message ?? String(err)}`);
    } finally {
      inFlight.delete(prKey);
      emit({ type: "pr_quiz_updated", prKey });
    }
  });
  return { ok: true };
}
