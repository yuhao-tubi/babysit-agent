// Per-repo environment setup, keyed by "owner/repo".
//
// Some target repos need host-level preparation BEYOND a plain `yarn install`
// before their deps resolve or their gate runs. `gh auth setup-git` (entrypoint)
// authorizes raw git over HTTPS, but NOT npm/yarn against a private registry —
// npm reads its own `~/.npmrc`, keyed by registry host. So a repo that pulls
// private packages 401s on install until we write that auth.
//
// This map is the single place that repo-specific setup lives. Today only
// adRise/www needs an entry (GitHub Packages auth for its @adrise/* deps).
// Add a new key here when a new repo needs bespoke provisioning — keep the
// generic path (worktrees.ts) repo-agnostic.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Context handed to each repo's setup step. `dir` is the base clone on master. */
export interface RepoSetupCtx {
  owner: string;
  repo: string;
  dir: string;
}

type RepoSetup = (ctx: RepoSetupCtx) => Promise<void> | void;

/**
 * Ensure `~/.npmrc` authorizes GitHub Packages for the @adrise scope so
 * `yarn install` can pull private @adrise/* deps (which are resolved to
 * https://npm.pkg.github.com/ in the lockfile). Idempotent: rewrites only our
 * two managed lines, preserving any other .npmrc content. Requires GH_TOKEN in
 * the environment (loaded from .env by env.ts); no-op with a warning otherwise.
 */
function ensureGithubPackagesAuth(): void {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn(
      "[repo-setup] no GH_TOKEN in env — skipping GitHub Packages auth; " +
        "yarn install will 401 on private @adrise/* packages."
    );
    return;
  }

  const managed = [
    `//npm.pkg.github.com/:_authToken=${token}`,
    "@adrise:registry=https://npm.pkg.github.com/",
  ];
  const path = join(homedir(), ".npmrc");
  const kept = existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(
          (l) =>
            !l.startsWith("//npm.pkg.github.com/:_authToken=") &&
            !l.startsWith("@adrise:registry=")
        )
    : [];
  const lines = [...kept.filter((l) => l.trim() !== ""), ...managed];
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
}

const SETUPS: Record<string, RepoSetup> = {
  "adRise/www": () => ensureGithubPackagesAuth(),
};

/**
 * Run the repo's setup step (if any) before dependency provisioning. Matches on
 * "owner/repo" first, then bare repo name (any owner). No-op for unmapped repos.
 */
export async function runRepoSetup(ctx: RepoSetupCtx): Promise<void> {
  const fn = SETUPS[`${ctx.owner}/${ctx.repo}`] ?? SETUPS[ctx.repo];
  if (fn) await fn(ctx);
}
