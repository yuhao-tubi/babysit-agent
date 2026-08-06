// Per-repo environment setup, driven by config (`repoSetup` in config.json).
//
// Some target repos need host-level preparation BEYOND a plain `yarn install`
// before their deps resolve or their gate runs. `gh auth setup-git` (entrypoint)
// authorizes raw git over HTTPS, but NOT npm/yarn against a private registry —
// npm reads its own `~/.npmrc`, keyed by registry host. So a repo that pulls
// private packages 401s on install until we write that auth.
//
// Keep the generic path (worktrees.ts) repo-agnostic: everything repo-specific
// belongs in config, not in this file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

/** Context handed to each repo's setup step. `dir` is the base clone on master. */
export interface RepoSetupCtx {
  owner: string;
  repo: string;
  dir: string;
}

/**
 * Ensure `~/.npmrc` authorizes `registry` for the given npm `scope`, so
 * `yarn install` can pull that scope's private deps. Idempotent: rewrites only
 * the two lines it manages, preserving any other .npmrc content. Requires
 * GH_TOKEN in the environment (loaded from .env by env.ts) for GitHub Packages;
 * no-op with a warning otherwise.
 */
function ensurePrivateRegistryAuth(scope: string, registry: string): void {
  const token = process.env.NPM_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn(
      `[repo-setup] no NPM_TOKEN/GH_TOKEN in env — skipping ${scope} registry auth; ` +
        `yarn install will 401 on private ${scope}/* packages.`
    );
    return;
  }

  // npm keys auth by registry host, written without the URL scheme.
  const host = registry.replace(/^https?:\/\//, "").replace(/\/*$/, "/");
  const authLine = `//${host}:_authToken=`;
  const scopeLine = `${scope}:registry=`;
  const managed = [`${authLine}${token}`, `${scopeLine}${registry}`];

  const path = join(homedir(), ".npmrc");
  const kept = existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => !l.startsWith(authLine) && !l.startsWith(scopeLine))
    : [];
  const lines = [...kept.filter((l) => l.trim() !== ""), ...managed];
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
}

/**
 * Run the repo's setup step (if any) before dependency provisioning. Matches
 * `config.repoSetup` on "owner/repo" first, then bare repo name (any owner).
 * No-op for unmapped repos.
 */
export async function runRepoSetup(ctx: RepoSetupCtx): Promise<void> {
  const { repoSetup } = loadConfig();
  const entry = repoSetup[`${ctx.owner}/${ctx.repo}`] ?? repoSetup[ctx.repo];
  if (!entry) return;
  if (entry.npmScope && entry.npmRegistry) {
    ensurePrivateRegistryAuth(entry.npmScope, entry.npmRegistry);
  }
}
