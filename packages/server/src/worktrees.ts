import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/** Path to the local clone for a repo. */
export function clonePath(owner: string, repo: string): string {
  return join(loadConfig().reposRoot, `${owner}__${repo}`);
}

/**
 * Ensure a clone exists and is checked out on the PR head branch, synced to remote.
 * Returns the clone path and the remote head sha.
 */
export async function ensureClone(
  owner: string,
  repo: string,
  headRef: string
): Promise<{ dir: string; remoteSha: string }> {
  const cfg = loadConfig();
  mkdirSync(cfg.reposRoot, { recursive: true });
  const dir = clonePath(owner, repo);

  if (!existsSync(join(dir, ".git"))) {
    await exec("gh", ["repo", "clone", `${owner}/${repo}`, dir, "--", "--no-tags"], {
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  await git(dir, ["fetch", "origin", headRef, "--prune"]);
  // Hard-reset onto the remote head branch (clones are throwaway working copies).
  await git(dir, ["checkout", "-B", headRef, `origin/${headRef}`]);
  await git(dir, ["reset", "--hard", `origin/${headRef}`]);
  const remoteSha = await git(dir, ["rev-parse", "HEAD"]);
  return { dir, remoteSha };
}

/** Current local HEAD sha. */
export async function headSha(dir: string): Promise<string> {
  return git(dir, ["rev-parse", "HEAD"]);
}

/** Fetch remote head sha for the branch without mutating the working tree. */
export async function remoteHeadSha(dir: string, headRef: string): Promise<string> {
  await git(dir, ["fetch", "origin", headRef]);
  return git(dir, ["rev-parse", `origin/${headRef}`]);
}

export async function gitDiff(dir: string): Promise<string> {
  return git(dir, ["diff", "HEAD"]);
}

export async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", message]);
}

/** Fast-forward-only push (plan decision #9). Throws if remote rejects. */
export async function pushFastForward(dir: string, headRef: string): Promise<void> {
  // No --force: a non-fast-forward push is rejected by git, which is what we want.
  await git(dir, ["push", "origin", `HEAD:${headRef}`]);
}
