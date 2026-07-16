import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getBedrockSession } from "./keysmith.js";
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
  /** KeySmith friendly model name to resolve to a Bedrock inference-profile ARN (e.g. "claude-opus"). */
  bedrockModelName: string;
  /** CI-feedback settings. */
  ci: CiConfig;
  /** PR-level overview + diagram settings (a read-only, on-demand Session artifact). */
  overview: OverviewConfig;
}

/** PR-overview config (decisions 14/15). */
export interface OverviewConfig {
  /** Master switch for the overview + diagram feature. */
  enabled: boolean;
  /** Agent turn budget for the read-only PR-wide investigation. */
  maxTurns: number;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

const DEFAULTS: Config = {
  githubLogin: "yuhao-tubi",
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
  botLogins: [
    "Copilot",
    "copilot-pull-request-reviewer",
    "copilot-pull-request-reviewer[bot]",
    "codex-connector",
    "codex-connector[bot]",
    "github-actions[bot]",
  ],
  ignoreAuthors: ["tubi-laborador", "github-actions"],
  ignoreRepos: [],
  // Hard-scope the whole pipeline to the one repo whose build/lint env we know.
  allowRepos: ["adRise/www"],
  // Default: nothing auto-pushes — every change parks for owner Approve.
  autoPushClasses: [],
  // Agent SDK auth goes through KeySmith (Bedrock bearer tokens), not an AWS
  // profile. This selects which inference-profile ARN to invoke; see keysmith.ts.
  bedrockModelName: "claude-opus",
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
    // A PR-wide investigation PLUS authoring up to three Excalidraw canvases,
    // each through a write→render→view→fix loop (2–4 iterations). That loop is
    // turn-hungry, so the budget is well above the old prose-only 60.
    maxTurns: 150,
  },
};

let cached: Config | null = null;

/** Project root (the workspace dir containing config.json). */
function projectRoot(): string {
  // config.ts lives at packages/server/src/config.ts
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..");
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
 * Auth is a KeySmith-vended bearer token (AWS_BEARER_TOKEN_BEDROCK), not an AWS
 * profile. The model must be the inference-profile ARN that token is scoped to.
 * Async because minting/refreshing the token is a network call.
 */
export async function sdkEnv(): Promise<{
  env: Record<string, string>;
  modelArn: string;
}> {
  const session = await getBedrockSession();
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env.CLAUDE_CODE_USE_BEDROCK = "1";
  env.AWS_BEARER_TOKEN_BEDROCK = session.token;
  env.AWS_REGION = session.region;
  env.AWS_DEFAULT_REGION = session.region;
  return { env, modelArn: session.modelArn };
}
