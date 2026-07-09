import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sdkEnv } from "./config.js";
import type { RiskCandidate, RiskItem, RiskLevel, RiskVerdictRecord } from "./types.js";

const LEVELS: RiskLevel[] = ["low", "medium", "high"];
const isLevel = (v: unknown): v is RiskLevel => LEVELS.includes(v as RiskLevel);

/**
 * Tolerantly parse the finder's `risks.json` (an array of candidates). Returns
 * `[]` on malformed / non-array JSON (which drives a `failed` status upstream)
 * and drops any entry missing the required grounded fields (id / title / level /
 * location{path,startLine,permalink} / explanation / codeSnippet). Optional
 * `category`, `endLine`, and `mermaid` are passed through when present.
 */
export function parseRisksFile(raw: string): RiskCandidate[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: RiskCandidate[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const o = e as any;
    const loc = o.location;
    if (
      typeof o.id !== "string" || !o.id.trim() ||
      typeof o.title !== "string" || !o.title.trim() ||
      !isLevel(o.level) ||
      !loc || typeof loc !== "object" ||
      typeof loc.path !== "string" || !loc.path.trim() ||
      typeof loc.startLine !== "number" ||
      typeof loc.permalink !== "string" || !loc.permalink.trim() ||
      typeof o.explanation !== "string" ||
      typeof o.codeSnippet !== "string"
    ) {
      continue;
    }
    const c: RiskCandidate = {
      id: o.id,
      title: o.title,
      level: o.level,
      location: {
        path: loc.path,
        startLine: loc.startLine,
        ...(typeof loc.endLine === "number" ? { endLine: loc.endLine } : {}),
        permalink: loc.permalink,
      },
      explanation: o.explanation,
      codeSnippet: o.codeSnippet,
    };
    if (typeof o.category === "string" && o.category.trim()) c.category = o.category;
    if (typeof o.mermaid === "string" && o.mermaid.trim()) c.mermaid = o.mermaid;
    out.push(c);
  }
  return out;
}

/**
 * Tolerantly parse the confirmer's verdict-only records. Returns `[]` on
 * malformed JSON — the caller then merges against `[]`, leaving every finder
 * risk `unverified` (the confirmer-failure degradation). Drops records missing
 * `id` or a boolean `confirmed`; an optional `level` override is kept only when
 * it is a valid level.
 */
export function parseVerdictsFile(raw: string): RiskVerdictRecord[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: RiskVerdictRecord[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const o = e as any;
    if (typeof o.id !== "string" || !o.id.trim() || typeof o.confirmed !== "boolean") continue;
    const rec: RiskVerdictRecord = {
      id: o.id,
      confirmed: o.confirmed,
      rationale: typeof o.rationale === "string" ? o.rationale : "",
    };
    if (isLevel(o.level)) rec.level = o.level;
    out.push(rec);
  }
  return out;
}

/**
 * Merge the confirmer's verdict-only records onto the finder's candidates by
 * `id` (see CONTEXT.md — the risk-analysis confirmation pass). The finder is the
 * sole author of the heavy content (explanation / diff / mermaid); the confirmer
 * only judges. This is a pure function — the unit-testable heart of the feature.
 */
export function mergeRiskVerdicts(
  candidates: RiskCandidate[],
  records: RiskVerdictRecord[]
): RiskItem[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const merged: RiskItem[] = candidates.map((c) => {
    const rec = byId.get(c.id);
    if (!rec) return { ...c, state: "unverified" };
    return {
      ...c,
      level: rec.level ?? c.level,
      state: rec.confirmed ? "confirmed" : "dismissed",
      verdict: { confirmed: rec.confirmed, rationale: rec.rationale },
    };
  });
  // Sort high → medium → low by the effective (possibly overridden) level.
  // Stable within a level, so the finder's ordering is preserved for ties.
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return merged
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank[a.r.level] - rank[b.r.level] || a.i - b.i)
    .map(({ r }) => r);
}

// ---------------------------------------------------------------------------
// Agent passes — finder → confirmer, run in a worktree ALREADY provisioned by
// the overview generation (they share the checkout). Both are read-only w.r.t.
// GitHub (no push/gh tools). File-based delivery: the finder writes
// `overview/risks.json`, the confirmer writes `overview/risks-confirmed.json`,
// and the server reads them back (heavy diff/mermaid content never round-trips
// through the token stream).
// ---------------------------------------------------------------------------

/** Fixed worktree-relative paths the risk passes write and the server reads. */
const RISKS_FILE = join("overview", "risks.json");
const VERDICTS_FILE = join("overview", "risks-confirmed.json");

const FINDER_SYSTEM = `You are a senior reviewer performing VERIFIED RISK ANALYSIS on a pull request you were asked to REVIEW. You work in a read-only checkout of the PR branch. Investigate the ACTUAL code before deciding — never guess.

You are given the PR's overview (what it does + its traced blast radius) as context. Build on it — do NOT re-derive the diff understanding. Your job: surface the handful of risks a reviewer MUST scrutinize, each grounded in real code.

# What counts as a risk
A concrete way the change could be wrong or harmful: a correctness bug, a security hole, a concurrency hazard, a broken edge case, a performance cliff, a breaking API change to a traced dependent. NOT style nits, NOT speculation. Rank by severity and surface only the ones that matter — aim for the top 5-7 at most; omit trivia entirely. A genuinely clean PR can have ZERO risks.

# Grounding (mandatory)
Investigate with Read/Grep/Glob/Bash and \`git diff origin/master...HEAD\`. For each risk cite the exact file and line(s) you read. Build the permalink from the provided blob base URL pinned to the PR head: <base>/<path>#L<line> (or #L<start>-L<end>).

# codeSnippet
Prefer the actual PR DIFF hunk around the risky lines (a fenced \`\`\`diff block with the +/- lines). If the risk is about pre-existing code the PR interacts with (not itself changed), include that code as a plain fenced block instead. Keep it tight — just the lines that show the risk.

# mermaid (optional)
When a risk involves a FLOW worth relating (≥3 steps/states/actors — e.g. a race, a call chain, a broken state transition), author a small mermaid diagram source that explains it. You will NOT see it rendered, so keep the syntax simple and valid (flowchart TD / sequenceDiagram). Omit mermaid for a trivial one-line risk.

# Output — write ${RISKS_FILE}
Create the directory \`overview/\` if needed, then write EXACTLY a JSON ARRAY of risk objects to ${RISKS_FILE}:
[
  {
    "id": "risk-1",                          // unique within this file
    "title": "<one-line risk headline>",
    "level": "high" | "medium" | "low",      // severity
    "category": "correctness|security|concurrency|performance|api|other",
    "location": { "path": "<repo-relative>", "startLine": <n>, "endLine": <n?>, "permalink": "<base>/<path>#L<n>" },
    "explanation": "<markdown: what the risk is and why it matters>",
    "codeSnippet": "<fenced \`\`\`diff hunk (preferred) or plain code>",
    "mermaid": "<optional mermaid source; omit if it does not earn one>"
  }
]
Write ONLY that file. If there are no real risks, write \`[]\`. Your final text message just states how many risks you wrote — the durable output is the FILE.`;

const CONFIRMER_SYSTEM = `You are an ADVERSARIAL verifier. Another agent proposed a list of risks about a pull request; your job is to CONFIRM or DISMISS each one against the REAL code in this read-only checkout. Never guess — investigate.

You are given the candidate risks (with their file/line citations). For EACH risk, re-investigate with Read/Grep/Glob/Bash and \`git diff origin/master...HEAD\`:
- CONFIRM (confirmed: true) only if the risk is real — cite why, referencing the file/lines.
- DISMISS (confirmed: false) if it is a false positive — you MUST cite the specific file/lines that already handle the concern (a guard, a validation, a type, existing coverage). A hand-wavy dismissal is not allowed.
- You MAY adjust the severity via "level" if the finder over- or under-rated it (only when you have grounded reason to).
Default to CONFIRM when genuinely uncertain — it is safer to show the reviewer a risk than to hide it.

# Output — write ${VERDICTS_FILE}
Write EXACTLY a JSON ARRAY of verdict records to ${VERDICTS_FILE}, one per candidate risk, keyed by the finder's "id":
[
  { "id": "risk-1", "confirmed": true, "level": "high", "rationale": "<grounded: cite file:line>" }
]
Include "level" ONLY when you are overriding the finder's severity. Write ONLY that file. Your final text message just states your confirm/dismiss counts.`;

function buildFinderPrompt(prKey: string, title: string, blobBase: string, overviewMd: string): string {
  return [
    `PR: ${prKey}`,
    `Title: ${title}`,
    `Repo blob base URL (pinned to PR head): ${blobBase}`,
    `  Build permalinks as <base>/<path>#L<line>, e.g. ${blobBase}/src/index.ts#L42`,
    "",
    "PR overview (context — build on it, do not repeat it):",
    "<<<OVERVIEW",
    overviewMd || "(none)",
    "OVERVIEW",
    "",
    `Investigate the checkout, then write your grounded risk array to ${RISKS_FILE}.`,
  ].join("\n");
}

function buildConfirmerPrompt(prKey: string, blobBase: string, candidatesJson: string): string {
  return [
    `PR: ${prKey}`,
    `Repo blob base URL (pinned to PR head): ${blobBase}`,
    "",
    "Candidate risks to verify (from the finder):",
    "<<<CANDIDATES",
    candidatesJson,
    "CANDIDATES",
    "",
    `Re-investigate each in the checkout, then write your verdict array to ${VERDICTS_FILE}.`,
  ].join("\n");
}

/**
 * Run the finder→confirmer risk analysis in an ALREADY-PROVISIONED read-only
 * worktree (`dir`) — the same checkout the overview was generated in. Returns the
 * merged, display-ready RiskItem[] and a status:
 *   - `ready` with risks (incl. an empty [] for a genuinely clean PR),
 *   - `failed` when the finder produced no usable `risks.json`.
 * A CONFIRMER failure degrades gracefully: the finder's risks are returned as
 * `unverified` (via merge against []) and status stays `ready`. Performs NO
 * GitHub writes.
 */
export async function analyzeRisks(opts: {
  dir: string;
  prKey: string;
  title: string;
  blobBase: string;
  overviewMd: string;
  maxTurns: number;
}): Promise<{ risks: RiskItem[]; status: "ready" | "failed" }> {
  const { dir, prKey, title, blobBase, overviewMd, maxTurns } = opts;
  const { env, modelArn } = await sdkEnv();

  // --- Finder pass ---
  await runAgent({
    dir,
    env,
    modelArn,
    maxTurns,
    system: FINDER_SYSTEM,
    prompt: buildFinderPrompt(prKey, title, blobBase, overviewMd),
    allowWrite: true,
  });

  const risksPath = join(dir, RISKS_FILE);
  if (!existsSync(risksPath)) return { risks: [], status: "failed" };
  let candidates: RiskCandidate[];
  try {
    candidates = parseRisksFile(readFileSync(risksPath, "utf8"));
  } catch {
    return { risks: [], status: "failed" };
  }
  // Zero real risks is a valid, "ready" answer — no confirmer pass needed.
  if (candidates.length === 0) return { risks: [], status: "ready" };

  // --- Confirmer pass (best-effort; failure ⇒ all unverified, still ready) ---
  let records: RiskVerdictRecord[] = [];
  try {
    await runAgent({
      dir,
      env,
      modelArn,
      maxTurns,
      system: CONFIRMER_SYSTEM,
      prompt: buildConfirmerPrompt(prKey, blobBase, JSON.stringify(candidates, null, 2)),
      allowWrite: true,
    });
    const vPath = join(dir, VERDICTS_FILE);
    if (existsSync(vPath)) records = parseVerdictsFile(readFileSync(vPath, "utf8"));
  } catch {
    records = [];
  }

  return { risks: mergeRiskVerdicts(candidates, records), status: "ready" };
}

/** Drive one read-only agent turn to completion; the durable output is on disk. */
async function runAgent(opts: {
  dir: string;
  env: Record<string, string>;
  modelArn: string;
  maxTurns: number;
  system: string;
  prompt: string;
  allowWrite: boolean;
}): Promise<void> {
  const tools = ["Read", "Grep", "Glob", "Bash", ...(opts.allowWrite ? ["Write"] : [])];
  for await (const msg of query({
    prompt: opts.prompt,
    options: {
      cwd: opts.dir,
      model: opts.modelArn,
      systemPrompt: opts.system,
      permissionMode: "dontAsk",
      allowedTools: tools,
      settingSources: [],
      env: opts.env,
      maxTurns: opts.maxTurns,
      stderr: () => {},
    },
  })) {
    void msg;
  }
}
