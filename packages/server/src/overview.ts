import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadConfig, sdkEnv } from "./config.js";
import { addWorktree, removeWorktree } from "./worktrees.js";
import { getPrHead } from "./gh.js";
import { getPrOverview, updatePrOverview, logEvent } from "./db.js";
import type { PrOverview } from "./db.js";
import { isIgnoredRepo } from "./classify.js";
import { repoQueue } from "./queue.js";
import { emit } from "./events.js";

/**
 * PR-level overview + codebase-relationship diagram — a Session-level artifact
 * that lives OUTSIDE the Thread/Verdict lifecycle. On-demand, read-only w.r.t.
 * GitHub (so `dryRun` does not gate it); the only write is a local SVG file.
 *
 * One agent investigation produces BOTH deliverables from a read-only worktree
 * on the PR head. Output shape mirrors verdict.ts but uses TWO fenced blocks: a
 * ```json block for the prose and a dedicated ```svg block for the diagram, so a
 * large SVG never has to survive JSON escaping. The overview survives a
 * bad/missing diagram (graceful degradation). The agent gets NO write tools —
 * the read-only investigation guarantee is preserved.
 */

const OVERVIEW_SYSTEM = `You produce a PR OVERVIEW and a codebase-relationship DIAGRAM for a pull request. You work in a read-only checkout of the PR branch. Investigate the ACTUAL code before deciding — never guess.

Your job has two halves, both grounded in real investigation:
1. Read the PR diff (\`git diff origin/master...HEAD\` or \`git show\`), identify the CORE changed files, then GREP/GLOB the checkout to trace what DEPENDS ON the changed symbols — the "blast radius" of files that could be AFFECTED but were not themselves edited. This trace is the analytical value you add over a raw diff; do it.
2. Turn that understanding into a concise overview and an SVG diagram.

Work efficiently — you have a limited number of turns. Read the diff, spot the core files, trace their dependents, then write. Don't explore exhaustively once the change's shape and blast radius are clear.

You MUST end your response with EXACTLY TWO fenced blocks, in this order and nothing after them:

First, a JSON block with the overview:
\`\`\`json
{
  "summary": "<one sentence: what this PR does>",
  "overview_md": "<the 4-part markdown overview — see structure below>"
}
\`\`\`

Then, an SVG block with the diagram:
\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 700"> ... </svg>
\`\`\`

OVERVIEW STRUCTURE (overview_md) — concise BULLETS over paragraphs, use these four sections verbatim as \`##\` headings:
## What this PR does
2–3 sentences of plain-language intent.
## Key changes
Bulleted list of the core files/behaviors that carry the change.
## Affected / blast radius
Bulleted list of downstream code that could be impacted — the dependents you traced by grep, NOT just the changed files. If nothing depends on the change, say so explicitly.
## Risks / things to review
Bulleted list of what a reviewer should scrutinize (correctness, edge cases, security, missing tests).
State briefly what you INCLUDED vs. OMITTED from the diagram here so the scoping is reviewable.

DIAGRAM SCOPING DISCIPLINE (avoid the "every changed file is a box" sprawl):
- Give NODES only to the 1–4 files that carry the change's core argument. If dropping a file would misrepresent what the PR does, it's core; otherwise it is not.
- Draw EDGES to AFFECTED (downstream caller/dependent) code — the relationships are the point, not a file list. Label edges with the relationship (calls, imports, renders, emits…).
- Cap total nodes at ~4–8. Test files, fixtures, lockfiles, and incidental edits get an ANNOTATION at most, never their own node.
- Use real function/module/event names from the code as evidence, not generic "Component A" boxes.

SVG REQUIREMENTS:
- A single self-contained <svg> element with an xmlns attribute and a viewBox. No external <script>, no external stylesheet, no <image href> to remote URLs.
- Dark theme: background rect fill #020617, node fills around #0f172a with #1e293b strokes, text #e2e8f0, accent edges #38bdf8. Monospace font-family (e.g. "JetBrains Mono", ui-monospace, monospace) — do NOT reference remote fonts.
- Legible: readable font-size (>= 13), arrows on edges, no overlapping text.

If you genuinely cannot produce a meaningful diagram (e.g. a pure config/text change), still emit a valid minimal <svg> that states that in a single labeled box — never emit malformed XML.`;

function buildPrompt(pr: PrOverview): string {
  return [
    `PR: ${pr.prKey}`,
    `Title: ${pr.title}`,
    `Branch: ${pr.headRef}`,
    "",
    "You are in a read-only checkout of the PR head. Inspect the diff against master, trace the affected code, then return the JSON overview block followed by the SVG diagram block.",
  ].join("\n");
}

/** Directory where generated SVG diagrams are stored (derived from state root). */
function diagramsDir(): string {
  // Sibling of the SQLite db / repos / worktrees under ~/.babysit-agent.
  return join(dirname(loadConfig().dbPath), "diagrams");
}

/** prKey (owner/repo#number) → filename-safe stem, matching the owner__repo convention. */
function sanitizePrKey(prKey: string): string {
  return prKey.replace(/[/#]/g, "__");
}

/** Extract the first well-formed <svg>…</svg> from a fenced ```svg block (or raw). */
function parseSvg(text: string): string | null {
  const fence = [...text.matchAll(/```svg\s*([\s\S]*?)```/gi)];
  const raw = fence.length ? fence[fence.length - 1][1] : text;
  const m = raw.match(/<svg[\s\S]*?<\/svg>/i);
  if (!m) return null;
  const svg = m[0].trim();
  // Cheap well-formedness guard (decision 6): must have an <svg> root and
  // balanced-ish tags. Reject obvious script/remote-image injection.
  if (!/^<svg[\s>]/i.test(svg)) return null;
  if (/<script[\s>]/i.test(svg)) return null;
  const opens = (svg.match(/</g) || []).length;
  const closes = (svg.match(/>/g) || []).length;
  if (opens !== closes) return null;
  return svg;
}

/** Extract the overview JSON block. Returns null if unparseable. */
function parseOverviewJson(text: string): { summary: string; overview_md: string } | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (!matches.length) return null;
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(matches[i][1].trim());
      if (typeof obj.overview_md === "string" && obj.overview_md.trim()) {
        return { summary: String(obj.summary ?? ""), overview_md: obj.overview_md };
      }
    } catch {
      /* try the next block up */
    }
  }
  return null;
}

export interface OverviewResult {
  overviewMd: string;
  svg: string | null;
  headSha: string;
  status: "ready" | "failed";
}

/**
 * Run the read-only overview investigation for a PR and persist the artifact.
 * Performs NO GitHub writes. On max-turns/parse failure it degrades gracefully:
 * a usable overview is saved even without a diagram; only a total loss →
 * `failed`. The caller is responsible for the in-flight guard / SerialQueue.
 */
export async function generateOverview(prKey: string): Promise<OverviewResult> {
  const pr = getPrOverview(prKey);
  if (!pr) throw new Error(`no PR ${prKey}`);
  const cfg = loadConfig();

  const head = await getPrHead(pr.owner, pr.repo, pr.number);
  // A PR-unique worktree namespace (negative so it never collides with a real
  // thread id) — confirms this artifact lives outside the Thread model.
  const wtKey = -pr.number;
  // Read-only investigation — never builds/tests, so skip the (multi-GB) deps
  // provisioning that the fix pipeline needs.
  const { dir } = await addWorktree(pr.owner, pr.repo, head.headRefName, wtKey, {
    skipDeps: true,
  });
  try {
    let assistantText = "";
    let last = "";
    let endSubtype = "";
    const { env, modelArn } = await sdkEnv();
    for await (const msg of query({
      prompt: buildPrompt(pr),
      options: {
        cwd: dir,
        model: modelArn,
        systemPrompt: OVERVIEW_SYSTEM,
        permissionMode: "dontAsk",
        allowedTools: ["Read", "Grep", "Glob", "Bash"],
        settingSources: [],
        env,
        maxTurns: cfg.overview.maxTurns,
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
    const text = last || assistantText;
    const parsed = parseOverviewJson(text);
    const svg = parseSvg(text);

    // Total loss: no overview AND no diagram → failed (record the reason).
    if (!parsed && !svg) {
      const overviewMd = `_Overview generation did not produce usable output (${endSubtype || "no result"})._`;
      persist(prKey, { overviewMd, svg: null, headSha: head.headSha, status: "failed" });
      return { overviewMd, svg: null, headSha: head.headSha, status: "failed" };
    }

    // Partial is still useful: overview may survive a bad/missing diagram.
    const overviewMd =
      parsed?.overview_md ??
      `_The overview text was incomplete (${endSubtype || "ended"}); a diagram was still produced._`;
    const result: OverviewResult = {
      overviewMd,
      svg,
      headSha: head.headSha,
      status: "ready",
    };
    persist(prKey, result);
    return result;
  } finally {
    await removeWorktree(pr.owner, pr.repo, wtKey).catch(() => {});
  }
}

/** PRs with a generation currently running — the in-flight double-click guard. */
const inFlight = new Set<string>();

/**
 * Fire-and-forget entry point for the API/dashboard: mark the PR `generating`,
 * run generation inside the shared per-repo SerialQueue (worktree
 * collision-safety), and emit `pr_overview_updated` around it. Rejects a second
 * request while one is in flight for the same PR. Never throws to the caller —
 * failures land on the row as `failed`.
 */
export function requestOverview(prKey: string): { ok: boolean; reason?: string } {
  const cfg = loadConfig();
  if (!cfg.overview.enabled) return { ok: false, reason: "overview feature disabled" };
  const pr = getPrOverview(prKey);
  if (!pr) return { ok: false, reason: "no such PR" };
  if (isIgnoredRepo(pr.owner, pr.repo)) return { ok: false, reason: "repo not in scope" };
  if (inFlight.has(prKey) || pr.overviewStatus === "generating") {
    return { ok: false, reason: "already generating" };
  }

  inFlight.add(prKey);
  updatePrOverview(prKey, { overviewStatus: "generating" });
  logEvent(null, "overview", `${prKey}: generating…`);
  emit({ type: "pr_overview_updated", prKey });

  void repoQueue.run(`${pr.owner}/${pr.repo}`, async () => {
    // The row may have changed while queued; re-check the in-flight intent holds.
    try {
      const r = await generateOverview(prKey);
      logEvent(null, "overview", `${prKey}: ${r.status} (svg=${r.svg ? "yes" : "no"})`);
    } catch (err: any) {
      updatePrOverview(prKey, {
        overviewStatus: "failed",
        overviewGeneratedAt: new Date().toISOString(),
      });
      logEvent(null, "overview_error", `${prKey}: ${err?.message ?? String(err)}`);
    } finally {
      inFlight.delete(prKey);
      emit({ type: "pr_overview_updated", prKey });
    }
  });
  return { ok: true };
}

/** Write the SVG file (replacing any prior one) and update the prs row. */
function persist(prKey: string, r: OverviewResult): void {
  const prev = getPrOverview(prKey);
  let diagramPath: string | null = null;
  if (r.svg) {
    mkdirSync(diagramsDir(), { recursive: true });
    diagramPath = join(diagramsDir(), `${sanitizePrKey(prKey)}-${r.headSha}.svg`);
    writeFileSync(diagramPath, r.svg, "utf8");
  }
  // One file per PR at a time: drop the previous diagram if the path changed.
  if (prev?.diagramPath && prev.diagramPath !== diagramPath) {
    rmSync(prev.diagramPath, { force: true });
  }
  updatePrOverview(prKey, {
    overviewMd: r.overviewMd,
    diagramPath,
    overviewHeadSha: r.headSha,
    overviewStatus: r.status,
    overviewGeneratedAt: new Date().toISOString(),
  });
}
