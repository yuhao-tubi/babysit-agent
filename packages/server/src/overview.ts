import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sdkEnv } from "./config.js";
import { addWorktree, removeWorktree } from "./worktrees.js";
import { getPrHead } from "./gh.js";
import { getPrOverview, updatePrOverview, logEvent } from "./db.js";
import type { PrOverview } from "./db.js";
import type { DiagramSection, DiagramSet, RiskItem } from "./types.js";
import { isIgnoredRepo } from "./classify.js";
import { repoQueue } from "./queue.js";
import { emit } from "./events.js";
import { assetsDir } from "./render.js";
import { sanitizeSvg } from "./svg.js";
import { analyzeRisks } from "./risks.js";

/**
 * PR-level overview + SVG DIAGRAM SET — a Session-level artifact that lives
 * OUTSIDE the Thread/Verdict lifecycle. On-demand, read-only w.r.t. GitHub (so
 * `dryRun` does not gate it); the only persistence is the DB.
 *
 * One agent investigation produces the prose overview AND up to three diagrams
 * (one per 4W1H section). The agent AUTHORS a self-contained `<svg>` per section
 * in a SINGLE pass — no render loop, no headless browser. Diagram quality is
 * front-loaded via a vendored authoring skill (design system + spacing rules)
 * rather than an expensive write→render→view→fix loop. The agent has NO
 * GitHub/push tools (the read-only-w.r.t.-GitHub guarantee is preserved); `Write`
 * only touches the ephemeral worktree.
 *
 * Delivery contract: the agent writes diagrams to FIXED paths in the worktree
 * (`overview/{why,what,how}.svg` + `overview/overview.json` for the prose + which
 * sections it finalized). The server reads those files back, SANITIZES each SVG
 * (see `sanitizeSvg` — the SVG is rendered inline in the dashboard, so untrusted
 * markup is an XSS surface), and drops any that fail validation. Verbose markup
 * never round-trips through the token stream.
 *
 * The agent learns the SVG authoring methodology from VENDORED skill docs
 * (svg-methodology.md / svg-templates.md / color-palette.md in overview-assets/),
 * which it Reads by absolute path. The sandbox stays sealed (`settingSources:
 * []`) — no skill auto-discovery, no target-repo `.claude`.
 */

const SECTIONS: DiagramSection[] = ["why", "what", "how"];

/** Fixed worktree-relative paths the agent writes and the server reads back. */
const OUTPUT_DIR = "overview";
const overviewJsonPath = (dir: string) => join(dir, OUTPUT_DIR, "overview.json");
const sectionSvgPath = (dir: string, s: DiagramSection) =>
  join(dir, OUTPUT_DIR, `${s}.svg`);

function buildSystemPrompt(role: "author" | "reviewer", wtDir: string): string {
  const dir = assetsDir();
  const methodology = join(dir, "svg-methodology.md");
  const templates = join(dir, "svg-templates.md");
  const palette = join(dir, "color-palette.md");
  // ABSOLUTE output paths — the agent has misresolved bare relative paths
  // against a hallucinated base before, writing outside the worktree so the
  // server read back nothing. Pin the exact directory it must write into.
  const outDir = join(wtDir, OUTPUT_DIR);

  return `You produce a PR OVERVIEW and up to THREE diagrams (one per 4W1H section: Why / What / How) for a pull request. You work in a read-only checkout of the PR branch. Investigate the ACTUAL code before deciding — never guess.

# Step 1 — Investigate (grounded)
1. Read the PR diff (\`git diff origin/master...HEAD\` or \`git show\`), identify the CORE changed files, then GREP/GLOB the checkout to trace what DEPENDS ON the changed symbols — the "blast radius" of files AFFECTED but not themselves edited. This trace is the analytical value you add over a raw diff; do it.
2. Break the PR down with 4W1H (Why / What / How). This drives both the prose and the diagrams.

# Step 2 — Learn the diagram methodology
Each diagram is a self-contained \`<svg>\` you author DIRECTLY as SVG markup (shapes, coordinates, text). BEFORE drawing, READ these vendored references by absolute path:
- Methodology (how to make a diagram ARGUE, visual patterns, the CRITICAL spacing rules that keep a one-shot layout clean): ${methodology}
- SVG element templates (copy-paste shapes: boxes, labels, arrows/markers, groups): ${templates}
- Color palette (the dashboard's semantic colors — the SINGLE source of truth for color): ${palette}

# Step 3 — Draw a diagram per section that earns one
Produce a diagram for a section ONLY when that idea genuinely has ≥3 things worth relating. PREFER to give the "Why" section a diagram — a picture of the PROBLEM (before→after, cause→effect, the broken flow) teaches the reader's biggest question far better than prose. Diagrams are FREE-FORM: a node can be a code file, a concept, a problem, a state, a data shape, an actor, or a step. Pick the visual pattern that best teaches each idea (before/after, two side-by-side pipelines, fan-out, timeline, tree, state machine, etc. — see the methodology). Use real symbol/file/state names, not "Component A". A trivial PR (pure config/text) can have zero diagrams.

You author each SVG in ONE pass — there is NO render step and you will NOT see it rendered. This is why the METHODOLOGY'S SPACING RULES are load-bearing: follow them exactly (minimum gaps between boxes, non-overlapping placement, text that fits its box, a viewBox large enough for everything incl. any legend). Compute coordinates carefully; a sloppy layout ships as-is.

Write each diagram you produce to a FIXED ABSOLUTE path (write to these EXACT paths — do NOT invent a different directory):
- Why  → ${join(outDir, "why.svg")}
- What → ${join(outDir, "what.svg")}
- How  → ${join(outDir, "how.svg")}
Each file MUST be a single self-contained SVG document: it starts with \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H">\`, contains only static shapes/text/markers, and ends with \`</svg>\`. HARD CONSTRAINTS (the server rejects a diagram that violates these): the root element is \`<svg>\`; there is a \`viewBox\`; NO \`<script>\`, NO \`<foreignObject>\`, NO \`on*\` event attributes, NO external/\`javascript:\` URLs (in-document \`#id\` references for markers/gradients are fine).

# Step 4 — Write the prose + manifest
Write ${join(outDir, "overview.json")} (this EXACT absolute path) as EXACTLY this JSON object:
{
  "summary": "<one sentence: what this PR does>",
  "overview_md": "<the markdown overview — see structure below>",
  "sections": [<the subset of "why","what","how" for which you wrote an SVG diagram>]
}

OVERVIEW_MD STRUCTURE — concise BULLETS over paragraphs. These three \`##\` headings are required, the rest optional:
## Why
Why this PR exists — the problem, motivation, or requirement it addresses (2–3 sentences).
## What
What is included and its impact — the core files/behaviors that carry the change, as bullets.
## How
How it works — the relationship between the CHANGED files and the AFFECTED (traced-by-grep) code. If nothing depends on the change, say so.

# Rules
- Work efficiently within your turn budget: investigate, then author each SVG carefully in one pass. Don't explore exhaustively once the shape and blast radius are clear.
- You have Read/Grep/Glob/Bash and Write. Write ONLY the files under ${outDir}/ (that exact absolute directory) — never edit the target repo's source, and never write to any other directory. You have NO ability to push or post to GitHub; this is a read-only investigation.
- Your FINAL text message should just name which section diagrams you finalized (e.g. "Wrote why + how diagrams; what was trivial"). The durable output is the FILES, not your message.`;
}

function buildPrompt(pr: PrOverview, wtDir: string): string {
  const outDir = join(wtDir, OUTPUT_DIR);
  return [
    `PR: ${pr.prKey}`,
    `Title: ${pr.title}`,
    `Branch: ${pr.headRef}`,
    "",
    `Your working directory (cwd) is ${wtDir} — a read-only checkout of the PR head. Create the directory ${outDir} (\`mkdir -p ${outDir}\`), then follow your system instructions: investigate the diff, author a self-contained SVG diagram for each section that earns one, and write ${join(outDir, "overview.json")}. Write ALL output files to that exact ${outDir} directory — never to any other path.`,
  ].join("\n");
}

/**
 * Repair prompt for the ONE text-only fix attempt: name each section whose SVG
 * failed sanitization and the concrete reason, and ask the agent to rewrite just
 * those files to the same paths. Purely mechanical (no re-investigation) — the
 * goal is a valid, safe SVG, not a better diagram.
 */
function buildRepairPrompt(
  wtDir: string,
  invalid: { section: DiagramSection; errors: string[] }[]
): string {
  const outDir = join(wtDir, OUTPUT_DIR);
  const lines = invalid.map(
    (iv) => `- ${join(outDir, `${iv.section}.svg`)} — rejected because: ${iv.errors.join("; ")}`
  );
  return [
    "Some diagram SVG files you wrote were REJECTED by the validator and were dropped.",
    "Rewrite ONLY these files, to the SAME absolute paths, fixing the stated problem:",
    ...lines,
    "",
    "Requirements for each rewritten file (the validator enforces these):",
    '- The root element is `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H">` and the file ends with `</svg>`.',
    "- It has a viewBox and at least one shape.",
    "- NO `<script>`, NO `<foreignObject>`, NO `on*` attributes, NO external or `javascript:` URLs (in-document `#id` refs are fine).",
    "Do not change overview.json and do not touch any other file. Your final message just says you rewrote them.",
  ].join("\n");
}

/**
 * Drive one read-only overview/repair agent turn to completion. The durable
 * output is the files on disk; we only capture the terminal result subtype (for
 * diagnostics when nothing was written). Read/Grep/Glob/Bash + Write, no gh/push.
 */
async function runOverviewAgent(opts: {
  prompt: string;
  systemPrompt: string;
  dir: string;
  env: Record<string, string>;
  modelArn: string;
  maxTurns: number;
  trace: (obj: unknown) => void;
}): Promise<string> {
  let endSubtype = "";
  for await (const msg of query({
    prompt: opts.prompt,
    options: {
      cwd: opts.dir,
      model: opts.modelArn,
      systemPrompt: opts.systemPrompt,
      permissionMode: "dontAsk",
      // Write lets the agent author `.svg` + overview.json in the ephemeral
      // worktree. It has NO gh/push tool — GitHub stays untouched.
      allowedTools: ["Read", "Grep", "Glob", "Bash", "Write"],
      settingSources: [],
      env: opts.env,
      maxTurns: opts.maxTurns,
      stderr: (s: string) => opts.trace({ type: "stderr", text: s }),
    },
  })) {
    opts.trace(msg);
    if (msg.type === "result") endSubtype = msg.subtype;
  }
  return endSubtype;
}

/**
 * Read the agent's output files back from the worktree: the prose manifest
 * (overview.json) and each section SVG present. Every SVG is run through
 * `sanitizeSvg` (well-formedness + XSS strip) before it is accepted — the SVG is
 * rendered inline in the dashboard, so an unsanitized string is a live XSS
 * surface. A section is reported in `invalid` (with the concrete errors) when its
 * file exists but fails sanitization, so the caller can offer the agent ONE
 * text-only repair attempt. A missing file is simply absent (graceful
 * degradation — the prose overview stands on its own).
 */
export function collectFromWorktree(dir: string): {
  summary: string;
  overviewMd: string;
  diagrams: DiagramSet;
  invalid: { section: DiagramSection; errors: string[] }[];
} | null {
  const manifestPath = overviewJsonPath(dir);
  if (!existsSync(manifestPath)) return null;
  let manifest: any;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof manifest?.overview_md !== "string" || !manifest.overview_md.trim()) {
    return null;
  }

  const diagrams: DiagramSet = {};
  const invalid: { section: DiagramSection; errors: string[] }[] = [];
  // Opportunistically read every section SVG present on disk (independent of the
  // manifest's `sections` list — the agent may forget to list one it wrote).
  for (const s of SECTIONS) {
    const p = sectionSvgPath(dir, s);
    if (!existsSync(p)) continue;
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const r = sanitizeSvg(raw);
    if (r.ok) diagrams[s] = { svg: r.svg };
    else invalid.push({ section: s, errors: r.errors });
  }

  return {
    summary: String(manifest.summary ?? ""),
    overviewMd: manifest.overview_md,
    diagrams,
    invalid,
  };
}

export interface OverviewResult {
  overviewMd: string;
  diagrams: DiagramSet;
  headSha: string;
  status: "ready" | "failed";
  /** Reviewer PRs: merged risk items ([] otherwise or when none). */
  risks?: RiskItem[];
  /** Reviewer PRs: `ready`|`failed`; null when not applicable (author PRs). */
  risksStatus?: "ready" | "failed" | null;
}

/**
 * Run the read-only overview investigation for a PR and persist the artifact.
 * Performs NO GitHub writes.
 *
 * Failure model: the PROSE overview is the floor and must survive — a run that
 * yields no usable overview manifest ⇒ `failed`. Diagrams are best-effort
 * enrichment: each authored SVG must pass sanitization; one that fails gets ONE
 * text-only repair attempt, then is dropped (the prose overview still ships
 * `ready`). No headless browser is involved. The daemon is never crashed — the
 * caller records `failed` on the row.
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
    // Reviewer overviews are read-only, reviewer-facing artifacts → sonnet for
    // speed. Author overviews stay on the default (opus). See OverviewConfig.
    const { env, modelArn } = await sdkEnv(
      pr.role === "reviewer" ? cfg.overview.reviewerModelName : undefined
    );
    // Optional transcript capture for debugging a generation. When
    // BABYSIT_OVERVIEW_TRACE points at a file, every SDK message is appended as
    // JSONL so we can audit why a run finished without writing the manifest.
    const tracePath = process.env.BABYSIT_OVERVIEW_TRACE;
    const trace = (obj: unknown) => {
      if (tracePath) appendFileSync(tracePath, JSON.stringify(obj) + "\n");
    };

    const endSubtype = await runOverviewAgent({
      prompt: buildPrompt(pr, dir),
      systemPrompt: buildSystemPrompt(pr.role, dir),
      dir,
      env,
      modelArn,
      maxTurns: cfg.overview.maxTurns,
      trace,
    });

    let collected = collectFromWorktree(dir);
    if (!collected) {
      // Be specific about WHY nothing came back — a bare "(success)" marker hid a
      // real bug where the agent wrote the manifest outside the worktree. Name the
      // exact path we expected so this is diagnosable at a glance.
      const expected = overviewJsonPath(dir);
      const reason = existsSync(expected)
        ? `manifest at ${expected} was empty or malformed`
        : `agent ended '${endSubtype || "no result"}' but wrote no manifest at ${expected}`;
      logEvent(null, "overview_error", `${prKey}: ${reason}`);
      const overviewMd = `_Overview generation did not produce usable output — ${reason}._`;
      const result: OverviewResult = {
        overviewMd,
        diagrams: {},
        headSha: head.headSha,
        status: "failed",
      };
      persist(prKey, result);
      return result;
    }

    // ONE text-only repair attempt for any section whose SVG failed sanitization
    // (malformed markup, a stripped-to-nothing doc, a disallowed element). We feed
    // the concrete validation errors back — NO render, NO PNG — and re-collect. A
    // section still invalid after this is dropped; the prose overview is unharmed.
    if (collected.invalid.length) {
      const detail = collected.invalid
        .map((iv) => `${iv.section} (${iv.errors.join("; ")})`)
        .join(", ");
      logEvent(
        null,
        "overview",
        `${prKey}: repairing ${collected.invalid.length} invalid diagram(s): ${detail}`
      );
      await runOverviewAgent({
        prompt: buildRepairPrompt(dir, collected.invalid),
        systemPrompt: buildSystemPrompt(pr.role, dir),
        dir,
        env,
        modelArn,
        maxTurns: cfg.overview.maxTurns,
        trace,
      });
      const recollected = collectFromWorktree(dir);
      if (recollected) collected = recollected;
    }

    // Verified Risk Analysis (reviewer-role PRs only) — reuse the SAME worktree,
    // fed the just-produced overview as context. Failures here are INDEPENDENT of
    // the overview status (a failed risk stage never blanks the ready overview).
    let risks: RiskItem[] = [];
    let risksStatus: "ready" | "failed" | null = null;
    if (pr.role === "reviewer") {
      const blobBase = `https://github.com/${pr.owner}/${pr.repo}/blob/${head.headSha}`;
      try {
        const r = await analyzeRisks({
          dir,
          prKey,
          title: pr.title,
          blobBase,
          overviewMd: collected.overviewMd,
          maxTurns: cfg.overview.maxTurns,
        });
        risks = r.risks;
        risksStatus = r.status;
      } catch (err: any) {
        risksStatus = "failed";
        logEvent(null, "overview_error", `${prKey} (risks): ${err?.message ?? String(err)}`);
      }
    }

    const result: OverviewResult = {
      overviewMd: collected.overviewMd,
      diagrams: collected.diagrams,
      headSha: head.headSha,
      status: "ready",
      risks,
      risksStatus,
    };
    persist(prKey, result);
    return result;
  } finally {
    await removeWorktree(pr.owner, pr.repo, wtKey).catch(() => {});
  }
}

const QA_SYSTEM = `You answer a specific QUESTION about a pull request. You work in a read-only checkout of the PR branch. Investigate the ACTUAL code before answering — never guess.

You are given the PR's existing overview (for context on what the change does) and a question from the PR reviewer. GREP/GLOB/READ the checkout and the diff (\`git diff origin/master...HEAD\`) to ground your answer in real code. Cite specific files and, where useful, function/symbol names.

Answer concisely in GitHub-flavored Markdown — a few sentences or tight bullets, not an essay. If the question cannot be answered from the code (e.g. it asks about intent not visible in the diff), say so plainly rather than speculating.

Return ONLY the answer markdown — no preamble like "Here is the answer", no fenced code block wrapping the whole thing (inline code and code blocks WITHIN the answer are fine).`;

function buildQaPrompt(pr: PrOverview, question: string): string {
  return [
    `PR: ${pr.prKey}`,
    `Title: ${pr.title}`,
    "",
    "Existing overview (context — do not repeat it, build on it):",
    "<<<OVERVIEW",
    pr.overviewMd || "(none)",
    "OVERVIEW",
    "",
    "Reviewer's question:",
    "<<<QUESTION",
    question,
    "QUESTION",
    "",
    "Investigate the checkout, then return only your answer as Markdown.",
  ].join("\n");
}

export interface AnswerResult {
  answerMd: string;
  status: "ready" | "failed";
}

/**
 * Answer a reviewer's question about a PR by a read-only investigation of the
 * checkout, then APPEND the Q&A to the PR's overview markdown (so it becomes
 * part of the durable overview and renders inline). Performs NO GitHub writes.
 * A Regenerate wipes appended Q&A — that is the intended "start over" semantic.
 */
export async function answerQuestion(prKey: string, question: string): Promise<AnswerResult> {
  const pr = getPrOverview(prKey);
  if (!pr) throw new Error(`no PR ${prKey}`);
  const cfg = loadConfig();

  const head = await getPrHead(pr.owner, pr.repo, pr.number);
  const wtKey = -pr.number;
  const { dir } = await addWorktree(pr.owner, pr.repo, head.headRefName, wtKey, {
    skipDeps: true,
  });
  try {
    let assistantText = "";
    let last = "";
    let endSubtype = "";
    // Q&A is a read-only, ask-flow artifact → always sonnet, regardless of role.
    const { env, modelArn } = await sdkEnv(cfg.overview.reviewerModelName);
    for await (const msg of query({
      prompt: buildQaPrompt(pr, question),
      options: {
        cwd: dir,
        model: modelArn,
        systemPrompt: QA_SYSTEM,
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
    const answerMd = (last || assistantText).trim();
    if (!answerMd) {
      return { answerMd: `_Could not answer (${endSubtype || "no result"})._`, status: "failed" };
    }
    // Append the Q&A to the durable overview markdown.
    const qa = `\n\n---\n\n### Q: ${question.trim()}\n\n${answerMd}\n`;
    const fresh = getPrOverview(prKey);
    updatePrOverview(prKey, { overviewMd: (fresh?.overviewMd ?? "") + qa });
    return { answerMd, status: "ready" };
  } finally {
    await removeWorktree(pr.owner, pr.repo, wtKey).catch(() => {});
  }
}

/** PRs with a generation/answer currently running — the in-flight double-click guard. */
const inFlight = new Set<string>();

/**
 * Fire-and-forget entry point for a reviewer question. Runs inside the shared
 * per-repo queue (worktree collision-safety) with the same in-flight guard as
 * generation, and emits `pr_overview_updated` so the appended Q&A streams in.
 */
export function requestQuestion(prKey: string, question: string): { ok: boolean; reason?: string } {
  const cfg = loadConfig();
  if (!cfg.overview.enabled) return { ok: false, reason: "overview feature disabled" };
  const q = question.trim();
  if (!q) return { ok: false, reason: "empty question" };
  const pr = getPrOverview(prKey);
  if (!pr) return { ok: false, reason: "no such PR" };
  if (isIgnoredRepo(pr.owner, pr.repo)) return { ok: false, reason: "repo not in scope" };
  if (!pr.overviewMd) return { ok: false, reason: "generate an overview first" };
  if (inFlight.has(prKey) || pr.overviewStatus === "generating") {
    return { ok: false, reason: "already busy" };
  }

  inFlight.add(prKey);
  updatePrOverview(prKey, { overviewStatus: "generating" });
  logEvent(null, "overview_qa", `${prKey}: Q: ${q.slice(0, 120)}`);
  emit({ type: "pr_overview_updated", prKey });

  void repoQueue.run(`${pr.owner}/${pr.repo}`, async () => {
    try {
      const r = await answerQuestion(prKey, q);
      logEvent(null, "overview_qa", `${prKey}: answered (${r.status})`);
    } catch (err: any) {
      logEvent(null, "overview_error", `${prKey} (qa): ${err?.message ?? String(err)}`);
    } finally {
      // Q&A never leaves the PR in a failed overview state — restore ready.
      updatePrOverview(prKey, { overviewStatus: "ready" });
      inFlight.delete(prKey);
      emit({ type: "pr_overview_updated", prKey });
    }
  });
  return { ok: true };
}

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
    try {
      const r = await generateOverview(prKey);
      logEvent(
        null,
        "overview",
        `${prKey}: ${r.status} (diagrams=${Object.keys(r.diagrams).length})`
      );
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

/**
 * Persist the overview markdown + diagram set (JSON). Diagrams are read-only, so
 * a fresh generation simply overwrites the prior set — there are no owner edits
 * to preserve or clear.
 */
function persist(prKey: string, r: OverviewResult): void {
  updatePrOverview(prKey, {
    overviewMd: r.overviewMd,
    diagrams: r.diagrams,
    overviewHeadSha: r.headSha,
    overviewStatus: r.status,
    overviewGeneratedAt: new Date().toISOString(),
    // Risk artifact is persisted alongside the overview (reviewer PRs). Undefined
    // for author PRs leaves the columns untouched; an explicit null clears them.
    ...(r.risksStatus !== undefined ? { risks: r.risks ?? [], risksStatus: r.risksStatus } : {}),
  });
}
