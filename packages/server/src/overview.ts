import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sdkEnv } from "./config.js";
import { addWorktree, removeWorktree } from "./worktrees.js";
import { getPrHead } from "./gh.js";
import { getPrOverview, updatePrOverview, logEvent } from "./db.js";
import type { PrOverview } from "./db.js";
import type { DiagramSection, DiagramSet, ExcalidrawDoc, RiskItem } from "./types.js";
import { isIgnoredRepo } from "./classify.js";
import { repoQueue } from "./queue.js";
import { emit } from "./events.js";
import { assetsDir, renderCliCommand, chromiumAvailable, ChromiumMissingError } from "./render.js";
import { analyzeRisks } from "./risks.js";

/**
 * PR-level overview + EXCALIDRAW DIAGRAM SET — a Session-level artifact that
 * lives OUTSIDE the Thread/Verdict lifecycle. On-demand, read-only w.r.t. GitHub
 * (so `dryRun` does not gate it); the only persistence is the DB.
 *
 * One agent investigation produces the prose overview AND up to three editable
 * Excalidraw canvases (one per 4W1H section). The agent AUTHORS the `.excalidraw`
 * JSON directly — coordinates, shapes, colors — and self-corrects via a
 * write→render→view→fix loop: it writes a canvas to disk, runs the in-package TS
 * renderer (headless Chromium) to a PNG, Reads the PNG back, critiques its own
 * image, and edits until the layout is clean. It has NO GitHub/push tools (the
 * read-only-w.r.t.-GitHub guarantee is preserved); `Write` only touches the
 * ephemeral worktree.
 *
 * Delivery contract: the agent writes canvases to FIXED paths in the worktree
 * (`overview/{why,what,how}.excalidraw` + `overview/overview.json` for the prose
 * + which sections it finalized). The server reads those files back after the
 * agent returns — the verbose JSON never round-trips through the token stream.
 *
 * The agent learns the Excalidraw authoring methodology from VENDORED skill docs
 * (methodology.md / element-templates.md / json-schema.md / color-palette.md in
 * overview-assets/), which it Reads by absolute path. The sandbox stays sealed
 * (`settingSources: []`) — no skill auto-discovery, no target-repo `.claude`.
 */

const SECTIONS: DiagramSection[] = ["why", "what", "how"];

/** Fixed worktree-relative paths the agent writes and the server reads back. */
const OUTPUT_DIR = "overview";
const overviewJsonPath = (dir: string) => join(dir, OUTPUT_DIR, "overview.json");
const sectionCanvasPath = (dir: string, s: DiagramSection) =>
  join(dir, OUTPUT_DIR, `${s}.excalidraw`);

function buildSystemPrompt(role: "author" | "reviewer", wtDir: string): string {
  const dir = assetsDir();
  const methodology = join(dir, "methodology.md");
  const templates = join(dir, "element-templates.md");
  const schema = join(dir, "json-schema.md");
  const palette = join(dir, "color-palette.md");
  const renderCmd = renderCliCommand();
  // ABSOLUTE output paths — the agent has misresolved bare relative paths
  // against a hallucinated base before, writing outside the worktree so the
  // server read back nothing. Pin the exact directory it must write into.
  const outDir = join(wtDir, OUTPUT_DIR);

  return `You produce a PR OVERVIEW and up to THREE editable Excalidraw diagram canvases (one per 4W1H section: Why / What / How) for a pull request. You work in a read-only checkout of the PR branch. Investigate the ACTUAL code before deciding — never guess.

# Step 1 — Investigate (grounded)
1. Read the PR diff (\`git diff origin/master...HEAD\` or \`git show\`), identify the CORE changed files, then GREP/GLOB the checkout to trace what DEPENDS ON the changed symbols — the "blast radius" of files AFFECTED but not themselves edited. This trace is the analytical value you add over a raw diff; do it.
2. Break the PR down with 4W1H (Why / What / How). This drives both the prose and the diagrams.

# Step 2 — Learn the diagram methodology
You author Excalidraw \`.excalidraw\` JSON directly (coordinates, shapes, colors). BEFORE drawing, READ these vendored references by absolute path:
- Methodology (how to make a diagram ARGUE, visual patterns, the render loop): ${methodology}
- Element JSON templates (copy-paste shapes): ${templates}
- JSON schema (element fields): ${schema}
- Color palette (the dashboard's semantic colors — the SINGLE source of truth for color): ${palette}

# Step 3 — Draw a canvas per section that earns one
Produce a diagram for a section ONLY when that idea genuinely has ≥3 things worth relating. PREFER to give the "Why" section a diagram — a picture of the PROBLEM (before→after, cause→effect, the broken flow) teaches the reader's biggest question far better than prose. Diagrams are FREE-FORM: a node can be a code file, a concept, a problem, a state, a data shape, an actor, or a step. Pick the visual pattern that best teaches each idea (before/after, fan-out, timeline, tree, state machine, UML, etc. — see the methodology). Use real symbol/file/state names, not "Component A". A trivial PR (pure config/text) can have zero canvases.

Write each canvas you produce to a FIXED ABSOLUTE path (write to these EXACT paths — do NOT invent a different directory):
- Why  → ${join(outDir, "why.excalidraw")}
- What → ${join(outDir, "what.excalidraw")}
- How  → ${join(outDir, "how.excalidraw")}
Each file MUST be a complete Excalidraw document: \`{"type":"excalidraw","version":2,"source":"babysit-agent","elements":[...],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}\`.

# Step 4 — Render → view → fix loop (MANDATORY, per canvas)
You CANNOT judge a diagram from JSON alone. For EACH canvas you write, run this loop (2–4 iterations is normal):
1. Render it to PNG:
   \`${renderCmd} <absolute-path-to-the-.excalidraw-file>\`
   (it prints the PNG path and prints \`WxH\`; the PNG is written next to the file).
2. Use the Read tool on that PNG to actually SEE it.
3. Audit for defects: overlapping shapes/text, text clipped by its container, arrows crossing elements or landing on the wrong shape, uneven spacing, unreadable text, lopsided composition. Compare against the idea you meant to teach.
4. Fix by editing the JSON (adjust x/y, widen containers, re-route arrows via extra points, resize), then re-render and re-view.
5. Stop when it's clean and balanced — something you'd show without caveats.

# Step 5 — Write the prose + manifest
Write ${join(outDir, "overview.json")} (this EXACT absolute path) as EXACTLY this JSON object:
{
  "summary": "<one sentence: what this PR does>",
  "overview_md": "<the markdown overview — see structure below>",
  "sections": [<the subset of "why","what","how" for which you wrote a rendered, verified canvas>]
}

OVERVIEW_MD STRUCTURE — concise BULLETS over paragraphs. These three \`##\` headings are required, the rest optional:
## Why
Why this PR exists — the problem, motivation, or requirement it addresses (2–3 sentences).
## What
What is included and its impact — the core files/behaviors that carry the change, as bullets.
## How
How it works — the relationship between the CHANGED files and the AFFECTED (traced-by-grep) code. If nothing depends on the change, say so.

# Rules
- Work efficiently within your turn budget: investigate, then draw+render+fix each canvas. Don't explore exhaustively once the shape and blast radius are clear.
- You have Read/Grep/Glob/Bash and Write. Write ONLY the files under ${outDir}/ (that exact absolute directory) — never edit the target repo's source, and never write to any other directory. You have NO ability to push or post to GitHub; this is a read-only investigation.
- Your FINAL text message should just name which section canvases you finalized (e.g. "Wrote why + how canvases; what was trivial"). The durable output is the FILES, not your message.`;
}

function buildPrompt(pr: PrOverview, wtDir: string): string {
  const outDir = join(wtDir, OUTPUT_DIR);
  return [
    `PR: ${pr.prKey}`,
    `Title: ${pr.title}`,
    `Branch: ${pr.headRef}`,
    "",
    `Your working directory (cwd) is ${wtDir} — a read-only checkout of the PR head. Create the directory ${outDir} (\`mkdir -p ${outDir}\`), then follow your system instructions: investigate the diff, draw a rendered+verified Excalidraw canvas for each section that earns one, and write ${join(outDir, "overview.json")}. Write ALL output files to that exact ${outDir} directory — never to any other path.`,
  ].join("\n");
}

/**
 * Validate a parsed value as an Excalidraw document (the wrapper check the
 * renderer also enforces). Returns the doc or null.
 */
function asExcalidrawDoc(raw: unknown): ExcalidrawDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as any;
  if (o.type !== "excalidraw" || !Array.isArray(o.elements) || o.elements.length === 0) {
    return null;
  }
  return o as ExcalidrawDoc;
}

/**
 * Read the agent's output files back from the worktree: the prose manifest
 * (overview.json) and each section canvas it declared. A canvas that is missing
 * or malformed is simply dropped (graceful degradation) — with the "diagrams are
 * the point" failure model applied by the caller.
 */
function collectFromWorktree(dir: string): {
  summary: string;
  overviewMd: string;
  diagrams: DiagramSet;
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

  const declared: DiagramSection[] = Array.isArray(manifest.sections)
    ? manifest.sections.filter((s: unknown): s is DiagramSection =>
        (SECTIONS as string[]).includes(s as string)
      )
    : [];

  const diagrams: DiagramSet = {};
  // Read declared sections first; also opportunistically pick up any canvas file
  // present but not declared (the agent may have forgotten to list it).
  for (const s of SECTIONS) {
    if (declared.length && !declared.includes(s)) {
      // Still try the file — but only add if it exists and is valid.
    }
    const p = sectionCanvasPath(dir, s);
    if (!existsSync(p)) continue;
    try {
      const doc = asExcalidrawDoc(JSON.parse(readFileSync(p, "utf8")));
      if (doc) diagrams[s] = doc;
    } catch {
      /* skip malformed canvas */
    }
  }

  return {
    summary: String(manifest.summary ?? ""),
    overviewMd: manifest.overview_md,
    diagrams,
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
 * Failure model (Q12=B → Q13=A): the diagrams are the POINT, so there is no
 * silent "prose-only" degradation. Missing Chromium ⇒ hard `failed` with an
 * actionable message BEFORE spending an agent run. A run that yields no usable
 * overview manifest ⇒ `failed`. The daemon is never crashed — the caller records
 * `failed` on the row.
 */
export async function generateOverview(prKey: string): Promise<OverviewResult> {
  const pr = getPrOverview(prKey);
  if (!pr) throw new Error(`no PR ${prKey}`);
  const cfg = loadConfig();

  // Q13: the render loop is load-bearing — fail loudly up front if the renderer
  // can't run, rather than producing a diagram-less overview and lying "ready".
  if (!(await chromiumAvailable())) {
    throw new ChromiumMissingError("required for PR-overview diagram rendering");
  }

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
    let last = "";
    let endSubtype = "";
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
    for await (const msg of query({
      prompt: buildPrompt(pr, dir),
      options: {
        cwd: dir,
        model: modelArn,
        systemPrompt: buildSystemPrompt(pr.role, dir),
        permissionMode: "dontAsk",
        // Write is added so the agent can author `.excalidraw` files in the
        // ephemeral worktree. It has NO gh/push tool — GitHub stays untouched.
        allowedTools: ["Read", "Grep", "Glob", "Bash", "Write"],
        settingSources: [],
        env,
        maxTurns: cfg.overview.maxTurns,
        stderr: tracePath ? (s: string) => trace({ type: "stderr", text: s }) : () => {},
      },
    })) {
      trace(msg);
      if (msg.type === "result") {
        endSubtype = msg.subtype;
        if (msg.subtype === "success") last = msg.result;
      }
    }

    const collected = collectFromWorktree(dir);
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
 * failures land on the row as `failed` (incl. missing Chromium).
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
        `${prKey}: ${r.status} (canvases=${Object.keys(r.diagrams).length})`
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
 * Persist the overview markdown + diagram set (JSON). A fresh generation CLEARS
 * `diagramsEditedAt` — the owner's manual edits are gone by definition (Regen is
 * the "start over" verb; the dashboard warns before calling it).
 */
function persist(prKey: string, r: OverviewResult): void {
  updatePrOverview(prKey, {
    overviewMd: r.overviewMd,
    diagrams: r.diagrams,
    overviewHeadSha: r.headSha,
    overviewStatus: r.status,
    overviewGeneratedAt: new Date().toISOString(),
    diagramsEditedAt: null,
    // Risk artifact is persisted alongside the overview (reviewer PRs). Undefined
    // for author PRs leaves the columns untouched; an explicit null clears them.
    ...(r.risksStatus !== undefined ? { risks: r.risks ?? [], risksStatus: r.risksStatus } : {}),
  });
}
