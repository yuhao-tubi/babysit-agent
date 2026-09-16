import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceRoot } from "./paths.js";
import { getBedrockSession, resolveModelArn } from "./bedrock-auth.js";
import type { CheckAllowEntry } from "./ci.js";
import type { AuthorClass } from "./types.js";

/** CI-feedback config (decision Q24). */
export interface CiConfig {
  /**
   * Repos where CI babysitting is on. Same matching as ignoreRepos (bare name
   * matches any owner; "owner/repo" matches exactly). Empty = CI off everywhere.
   * This per-repo opt-in is the sole CI enablement switch.
   */
  enabledRepos: string[];
  /** Which checks to babysit, and the gate class each maps to. */
  checkAllowlist: CheckAllowEntry[];
}

/**
 * Host-level prep a specific target repo needs before `yarn install` can resolve
 * its deps (see repo-setup.ts). Keyed by "owner/repo" (or a bare repo name, any
 * owner) in `Config.repoSetup`.
 */
export interface RepoSetupConfig {
  /**
   * npm scope whose packages live on a private registry (e.g. "@myorg"). Written
   * to `~/.npmrc` together with `npmRegistry`, authenticated with
   * NPM_TOKEN/GH_TOKEN. Both keys must be set for the step to run.
   */
  npmScope?: string;
  /** Registry serving `npmScope` (e.g. "https://npm.pkg.github.com/"). */
  npmRegistry?: string;
}

export interface Config {
  githubLogin: string;
  pollIntervalMs: number;
  port: number;
  dryRun: boolean;
  reposRoot: string;
  /** Where per-fix git worktrees live (separate from the persistent base clones). */
  worktreesRoot: string;
  dbPath: string;
  /** Where CI failure logs are materialized (OUTSIDE any worktree, so never committed). */
  ciLogsRoot: string;
  maxThreadAttempts: number;
  /** Max times the fix agent re-runs to repair gate (lint/typecheck) errors it introduced, per fix. */
  maxGateFixAttempts: number;
  /**
   * Max files a proposed code change may touch (source + test + config, no
   * exemptions) before it is deemed too large to apply autonomously. Over the
   * limit, the fix is abandoned and the Thread pivots to a Manual plan (the
   * copy-paste-into-Claude-Code handoff) instead of parking a Proposal. Keeps
   * every auto-applied change an easy, reviewable fix. Also softly hinted to the
   * fix agent so it bails early. Default 5.
   */
  maxProposalFiles: number;
  /**
   * Agent turn budget for a review-comment Verdict (the read-only investigation
   * that grounds the decision). Raise it for large monorepos where locating the
   * cited code takes more exploration. Running out is not fatal — the streamed
   * verdict block is salvaged, else the Thread escalates — but a too-tight budget
   * wastes a full agent run. Default 60.
   */
  verdictMaxTurns: number;
  /**
   * Same, for a CI-failure Verdict: reading a large failing-check log AND
   * investigating source needs materially more headroom than review triage.
   * Default 80.
   */
  verdictCiMaxTurns: number;
  botLogins: string[];
  /**
   * Authors whose feedback is ignored entirely: no Verdict is run — the Thread is
   * marked resolved directly. Matches case-insensitively, tolerant of a trailing
   * "[bot]" suffix (so `github-actions` catches `github-actions[bot]`).
   */
  ignoreAuthors: string[];
  /** Repos to ignore entirely. Entry with "/" matches owner/repo exactly; otherwise matches repo name (any owner). */
  ignoreRepos: string[];
  /** If non-empty, ONLY these repos are processed (allow-list). Same matching as ignoreRepos. */
  allowRepos: string[];
  /**
   * Author classes allowed to push WITHOUT owner approval when the gate passes.
   * Default `[]` = nothing auto-pushes; every change parks at `awaiting_approval`
   * for the owner to Approve. Add e.g. `["ci"]` to let gate-verified CI fixes
   * push silently, `["ci","bot"]` to also auto-push bot-nit fixes. `risk:"high"`
   * always vetoes auto-push regardless of this list.
   */
  autoPushClasses: AuthorClass[];
  /** TVM friendly model name to resolve to a Bedrock inference-profile ARN (e.g. "claude-sonnet"). */
  bedrockModelName: string;
  /** CI-feedback settings. */
  ci: CiConfig;
  /** PR-level overview + diagram settings (a read-only, on-demand Session artifact). */
  overview: OverviewConfig;
  /** Thread-level Explanation settings (a read-only, on-demand Thread artifact). */
  explain: ExplainConfig;
  /**
   * Per-repo host prep, keyed by "owner/repo" (or a bare repo name, any owner).
   * Empty = no repo needs bespoke provisioning; the generic clone + install path
   * is used everywhere. See repo-setup.ts.
   */
  repoSetup: Record<string, RepoSetupConfig>;
}

/**
 * Explanation config. Its OWN block rather than a key under `overview`: an
 * Explanation is Thread-grained and answers one question, whereas everything
 * under `overview` is PR-grained — filing it there would mislead the next reader.
 */
export interface ExplainConfig {
  /** Master switch for the Explain feature. */
  enabled: boolean;
  /**
   * Agent turn budget for ONE question. Sized near `verdictMaxTurns` (a localized
   * investigation of a few files), NOT `overview.maxTurns` (a PR-wide sweep plus
   * diagram authoring) — the work is much closer to review triage.
   */
  maxTurns: number;
}

/** PR-overview config (decisions 14/15). */
export interface OverviewConfig {
  /** Master switch for the overview + diagram feature. */
  enabled: boolean;
  /** Agent turn budget for the read-only PR-wide investigation. */
  maxTurns: number;
  /**
   * Auto-generate the review brief for REVIEWER-role PRs the poll cycle has never
   * generated one for, so it's already waiting when you open the PR (the whole
   * point: you were clicking Generate and waiting). Author PRs are excluded — they
   * run on the expensive default model and you wrote the code. Read-only, so
   * `dryRun` does not gate it. Flip false to make every brief click-only again.
   */
  autoGenerate: boolean;
  /**
   * Ceiling on auto-generated briefs started per poll cycle (newest PR first).
   * Bounds the day-one backlog: a pile of open review requests drains a couple per
   * cycle instead of launching a stampede of agents and worktrees at once. 0 has
   * the same effect as `autoGenerate: false`.
   */
  autoMaxPerCycle: number;
  /**
   * Model for the READ-ONLY, reviewer-facing artifacts — reviewer
   * overview + Verified Risk Analysis, the PR-comprehension quiz, and reviewer
   * Q&A. These consume-or-ask flows favor speed, so they may run on a
   * faster/cheaper model than the author path. Author overview + Blind spots stay
   * on `bedrockModelName`, as does the whole verdict/gate/executor push path.
   * Must be a model the TVM token can invoke. Default `claude-sonnet`.
   */
  reviewerModelName: string;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

const DEFAULTS: Config = {
  // No default owner — `make setup` (or config.json) must supply it. Blank means
  // classify.ts can never mistake someone else's login for the owner's.
  githubLogin: "",
  pollIntervalMs: 300_000,
  port: 4317,
  dryRun: true,
  // Repos hold the EXPENSIVE per-repo provisioning (clone + warm node_modules +
  // private-package auth + pre-build), so they sit OUTSIDE cache/. Worktrees and
  // CI logs derive from a base clone and are cheap to rebuild — they live under
  // cache/ so it can be wiped wholesale (a stuck worktree, stale logs) without
  // paying the reprovision cost. See README "Recovering a wedged clone".
  reposRoot: join(homedir(), ".babysit-agent", "repos"),
  worktreesRoot: join(homedir(), ".babysit-agent", "cache", "worktrees"),
  dbPath: join(homedir(), ".babysit-agent", "state.db"),
  ciLogsRoot: join(homedir(), ".babysit-agent", "cache", "ci-logs"),
  maxThreadAttempts: 2,
  maxGateFixAttempts: 2,
  maxProposalFiles: 5,
  // Raised from 40/60: on a large monorepo, a bot nit routinely spent the whole
  // budget just locating the cited code, and the run ended with no verdict.
  verdictMaxTurns: 60,
  verdictCiMaxTurns: 80,
  botLogins: [
    "Copilot",
    "copilot-pull-request-reviewer",
    "copilot-pull-request-reviewer[bot]",
    "codex-connector",
    "codex-connector[bot]",
    "github-actions[bot]",
  ],
  ignoreAuthors: ["github-actions", "dependabot"],
  ignoreRepos: [],
  // Blank = every authored PR is in scope. Set this in config.json to hard-scope
  // the pipeline to the repos whose build/lint env you have verified.
  allowRepos: [],
  // Default: nothing auto-pushes — every change parks for owner Approve.
  autoPushClasses: [],
  // Agent SDK auth goes through the Bedrock TVM (bearer tokens), not an AWS
  // profile. This selects which inference-profile ARN to invoke; see bedrock-auth.ts.
  bedrockModelName: "claude-sonnet",
  ci: {
    // Per-repo opt-in. Empty = CI babysitting OFF everywhere — the current
    // default while the CI-failure workflow is rebuilt. The allowlist below is
    // kept as documentation and so re-enabling a repo is a one-key change.
    enabledRepos: [],
    checkAllowlist: [
      { pattern: "eslint", class: "lint" },
      { pattern: "lint", class: "lint" },
      { pattern: "typecheck", class: "typecheck" },
      { pattern: "type-check", class: "typecheck" },
      { pattern: "tsc", class: "typecheck" },
      { pattern: "build", class: "build" },
      { pattern: "unit", class: "unit_test" },
      { pattern: "test", class: "unit_test" },
    ],
  },
  overview: {
    enabled: true,
    // A PR-wide investigation PLUS authoring up to three SVG diagrams in one pass
    // each, PLUS (reviewer PRs) the finder→confirmer risk analysis in the same
    // budget. Generous so a large PR's investigation + repair retry all fit.
    maxTurns: 150,
    // On by default: a review request you're pinged about should be prepped before
    // you open it.
    autoGenerate: true,
    // Sized to the artifact lane's width, NOT independently: the lane runs
    // ARTIFACT_CONCURRENCY (8) read-only jobs per repo at once, and starting only 2
    // per 5-minute poll meant a 16-PR backlog took 40 minutes just to get ENQUEUED
    // — the lane sat 3/8 busy while briefs waited on the clock rather than on any
    // resource. 6 keeps the lane fed without exceeding it in a single cycle (the
    // queue would absorb the excess anyway, but a burst larger than the width just
    // front-loads worktree churn). Raise these two together or neither.
    autoMaxPerCycle: 6,
    // Reviewer-facing read-only artifacts run on sonnet for speed; author work
    // and the push path stay on bedrockModelName. See OverviewConfig.
    reviewerModelName: "claude-sonnet",
  },
  explain: {
    enabled: true,
    // One question, usually localized to a few files — start at the review-triage
    // budget (verdictMaxTurns) rather than the PR-wide overview budget.
    maxTurns: 60,
  },
  repoSetup: {},
};

let cached: Config | null = null;

/** Project root (the workspace dir containing config.json). */
function projectRoot(): string {
  return workspaceRoot();
}

export function loadConfig(): Config {
  if (cached) return cached;
  const configPath =
    process.env.BABYSIT_CONFIG ?? join(projectRoot(), "config.json");

  let fileCfg: Partial<Config> = {};
  if (existsSync(configPath)) {
    fileCfg = JSON.parse(readFileSync(configPath, "utf8"));
  } else {
    console.warn(
      `[config] no config.json at ${configPath}; using defaults (dryRun=true).`
    );
  }

  const merged: Config = { ...DEFAULTS, ...fileCfg };
  // Shallow spread would let a partial `ci` block drop the defaults — merge it.
  merged.ci = { ...DEFAULTS.ci, ...(fileCfg.ci ?? {}) };
  merged.overview = { ...DEFAULTS.overview, ...(fileCfg.overview ?? {}) };
  merged.explain = { ...DEFAULTS.explain, ...(fileCfg.explain ?? {}) };

  // Containerized runs bind-mount a single data dir (see Dockerfile). When
  // BABYSIT_DATA_DIR is set, root the heavy runtime state (db + clones +
  // worktrees) under it — but only for paths config.json did NOT set
  // explicitly, so an operator override in config.json still wins. Repos are
  // the expensive-to-reprovision tier and sit at the root; worktrees + ci-logs
  // derive from them and live under cache/ (wholesale-wipeable). Keep this
  // layout identical to the native defaults above.
  const dataDir = process.env.BABYSIT_DATA_DIR;
  if (dataDir) {
    if (fileCfg.reposRoot == null) merged.reposRoot = join(dataDir, "repos");
    if (fileCfg.worktreesRoot == null) merged.worktreesRoot = join(dataDir, "cache", "worktrees");
    if (fileCfg.dbPath == null) merged.dbPath = join(dataDir, "state.db");
    if (fileCfg.ciLogsRoot == null) merged.ciLogsRoot = join(dataDir, "cache", "ci-logs");
  }

  merged.reposRoot = expandHome(merged.reposRoot);
  merged.worktreesRoot = expandHome(merged.worktreesRoot);
  merged.dbPath = expandHome(merged.dbPath);
  merged.ciLogsRoot = expandHome(merged.ciLogsRoot);

  // Env overrides for quick toggles.
  if (process.env.BABYSIT_DRY_RUN != null) {
    merged.dryRun = process.env.BABYSIT_DRY_RUN !== "false";
  }
  if (process.env.BABYSIT_PORT) merged.port = Number(process.env.BABYSIT_PORT);

  cached = merged;
  return merged;
}

/**
 * Environment + model for the Agent SDK subprocess. We pass `settingSources: []`
 * to the SDK (so it ignores ~/.claude/settings.json), which means Bedrock
 * routing must be supplied explicitly here — otherwise the SDK defaults to the
 * direct Anthropic API and rejects the Bedrock model id.
 *
 * Auth is a TVM-vended bearer token (AWS_BEARER_TOKEN_BEDROCK), not an AWS
 * profile. The model must be the inference-profile ARN that token is scoped to.
 * Async because minting/refreshing the token is a network call.
 *
 * `modelName` optionally selects a non-default model (e.g. `claude-sonnet` for
 * the read-only reviewer artifacts) under the SAME token; omitted ⇒ the default
 * `bedrockModelName`. The env (token/region) is identical either way — only the
 * returned `modelArn` differs.
 */
/**
 * Reasoning effort for the READ-ONLY artifact agents (overview + diagrams, risk
 * analysis, quiz, Explanation, reviewer Q&A).
 *
 * This exists because the model default is not a neutral choice. The agent
 * options never set `thinking`, and what that MEANS changed under us when
 * `bedrockModelName` moved from opus to sonnet:
 *
 *   claude-opus-4-8   omitting `thinking` ⇒ no extended thinking at all
 *   claude-sonnet-5   omitting `thinking` ⇒ adaptive thinking, effort `high`
 *
 * So the model swap silently switched deep reasoning on for every agent path. A
 * measured overview run: 772s wall clock, of which 648s (84%) was the model
 * thinking and 34s was actually running tools — 67 turns, 31 thinking blocks,
 * 127k output tokens for one PR brief. The dashboard's "may take a minute"
 * became thirteen.
 *
 * `low` is right for THESE agents specifically: they are read-only (no push, no
 * comment, no gate), the owner reads the result and judges it, and their value is
 * being ready before you open the PR — a brief that arrives late has already lost
 * most of its point. The verdict/gate/executor path deliberately does NOT use
 * this: it decides what gets pushed to a real PR, so it keeps full reasoning.
 */
export const ARTIFACT_EFFORT = "low" as const;

/**
 * Reasoning effort for the DECIDING agents — the Verdict, the plan pass, and the
 * fix agent that authors a diff.
 *
 * Deliberately a step above `ARTIFACT_EFFORT`, and deliberately not `high`. These
 * runs produce the bytes that get pushed to a real PR, so they are the last place
 * to economise; but `high` is also not a free choice — one measured Verdict run
 * spent 589s and 86,956 output tokens across 93 turns, and that run is the second
 * largest contributor to a Thread's wall clock after queue wait.
 *
 * `medium` keeps adaptive thinking on (it is the grounding these decisions rest
 * on) while cutting the per-turn latency that made a Thread take an hour. Nothing
 * downstream is relaxed to pay for it: the gate still verifies every diff, and a
 * change still parks at `awaiting_approval` for the owner. If Verdict quality
 * visibly regresses, this constant is the one thing to raise — before touching any
 * guardrail.
 */
export const DECISION_EFFORT = "medium" as const;

export async function sdkEnv(modelName?: string): Promise<{
  env: Record<string, string>;
  modelArn: string;
}> {
  const session = await getBedrockSession();
  const modelArn = await resolveModelArn(modelName);
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env.CLAUDE_CODE_USE_BEDROCK = "1";
  env.AWS_BEARER_TOKEN_BEDROCK = session.token;
  env.AWS_REGION = session.region;
  env.AWS_DEFAULT_REGION = session.region;
  return { env, modelArn };
}
