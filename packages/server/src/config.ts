import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  githubLogin: string;
  pollIntervalMs: number;
  port: number;
  dryRun: boolean;
  reposRoot: string;
  dbPath: string;
  maxThreadAttempts: number;
  botLogins: string[];
  /** Repos to ignore entirely. Entry with "/" matches owner/repo exactly; otherwise matches repo name (any owner). */
  ignoreRepos: string[];
  model: string;
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
  reposRoot: join(homedir(), ".babysit-agent", "repos"),
  dbPath: join(homedir(), ".babysit-agent", "state.db"),
  maxThreadAttempts: 2,
  botLogins: [
    "Copilot",
    "copilot-pull-request-reviewer",
    "copilot-pull-request-reviewer[bot]",
    "codex-connector",
    "codex-connector[bot]",
    "github-actions[bot]",
  ],
  ignoreRepos: [],
  // On Bedrock the model id needs the regional prefix; matches ~/.claude/settings.json.
  model: "us.anthropic.claude-opus-4-8",
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
  merged.reposRoot = expandHome(merged.reposRoot);
  merged.dbPath = expandHome(merged.dbPath);

  // Env overrides for quick toggles.
  if (process.env.BABYSIT_DRY_RUN != null) {
    merged.dryRun = process.env.BABYSIT_DRY_RUN !== "false";
  }
  if (process.env.BABYSIT_PORT) merged.port = Number(process.env.BABYSIT_PORT);

  cached = merged;
  return merged;
}
