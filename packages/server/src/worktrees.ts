import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "./config.js";

const exec = promisify(execFile);

/** Default branch the base clone is parked on (decision: base stays on master). */
const BASE_BRANCH = "master";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Like `git()` but returns stdout VERBATIM (no trim). Required for `git diff`:
 * a diff whose final hunk line is a blank context line is emitted as a line
 * containing a single space + trailing newline (`" \n"`). Trimming that strips
 * the last context line, leaving the hunk one line short of its `@@` header —
 * git then rejects it as a "corrupt patch" at apply time. Diffs must be byte-exact.
 */
async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** Path to the persistent base clone for a repo (parked on master, holds warm deps). */
export function clonePath(owner: string, repo: string): string {
  return join(loadConfig().reposRoot, `${owner}__${repo}`);
}

/** Root under which per-fix worktrees for a repo live. */
function worktreesDir(owner: string, repo: string): string {
  return join(loadConfig().worktreesRoot, `${owner}__${repo}`);
}

function worktreePath(owner: string, repo: string, threadId: number): string {
  return join(worktreesDir(owner, repo), String(threadId));
}

// ---- base clone (parked on master, warm node_modules) ----

/**
 * Ensure the base clone exists, is parked on `master` synced to origin/master,
 * and (for repos that need it) has dependencies installed. Returns the base dir.
 *
 * Invariant: the base clone is ALWAYS on `master` and never checks out a PR
 * branch, so any PR head branch is free to be claimed by a worktree.
 */
export async function ensureBase(owner: string, repo: string): Promise<string> {
  const cfg = loadConfig();
  mkdirSync(cfg.reposRoot, { recursive: true });
  const dir = clonePath(owner, repo);

  if (!existsSync(join(dir, ".git"))) {
    // Blobless partial clone: keep the FULL commit graph (so the overview/risks
    // agents' `git diff origin/master...HEAD` merge-base still resolves) but
    // fetch file blobs lazily on demand. Cuts a large repo's .git from ~1GB to
    // ~100MB with no feature loss — only occasional lazy fetches when a diff or
    // read touches a not-yet-present blob. (Prefer this over --depth, which
    // would break the three-dot merge-base diff for PRs off older commits.)
    await exec(
      "gh",
      ["repo", "clone", `${owner}/${repo}`, dir, "--", "--no-tags", "--filter=blob:none"],
      { maxBuffer: 32 * 1024 * 1024 }
    );
  }

  // Park on master, synced to origin/master. --force discards any leftover
  // working-tree state from older (pre-worktree) versions of this clone.
  await git(dir, ["fetch", "origin", BASE_BRANCH, "--prune"]);
  await git(dir, ["checkout", "--force", "-B", BASE_BRANCH, `origin/${BASE_BRANCH}`]);
  await git(dir, ["reset", "--hard", `origin/${BASE_BRANCH}`]);

  await provisionDeps(dir);
  return dir;
}

/** Hash the dependency lockfile so we only re-install when it actually changes. */
function lockfileHash(dir: string): string | null {
  for (const name of ["yarn.lock", "package-lock.json"]) {
    const p = join(dir, name);
    if (existsSync(p)) {
      return createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  }
  return null;
}

function depStampPath(dir: string): string {
  return join(dir, "node_modules", ".babysit-deps-hash");
}

/**
 * Install dependencies on the base clone, guarded by the lockfile hash: re-run
 * only when the lockfile changed or node_modules is absent. No-op for repos
 * without a JS lockfile (the gate for those needs no install).
 */
async function provisionDeps(dir: string): Promise<void> {
  const hash = lockfileHash(dir);
  if (!hash) return; // not a node repo — nothing to provision

  const stamp = depStampPath(dir);
  const have = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : null;
  if (have === hash && existsSync(join(dir, "node_modules"))) return; // warm

  const hasYarn = existsSync(join(dir, "yarn.lock"));
  if (hasYarn) {
    // Plain install: the repo's .yarnrc redirects to its vendored yarn and sets
    // ignore-engines, so this matches how a normal dev checkout installs.
    await exec("yarn", ["install", "--frozen-lockfile", "--non-interactive"], {
      cwd: dir,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20 * 60 * 1000,
    });
  } else {
    await exec("npm", ["ci"], {
      cwd: dir,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20 * 60 * 1000,
    });
  }
  // Stamp the installed hash inside node_modules so it's cleared if deps are.
  writeFileSync(stamp, hash);
}

// ---- per-fix worktrees ----

export interface Worktree {
  dir: string;
  remoteSha: string;
}

/**
 * Create a throwaway worktree off the base clone, checked out on the PR head
 * branch, with dependencies shared from the base. The base stays on master.
 */
export async function addWorktree(
  owner: string,
  repo: string,
  headRef: string,
  threadId: number,
  opts: { skipDeps?: boolean } = {}
): Promise<Worktree> {
  const base = await ensureBase(owner, repo);
  const wt = worktreePath(owner, repo, threadId);

  // Clear any stale worktree at this path first (crash/restart residue).
  await removeWorktree(owner, repo, threadId);
  mkdirSync(worktreesDir(owner, repo), { recursive: true });

  await git(base, ["fetch", "origin", headRef, "--prune"]);
  // Detached at the PR head sha: avoids the one-branch-per-worktree restriction
  // entirely, and we push by explicit refspec (HEAD:headRef) anyway.
  await git(base, ["worktree", "add", "--detach", wt, `origin/${headRef}`]);
  const remoteSha = await git(wt, ["rev-parse", "HEAD"]);

  // Read-only consumers (e.g. the PR-overview investigation) never build or run
  // tests, so provisioning deps — a CoW clone of a multi-GB node_modules plus a
  // possible top-up install — is pure waste. Skip it for them.
  if (!opts.skipDeps) await shareDeps(base, wt);
  return { dir: wt, remoteSha };
}

/**
 * Make the base's installed dependencies available in the worktree. Common case
 * (PR doesn't touch deps): symlink the base node_modules. Divergent lockfile:
 * APFS copy-on-write clone + top-up install local to the worktree, so we never
 * mutate the shared base node_modules.
 */
async function shareDeps(base: string, wt: string): Promise<void> {
  const baseNm = join(base, "node_modules");
  if (!existsSync(baseNm)) return; // nothing provisioned (non-node repo)

  const baseHash = lockfileHash(base);
  const wtHash = lockfileHash(wt);

  if (wtHash && baseHash && wtHash === baseHash) {
    // Identical deps → symlink (read-only share; never installed into).
    symlinkSync(baseNm, join(wt, "node_modules"), "dir");
    return;
  }

  // Divergent (or unknown) lockfile → private copy so a top-up install stays
  // local to this worktree. cp -c uses APFS copy-on-write (near-instant).
  await exec("cp", ["-cR", baseNm, join(wt, "node_modules")], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const hasYarn = existsSync(join(wt, "yarn.lock"));
  if (hasYarn) {
    await exec("yarn", ["install", "--non-interactive"], {
      cwd: wt,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20 * 60 * 1000,
    });
  } else if (existsSync(join(wt, "package-lock.json"))) {
    await exec("npm", ["install"], {
      cwd: wt,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20 * 60 * 1000,
    });
  }
}

/** Remove a worktree and its directory. Safe to call when nothing exists. */
export async function removeWorktree(
  owner: string,
  repo: string,
  threadId: number
): Promise<void> {
  const base = clonePath(owner, repo);
  const wt = worktreePath(owner, repo, threadId);
  if (existsSync(join(base, ".git"))) {
    try {
      await git(base, ["worktree", "remove", "--force", wt]);
    } catch {
      // Not a registered worktree (or already gone) — fall through to rm + prune.
    }
  }
  rmSync(wt, { recursive: true, force: true });
  if (existsSync(join(base, ".git"))) {
    try {
      await git(base, ["worktree", "prune"]);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Startup sweep: drop any worktree directory that has no live (in_progress)
 * thread, then prune git's worktree metadata. Recovers kill-9/restart leaks.
 */
export async function sweepWorktrees(liveThreadIds: Set<number>): Promise<void> {
  const cfg = loadConfig();
  if (!existsSync(cfg.worktreesRoot)) return;
  for (const repoEnt of readdirSync(cfg.worktreesRoot, { withFileTypes: true })) {
    if (!repoEnt.isDirectory()) continue;
    const repoDir = join(cfg.worktreesRoot, repoEnt.name);
    for (const wtEnt of readdirSync(repoDir, { withFileTypes: true })) {
      const id = Number(wtEnt.name);
      if (Number.isFinite(id) && liveThreadIds.has(id)) continue; // still in use
      rmSync(join(repoDir, wtEnt.name), { recursive: true, force: true });
    }
  }
  // Prune metadata in every base clone.
  if (existsSync(cfg.reposRoot)) {
    for (const baseEnt of readdirSync(cfg.reposRoot, { withFileTypes: true })) {
      const baseDir = join(cfg.reposRoot, baseEnt.name);
      if (!existsSync(join(baseDir, ".git"))) continue;
      try {
        await git(baseDir, ["worktree", "prune"]);
      } catch {
        /* best-effort */
      }
    }
  }
}

// ---- git operations used by the executor (operate on a worktree dir) ----

export async function headSha(dir: string): Promise<string> {
  return git(dir, ["rev-parse", "HEAD"]);
}

/** Fetch remote head sha for the branch without mutating the working tree. */
export async function remoteHeadSha(dir: string, headRef: string): Promise<string> {
  await git(dir, ["fetch", "origin", headRef]);
  return git(dir, ["rev-parse", `origin/${headRef}`]);
}

export async function gitDiff(dir: string): Promise<string> {
  // VERBATIM (see gitRaw): trimming would drop a trailing blank context line and
  // corrupt the patch at apply time.
  return gitRaw(dir, ["diff", "HEAD"]);
}

/**
 * Check whether a unified diff still applies cleanly onto the worktree's current
 * tree (without modifying it). Used at Approve time: the frozen proposal was
 * built against an older base, so we verify the reviewed hunks still land before
 * pushing. Returns false if the patch no longer applies (the lines moved).
 */
export async function applyPatchCheck(dir: string, diff: string): Promise<boolean> {
  const patch = join(dir, ".babysit-proposal.patch");
  writeFileSync(patch, diff.endsWith("\n") ? diff : diff + "\n");
  try {
    await git(dir, ["apply", "--check", patch]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(patch, { force: true });
  }
}

/** Apply a unified diff to the worktree (mutating it). Throws if it won't apply. */
export async function applyPatch(dir: string, diff: string): Promise<void> {
  const patch = join(dir, ".babysit-proposal.patch");
  writeFileSync(patch, diff.endsWith("\n") ? diff : diff + "\n");
  try {
    await git(dir, ["apply", patch]);
  } finally {
    rmSync(patch, { force: true });
  }
}

export async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ["add", "-A"]);
  // --no-verify skips the repo's client-side git hooks (e.g. husky pre-commit).
  // Those hooks assume `husky install` ran (`.husky/_/husky.sh` exists), which it
  // never does in a throwaway worktree, so they'd abort the commit. Our pre-push
  // gate already self-verifies build/test/lint, so the hooks are redundant here.
  await git(dir, ["commit", "--no-verify", "-m", message]);
}

/** Fast-forward-only push (no --force): git rejects a non-fast-forward push. */
export async function pushFastForward(dir: string, headRef: string): Promise<void> {
  // --no-verify for the same reason as commitAll: skip the repo's client-side
  // pre-push hook, which assumes `husky install` ran in this checkout.
  await git(dir, ["push", "--no-verify", "origin", `HEAD:${headRef}`]);
}
