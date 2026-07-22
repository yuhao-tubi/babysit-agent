import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sdkEnv } from "./config.js";
import { addWorktree, removeWorktree } from "./worktrees.js";
import { getPrHead, getPrBody } from "./gh.js";
import { getPrOverview, updatePrOverview, logEvent } from "./db.js";
import type { RiskStatus } from "./db.js";
import { isIgnoredRepo } from "./classify.js";
import { repoQueue } from "./queue.js";
import { emit } from "./events.js";
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
    if (typeof o.layer === "string" && o.layer.trim()) c.layer = o.layer;
    if (typeof o.inDescription === "boolean") c.inDescription = o.inDescription;
    if (typeof o.mermaid === "string" && o.mermaid.trim()) c.mermaid = o.mermaid;
    out.push(c);
  }
  return out;
}

/**
 * Author Blind spots track their own head-sha (`risks_head_sha`), decoupled from
 * the overview (see the PR-resources spec: an author branch moves constantly, so
 * a Blind spot shown against a stale sha is actively misleading). A finding is
 * stale — and the panel should prompt a Regenerate rather than serve it — when
 * the analyzed head differs from the live head. We can only PROVE drift when
 * BOTH shas are known: no analysis head (never analyzed, or a reviewer risk that
 * piggybacks the overview) or an unknown live head ⇒ not stale.
 */
export function blindSpotsStale(
  risksHeadSha: string | null | undefined,
  liveHeadSha: string | null | undefined
): boolean {
  return !!risksHeadSha && !!liveHeadSha && risksHeadSha !== liveHeadSha;
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

/**
 * Author-role Blind-spot finder (see CONTEXT.md). Same finder→confirmer engine,
 * but the framing changes: this is the AUTHOR's own PR, harm-hunting is primary,
 * the PR body is an advisory lens, and findings are layer-tagged with a two-part
 * materiality bar (invisible-at-PR-time AND manifests-at-a-distance).
 */
const AUTHOR_FINDER_SYSTEM = `You are reviewing the AUTHOR's OWN pull request to surface BLIND SPOTS — behaviors their change causes that they may not have intended or considered. You work in a read-only checkout of the PR branch. Investigate the ACTUAL code before deciding — never guess.

You are given the PR's overview (what it does + its traced blast radius) as context, and the author's PR description as their CLAIMED SCOPE. Build on the overview — do not re-derive the diff.

# What counts as a Blind spot — the TWO-PART materiality bar (BOTH required)
A finding qualifies ONLY IF a wrong answer to its intent-question would cause harm that is:
1. INVISIBLE AT PR TIME — not caught by CI or by reading this diff (a green build + right-looking diff still ships it). This EXCLUDES style/type-cast/naming nits (visible in the diff) and CI-catchable bugs (the gate handles those).
2. MANIFESTS AWAY FROM THE CHANGE — the harm surfaces somewhere the author isn't looking: a dashboard, an experiment readout, a downstream data consumer, or a different code path — days/weeks later. This is the "drift-to-a-distance" signature.
A plain in-diff bug (an off-by-one in the changed function itself) FAILS part 2 → out of scope; other tools cover those. Stay narrowly on drift that escapes to a distance.

# Priority harm classes (guidance, not fixed buckets — fire where relevant, ignore where not)
- Query / data health: a downstream query breaks — a field that can now be null, a type/cardinality change, a column a consumer depends on.
- Metric fidelity: an event fires but won't reflect truth — fires on render not action, counts retries, no dedup, wrong grain (per-session vs per-user).
- Experiment integrity: exposure logged before/outside the gate check (pollutes unenrolled users), control path mutated, wrong bucketing key, treatment leaks into holdout.

# Layer split (do this FIRST, in your head)
Partition the diff into ITS OWN layers — a www PR might be analytics / experiment / UI-UX / logic; another repo surfaces different ones. YOU name the layers from the code; nothing is hardcoded. Then hunt each layer. Tag every finding with its "layer".

# Every finding is fact + fact + question (never a verdict)
Decompose each Blind spot into: (fact) the code does X at file:line, (fact) X has downstream consequence Y, (question) did you intend X? Phrase "explanation" as a why-it-matters chain ending in a QUESTION ("…so it counts views after the API returns, not on tap. Intended?"). NEVER assert intent is wrong — you cannot see the author's head, only the code.

# Grounding (mandatory)
Investigate with Read/Grep/Glob/Bash and \`git diff origin/master...HEAD\`. Cite exact file/line(s). Build permalinks from the blob base pinned to the PR head: <base>/<path>#L<line>.

# Output — write ${RISKS_FILE}
Create \`overview/\` if needed, then write EXACTLY a JSON ARRAY:
[
  {
    "id": "blindspot-1",
    "title": "<one-line headline, phrased as the behavior>",
    "level": "high" | "medium" | "low",
    "layer": "<the layer you derived, e.g. analytics>",
    "inDescription": true | false,                 // did the PR description claim this behavior?
    "category": "query|metric|experiment|logic|other",
    "location": { "path": "<repo-relative>", "startLine": <n>, "endLine": <n?>, "permalink": "<base>/<path>#L<n>" },
    "explanation": "<why-it-matters chain ending in an intent QUESTION>",
    "codeSnippet": "<fenced \`\`\`diff hunk (preferred) or plain code>",
    "mermaid": "<optional; only for a ≥3-step flow>"
  }
]
Write ONLY that file. If the change has no genuine blind spots, write \`[]\`. Your final text message just states how many you wrote.`;

const AUTHOR_CONFIRMER_SYSTEM = `You are an ADVERSARIAL verifier of BLIND SPOTS raised about an author's own pull request. Confirm or dismiss each against the REAL code in this read-only checkout. Never guess — investigate.

For EACH candidate, re-investigate with Read/Grep/Glob/Bash and \`git diff origin/master...HEAD\`. A blind spot survives ONLY if BOTH hold:
- Its FACTS are real: the code does X (cite file:line), and X genuinely has the stated downstream consequence Y.
- It clears the TWO-PART materiality bar: the harm is invisible at PR time AND manifests away from the change (dashboard / experiment / downstream consumer / other path). If the worst case is a nit, or the bug manifests in the diff itself, DISMISS it as out of scope.
You judge FACTS and MATERIALITY only — never whether the author "intended" it (that stays an open question for them). Do NOT default to confirm here: an unproven fact or an immaterial consequence is a DISMISS, with a cited reason.

# Output — write ${VERDICTS_FILE}
Write EXACTLY a JSON ARRAY, one record per candidate, keyed by "id":
[
  { "id": "blindspot-1", "confirmed": true, "level": "high", "rationale": "<grounded: cite file:line + which materiality part holds>" }
]
Include "level" ONLY when overriding severity. Write ONLY that file.`;

function buildAuthorFinderPrompt(
  prKey: string,
  title: string,
  body: string,
  blobBase: string,
  overviewMd: string
): string {
  return [
    `PR: ${prKey}`,
    `Title: ${title}`,
    `Repo blob base URL (pinned to PR head): ${blobBase}`,
    `  Build permalinks as <base>/<path>#L<line>, e.g. ${blobBase}/src/index.ts#L42`,
    "",
    "Author's PR description (CLAIMED SCOPE — an advisory lens for inDescription, NOT a filter;",
    "hunt harm regardless of what it says; if empty/thin, just harm-hunt):",
    "<<<DESCRIPTION",
    body?.trim() || "(none)",
    "DESCRIPTION",
    "",
    "PR overview (context — build on it, do not repeat it):",
    "<<<OVERVIEW",
    overviewMd || "(none)",
    "OVERVIEW",
    "",
    `Investigate the checkout, then write your grounded blind-spot array to ${RISKS_FILE}.`,
  ].join("\n");
}

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
  /**
   * "reviewer" (default) = Verified Risk Analysis on someone else's PR.
   * "author" = Blind-spot finding on the author's own PR (CONTEXT.md): harm-hunt
   * framing, layer-tagged, PR `body` used as an advisory lens.
   */
  mode?: "reviewer" | "author";
  /** The author's PR description — only consulted in "author" mode. */
  body?: string;
}): Promise<{ risks: RiskItem[]; status: "ready" | "failed" }> {
  const { dir, prKey, title, blobBase, overviewMd, maxTurns, mode = "reviewer", body = "" } = opts;
  const author = mode === "author";
  // Reviewer Verified Risk Analysis is a read-only reviewer artifact → sonnet.
  // Author Blind spots reason about the owner's own PR → default (opus).
  const { env, modelArn } = await sdkEnv(
    author ? undefined : loadConfig().overview.reviewerModelName
  );

  // --- Finder pass ---
  await runAgent({
    dir,
    env,
    modelArn,
    maxTurns,
    system: author ? AUTHOR_FINDER_SYSTEM : FINDER_SYSTEM,
    prompt: author
      ? buildAuthorFinderPrompt(prKey, title, body, blobBase, overviewMd)
      : buildFinderPrompt(prKey, title, blobBase, overviewMd),
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
      system: author ? AUTHOR_CONFIRMER_SYSTEM : CONFIRMER_SYSTEM,
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

// --- Author Blind spots: on-demand artifact (PR-resources spec, Phase 2) ---
//
// The author-role counterpart to reviewer Verified risks. Unlike reviewer risks
// (produced synchronously inside the overview run), Blind spots are their OWN
// on-demand artifact — modeled exactly on the quiz (`quiz.ts`): own head-sha for
// staleness on a moving author branch, in-flight double-click guard, per-repo
// SerialQueue for worktree collision-safety, and a `pr_risks_updated` SSE event.
// Read-only w.r.t. GitHub (`dryRun` does not gate it).

/**
 * Run the author Blind-spot analysis for a PR and persist the artifact + the
 * head it was built against. Provisions its OWN read-only `skipDeps` worktree at
 * the same PR-level negative key as the overview (`-pr.number`), so it must run
 * through the shared per-repo queue (see `requestBlindSpots`). Never crashes the
 * daemon — a failed run lands `failed` on the row. Requires an existing overview
 * (the finder is grounded on it, matching the reviewer path).
 */
export async function generateBlindSpots(
  prKey: string
): Promise<{ risks: RiskItem[]; status: RiskStatus; headSha: string }> {
  const pr = getPrOverview(prKey);
  if (!pr) throw new Error(`no PR ${prKey}`);
  const cfg = loadConfig();

  const head = await getPrHead(pr.owner, pr.repo, pr.number);
  const body = await getPrBody(pr.owner, pr.repo, pr.number);
  const blobBase = `https://github.com/${pr.owner}/${pr.repo}/blob/${head.headSha}`;
  const wtKey = -pr.number;
  const { dir } = await addWorktree(pr.owner, pr.repo, head.headRefName, wtKey, {
    skipDeps: true,
  });
  try {
    const r = await analyzeRisks({
      dir,
      prKey,
      title: pr.title,
      body,
      blobBase,
      overviewMd: pr.overviewMd ?? "",
      maxTurns: cfg.overview.maxTurns,
      mode: "author",
    });
    const result = { risks: r.risks, status: r.status as RiskStatus, headSha: head.headSha };
    updatePrOverview(prKey, {
      risks: result.risks,
      risksStatus: result.status,
      risksHeadSha: result.headSha,
    });
    return result;
  } finally {
    await removeWorktree(pr.owner, pr.repo, wtKey).catch(() => {});
  }
}

/** PRs with a Blind-spot generation currently running — the double-click guard. */
const inFlight = new Set<string>();

/**
 * Fire-and-forget entry point for the API/dashboard: mark the PR risks
 * `generating`, run generation inside the shared per-repo SerialQueue (worktree
 * collision-safety with the overview, which shares the `-pr.number` key), and
 * emit `pr_risks_updated` around it. Author-role only. Requires an existing
 * overview. Never throws to the caller — failures land on the row as `failed`.
 */
export function requestBlindSpots(prKey: string): { ok: boolean; reason?: string } {
  const cfg = loadConfig();
  if (!cfg.overview.enabled) return { ok: false, reason: "overview feature disabled" };
  const pr = getPrOverview(prKey);
  if (!pr) return { ok: false, reason: "no such PR" };
  if (pr.role !== "author") return { ok: false, reason: "blind spots are author-only" };
  if (isIgnoredRepo(pr.owner, pr.repo)) return { ok: false, reason: "repo not in scope" };
  if (!pr.overviewMd) return { ok: false, reason: "generate an overview first" };
  if (inFlight.has(prKey) || pr.risksStatus === "generating") {
    return { ok: false, reason: "already generating" };
  }

  inFlight.add(prKey);
  updatePrOverview(prKey, { risksStatus: "generating" });
  logEvent(null, "risks", `${prKey}: generating…`);
  emit({ type: "pr_risks_updated", prKey });

  void repoQueue.run(`${pr.owner}/${pr.repo}`, async () => {
    try {
      const r = await generateBlindSpots(prKey);
      logEvent(null, "risks", `${prKey}: ${r.status} (blind spots=${r.risks.length})`);
    } catch (err: any) {
      updatePrOverview(prKey, { risksStatus: "failed" });
      logEvent(null, "risks_error", `${prKey}: ${err?.message ?? String(err)}`);
    } finally {
      inFlight.delete(prKey);
      emit({ type: "pr_risks_updated", prKey });
    }
  });
  return { ok: true };
}
