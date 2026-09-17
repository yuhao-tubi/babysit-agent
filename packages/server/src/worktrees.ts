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
import { runRepoSetup } from "./repo-setup.js";
import { withBaseLock } from "./queue.js";

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

  // Repo-specific host prep (e.g. private-registry auth, see config.repoSetup) BEFORE deps —
  // otherwise provisionDeps' `yarn install` 401s on private packages.
  await runRepoSetup({ owner, repo, dir });
  await provisionDeps(dir);
  await provisionPackageBuilds(dir);
  return dir;
}

/** Sha the base clone's workspace-package `lib/` outputs were last built from. */
function buildStampPath(dir: string): string {
  return join(dir, ".git", "babysit-package-build-sha");
}

/**
 * Keep the base clone's workspace-package build outputs (`packages/<pkg>/lib`) in sync
 * with base-branch HEAD. These are what `seedBuildArtifacts` CoW-copies into every
 * worktree and what the light gate typechecks the app against — so if they lag,
 * EVERY thread's gate reports the app's use of a since-added export as an error in
 * files no fix touched, and every proposal parks `gate_inconclusive`. Nothing else
 * refreshes them: `provisionDeps` only installs `node_modules`, and the gate's
 * builds run inside the throwaway worktree, never in base. Left alone, the base's
 * `lib/` stays frozen at whenever it was first built while master moves on for
 * weeks.
 *
 * Guarded by a sha stamp so the cost is paid only when it's needed: rebuild just
 * the packages whose sources changed between the stamp and current HEAD (scoped
 * `lerna run build`), not the whole `pre-build` fan-out. With no stamp (first run
 * on this clone) there's no delta to compute, so build every package once and
 * stamp — every later poll is then incremental. The stamp lives under `.git/`,
 * which `git worktree add` does not copy, so worktrees never inherit it.
 *
 * Best-effort: a build failure leaves the stamp unmoved (so the next poll retries)
 * and never blocks the worktree — the gate still runs, just against older
 * declarations, which is exactly today's behavior.
 */
async function provisionPackageBuilds(dir: string): Promise<void> {
  if (!existsSync(join(dir, "packages"))) return; // not a workspace monorepo
  const lerna = existsSync(join(dir, "lerna.json"));
  if (!lerna) return;

  const head = await git(dir, ["rev-parse", "HEAD"]);
  const stamp = buildStampPath(dir);
  const had = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : null;
  if (had === head) return; // already built at this sha

  let scopes: string[] | null = null; // null => build everything
  if (had) {
    // Only the packages whose sources moved since the last build need redoing.
    let changed: string[] = [];
    try {
      changed = (await git(dir, ["diff", "--name-only", "-z", `${had}..${head}`]))
        .split("\0")
        .filter(Boolean);
    } catch {
      // Stamped sha is gone (history rewrite / gc) — fall back to a full build.
      changed = [];
    }
    const dirs = new Set<string>();
    for (const f of changed) {
      const m = /^packages\/([^/]+)\//.exec(f);
      if (m) dirs.add(m[1]);
    }
    if (dirs.size) {
      scopes = [];
      for (const d of dirs) {
        const name = packageName(join(dir, "packages", d));
        if (name) scopes.push(name);
      }
      if (!scopes.length) {
        // Touched packages have no buildable name — nothing to do, but the tree IS
        // current, so stamp it so we don't recompute this delta every poll.
        writeFileSync(stamp, head);
        return;
      }
    } else if (changed.length) {
      // Commits landed, but none in packages/ — outputs are still valid. Stamp.
      writeFileSync(stamp, head);
      return;
    }
  }

  const args = ["lerna", "run", "build"];
  for (const s of scopes ?? []) args.push("--scope", s);
  try {
    await exec("yarn", args, {
      cwd: dir,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
    writeFileSync(stamp, head);
  } catch {
    /* best-effort: leave the stamp so the next poll retries */
  }
}

/** A workspace package's declared name, or null if it has no `build` script. */
function packageName(pkgDir: string): string | null {
  const p = join(pkgDir, "package.json");
  if (!existsSync(p)) return null;
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    return pkg?.name && pkg?.scripts?.build ? pkg.name : null;
  } catch {
    return null;
  }
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
  opts: { skipDeps?: boolean; lightDeps?: boolean; extraRefs?: string[] } = {}
): Promise<Worktree> {
  const wt = worktreePath(owner, repo, threadId);

  // Everything that touches the SHARED base `.git` (ensureBase's fetch/checkout/
  // reset, the stale-worktree cleanup, the head fetch, and `worktree add`) runs
  // under a per-repo base lock. Thread work and artifact generation now use
  // separate queues that run concurrently, so without this two `addWorktree`
  // calls could mutate the same base clone's index/refs at once and hit git's
  // own lock errors. The lock covers ONLY this short git critical section; the
  // long, per-worktree-directory work below (dep sharing, artifact seeding, and
  // the caller's agent run) stays outside it so generations still parallelize.
  const { base, remoteSha } = await withBaseLock(`${owner}/${repo}`, async () => {
    const base = await ensureBase(owner, repo);
    // Clear any stale worktree at this path first (crash/restart residue).
    // Unlocked variant: we already hold the base lock here (non-reentrant).
    await removeWorktreeUnlocked(owner, repo, threadId);
    mkdirSync(worktreesDir(owner, repo), { recursive: true });

    await git(base, ["fetch", "origin", headRef, "--prune"]);
    // Extra branches the agent must be able to name but not check out — the other
    // layers of a PR Stack, so `git diff origin/<layer>` works (see verdict.ts).
    // Best-effort: a branch that was renamed or deleted since the last poll must
    // never fail the worktree, so a combined fetch falls back to per-ref tries and
    // any ref that still won't fetch is simply absent (the agent's diff on it
    // errors, which is a missing input, not a broken run).
    const extra = [...new Set(opts.extraRefs ?? [])].filter((r) => r && r !== headRef);
    if (extra.length) {
      await git(base, ["fetch", "origin", ...extra]).catch(async () => {
        for (const ref of extra) await git(base, ["fetch", "origin", ref]).catch(() => {});
      });
    }
    // Detached at the PR head sha: avoids the one-branch-per-worktree restriction
    // entirely, and we push by explicit refspec (HEAD:headRef) anyway.
    await git(base, ["worktree", "add", "--detach", wt, `origin/${headRef}`]);
    const remoteSha = await git(wt, ["rev-parse", "HEAD"]);
    return { base, remoteSha };
  });

  // Read-only consumers (e.g. the PR-overview investigation) never build or run
  // tests, so provisioning deps — a CoW clone of a multi-GB node_modules plus a
  // possible top-up install — is pure waste. Skip it for them. This works in the
  // per-id worktree dir only (base node_modules is read as a symlink/CoW source),
  // so it is safe outside the base lock.
  if (!opts.skipDeps) {
    await shareDeps(base, wt, { light: opts.lightDeps });
    await seedBuildArtifacts(base, wt);
  }
  return { dir: wt, remoteSha };
}

/**
 * Seed the base clone's already-compiled, gitignored build outputs into the
 * worktree so the gate doesn't have to rebuild them. A monorepo's internal
 * packages (e.g. a `@myorg/*` scope) resolve via each package's built
 * `lib/*.d.ts`, but those are gitignored — a fresh `git worktree add` doesn't
 * bring them, which is what forces `pre-build` (`lerna run build`) to run before
 * every typecheck. The base clone builds them once (during CI-fix gates); reuse
 * that here via APFS copy-on-write (near-instant) so the light gate can run an
 * INCREMENTAL `typecheck-app` against seeded `.d.ts` + `.tsbuildinfo` instead of
 * a full monorepo build. Repo-agnostic and best-effort: no-op when the base has
 * no such artifacts, and a copy failure never blocks the worktree.
 */
async function seedBuildArtifacts(base: string, wt: string): Promise<void> {
  const copyCoW = async (rel: string) => {
    const src = join(base, rel);
    const dst = join(wt, rel);
    if (!existsSync(src) || existsSync(dst)) return;
    try {
      await exec("cp", ["-cR", src, dst], { maxBuffer: 64 * 1024 * 1024 });
    } catch {
      /* best-effort — the gate rebuilds if the artifact is missing */
    }
  };

  // Built package outputs: packages/<pkg>/lib (compiled .js + .d.ts).
  const pkgsDir = join(base, "packages");
  if (existsSync(pkgsDir)) {
    for (const ent of readdirSync(pkgsDir, { withFileTypes: true })) {
      if (ent.isDirectory()) await copyCoW(join("packages", ent.name, "lib"));
    }
  }
  // Incremental tsc state at the repo root (makes typecheck-app incremental).
  for (const ent of readdirSync(base, { withFileTypes: true })) {
    if (ent.isFile() && ent.name.endsWith(".tsbuildinfo")) await copyCoW(ent.name);
  }
}

/**
 * Dependency names declared in a checkout's `package.json` that MUST resolve —
 * `dependencies` + `devDependencies`. These are clean import specifiers (unlike
 * a yarn.lock header, which mangles them into alias forms), so they map directly
 * to a `node_modules/<name>` directory. Returns null when there's no readable
 * package.json (treated as "can't prove safe" by the caller).
 *
 * `optionalDependencies` are DELIBERATELY excluded: a package's cross-platform
 * native variants ship as optional deps (e.g. @statsig/statsig-node-core has one
 * entry per os/arch), and the installer only materializes the ONE matching the
 * host — every other platform's variant is legitimately absent on any given
 * machine. Counting those as "missing" made the presence check fail for nearly
 * every real PR (they all carry such optionals), so shareDeps never took the
 * symlink fast path. An optional dep being absent never breaks a typecheck/lint
 * gate, so it must not force the expensive copy+install.
 */
function declaredDeps(dir: string): string[] | null {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return null;
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    return Object.keys({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    });
  } catch {
    return null;
  }
}

/**
 * True when EVERY package the worktree declares is already present in the base
 * `node_modules`. A patch/minor version bump of an existing package leaves the
 * package directory present (only its contents differ), which is fine for a
 * typecheck/lint gate — the `.d.ts` shape is stable across such bumps. The only
 * case a symlinked base tree can't satisfy is a package the PR ADDS that base
 * never installed → `TS2307: Cannot find module`. So "all declared deps present
 * in base" is the safe-to-symlink condition for the light gate. A scoped `@x/y`
 * dep lives at `node_modules/@x/y`; `join` handles the slash.
 */
export function allDepsPresentInBase(base: string, wt: string): boolean {
  const deps = declaredDeps(wt);
  if (!deps) return false; // can't prove safe → caller falls back to copy
  const baseNm = join(base, "node_modules");
  return deps.every((name) => existsSync(join(baseNm, name)));
}

/**
 * Make the base's installed dependencies available in the worktree. Common case
 * (PR doesn't touch deps): symlink the base node_modules. Divergent lockfile:
 * APFS copy-on-write clone + top-up install local to the worktree, so we never
 * mutate the shared base node_modules.
 *
 * `light` (owner-reviewed proposals whose gate only typechecks/lints changed
 * source — see gate.ts runLightGate): symlink even when the lockfile diverged,
 * SO LONG AS every package the PR declares is already installed in base. This
 * skips the multi-GB CoW copy + full `yarn install` that a single version bump
 * (e.g. one internal-package patch) would otherwise force, since a typecheck/lint gate
 * doesn't depend on exact dep VERSIONS — only on the modules being resolvable.
 * A PR that adds a brand-new dependency still takes the copy+install path. NOT
 * used for CI-fix / full-gate threads, which run the real test suite and need
 * the exact installed versions.
 */
async function shareDeps(
  base: string,
  wt: string,
  opts: { light?: boolean } = {}
): Promise<void> {
  const baseNm = join(base, "node_modules");
  if (!existsSync(baseNm)) return; // nothing provisioned (non-node repo)

  const baseHash = lockfileHash(base);
  const wtHash = lockfileHash(wt);

  if (wtHash && baseHash && wtHash === baseHash) {
    // Identical deps → symlink (read-only share; never installed into).
    symlinkSync(baseNm, join(wt, "node_modules"), "dir");
    return;
  }

  // Light gate + only version bumps of already-installed packages → symlink base
  // deps and skip the copy/install entirely (see doc comment). A newly-ADDED dep
  // fails the presence check and falls through to the copy path below.
  if (opts.light && allDepsPresentInBase(base, wt)) {
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

/**
 * Remove a worktree and its directory — the base-git critical section, WITHOUT
 * taking the base lock. Call this only from a context that already holds the
 * lock (e.g. inside `addWorktree`'s locked section) to avoid a self-deadlock,
 * since the lock is non-reentrant.
 */
async function removeWorktreeUnlocked(
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
 * Remove a worktree and its directory. Safe to call when nothing exists. Takes
 * the per-repo base lock (it mutates the shared `.git` via `worktree remove` /
 * `prune`) so it can't race a concurrent `addWorktree` on the same repo — the
 * executor calls this from its `finally` while other queue's work may be
 * provisioning a worktree for the same repo.
 */
export async function removeWorktree(
  owner: string,
  repo: string,
  threadId: number
): Promise<void> {
  await withBaseLock(`${owner}/${repo}`, () => removeWorktreeUnlocked(owner, repo, threadId));
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

/**
 * Repo-relative paths the PR BRANCH changed relative to the base branch — i.e.
 * the PR's own diff, not the fix agent's.
 *
 * Needed because a worktree's build artifacts are seeded from the base clone,
 * which is parked on `master` (see seedBuildArtifacts): every workspace package
 * the PR itself modified has a STALE `lib/*.d.ts` in the worktree. The light gate
 * typechecks the app against those declarations, so a PR that (say) widens a
 * union type in `packages/foo/src` produces a flood of errors about its OWN new
 * symbols in files the fix never touched — the gate then can't pass cleanly and
 * the proposal parks as `gate_inconclusive`. Feeding these paths to the gate lets
 * it rebuild exactly those packages first.
 *
 * Three-dot (merge-base) diff so commits landed on master after the PR branched
 * don't show up as the PR's changes. Best-effort: returns [] when the base ref
 * can't be resolved, which just leaves the gate with the fix diff alone (today's
 * behavior).
 */
export async function branchChangedFiles(dir: string): Promise<string[]> {
  try {
    const out = await git(dir, [
      "diff",
      "--name-only",
      "-z",
      `origin/${BASE_BRANCH}...HEAD`,
    ]);
    return out.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Untracked paths that exist in a worktree but are NEVER part of a proposal: our
 * own scratch patch and the artifacts the read-only agents write into their
 * checkouts (explain → `explanation.md`, overview/risks/quiz → `overview/`).
 * Without this they'd be picked up as new files, land in the frozen diff, and get
 * pushed. Gitignored paths (`node_modules`, build output) need no entry here —
 * `git ls-files -o --exclude-standard` already omits them.
 */
const DIFF_EXCLUDE = (path: string): boolean =>
  path === ".babysit-proposal.patch" ||
  path === "explanation.md" ||
  path.startsWith("overview/");

/**
 * The worktree's full working-tree change against HEAD — including files the fix
 * agent CREATED.
 *
 * `git diff HEAD` alone only reports paths git already tracks, so a brand-new file
 * was silently missing from the Proposal: the owner reviewed and approved an
 * incomplete diff, and because the frozen patch is what gets re-applied at Approve
 * time, the new file never reached the branch either. Fix: register the untracked
 * paths with `git add -N` (`--intent-to-add`) — an index entry with no staged
 * content, which is exactly enough for `git diff HEAD` to emit them as `new file
 * mode` hunks.
 *
 * The untracked set is enumerated explicitly (`ls-files -o`) and filtered, rather
 * than using `add -AN` with `:(exclude)` pathspecs: `git add` FAILS (exit 1, "paths
 * are ignored by one of your .gitignore files") when a pathspec names a gitignored
 * path, so excluding `node_modules` that way breaks on every real repo. Listing
 * untracked files is ignore-aware for free.
 *
 * `--binary` so a created non-text file (an image, a fixture) produces an appliable
 * patch instead of the informational "Binary files differ" line, which `git apply`
 * rejects.
 *
 * Note this makes those files removable by a later `git reset --hard` — they're
 * index entries now, not untracked. That's what we want on every caller's failure
 * path: abandoning a patch should leave no stray files behind.
 */
export async function gitDiff(dir: string): Promise<string> {
  const untracked = (await git(dir, ["ls-files", "-o", "--exclude-standard", "-z"]))
    .split("\0")
    .filter((p) => p && !DIFF_EXCLUDE(p));
  // Intent-to-add is index-only: nothing on disk changes, and the throwaway
  // worktree's index is never used for anything but this diff and the final
  // `add -A` + commit. `--` guards paths that look like options.
  if (untracked.length) await git(dir, ["add", "-N", "--", ...untracked]);
  // VERBATIM (see gitRaw): trimming would drop a trailing blank context line and
  // corrupt the patch at apply time.
  return gitRaw(dir, ["diff", "HEAD", "--binary"]);
}

/**
 * Outcome of landing a frozen proposal diff on the worktree's current tree.
 *
 * - `exact`   — the frozen bytes applied verbatim (WYSIWYG; the common case).
 * - `rebased` — the frozen bytes no longer matched their context, but a 3-way
 *   merge re-seated the SAME edit onto the new tree with no conflict. `diff` is
 *   the rebased result, which is what would actually be pushed — so callers must
 *   re-gate and log it rather than trusting the frozen bytes.
 * - `conflict` — a real overlap: upstream changed the very lines the proposal
 *   edits. Only a re-propose can resolve it.
 * - `invalid` — nothing landed at all: a malformed frozen diff, or the pre-image
 *   blob is absent so no 3-way merge was possible.
 */
export type PatchApply =
  | { mode: "exact"; diff: string }
  | { mode: "rebased"; diff: string }
  | { mode: "conflict" }
  | { mode: "invalid" };

/**
 * Land a frozen proposal diff on the worktree's CURRENT tree, falling back to a
 * 3-way merge when plain context matching fails. Used at Approve time: the
 * proposal was built against an older base, so its context lines may have moved
 * even when its own target lines did not.
 *
 * Why this mutates instead of offering a `--check` variant: `git apply --3way
 * --check` reports success (exit 0) even for a patch that would conflict — it
 * prints "Applied patch ... with conflicts" and still returns 0. The only
 * trustworthy conflict signal is to apply for real and inspect the index for
 * unmerged entries. The worktree is throwaway, so we apply, and `git reset
 * --hard` restores it on any failure (tracked files only — the shared
 * node_modules and seeded build artifacts are untracked/ignored and survive).
 *
 * The 3-way merge needs the diff's pre-image blob (`index <old>..<new>` header)
 * in the object database. The base clone has it, since it fetched the branch when
 * the proposal was built; a shallow/fresh clone would not, and that surfaces as
 * `invalid`.
 */
export async function applyPatchRebasing(dir: string, diff: string): Promise<PatchApply> {
  const patch = join(dir, ".babysit-proposal.patch");
  writeFileSync(patch, diff.endsWith("\n") ? diff : diff + "\n");
  try {
    // 1. Plain apply: exact frozen bytes, no merge. Preferred — preserves WYSIWYG.
    try {
      await git(dir, ["apply", patch]);
      return { mode: "exact", diff: await gitDiff(dir) };
    } catch {
      await git(dir, ["reset", "--hard"]);
    }

    // 2. 3-way merge. Reasons about CHANGES (via the pre-image blob) instead of
    //    context strings, so a sibling edit elsewhere in the file — e.g. another
    //    Thread on the same PR whose approval moved HEAD — no longer invalidates
    //    this proposal. Exit code is unreliable here (see above); ignore it and
    //    judge by the index + resulting diff.
    await git(dir, ["apply", "--3way", patch]).catch(() => {});
    const unmerged = (await git(dir, ["ls-files", "-u"])).trim();
    const applied = await gitDiff(dir);
    if (unmerged || !applied.trim()) {
      await git(dir, ["reset", "--hard"]);
      return { mode: unmerged ? "conflict" : "invalid" };
    }
    return { mode: "rebased", diff: applied };
  } finally {
    rmSync(patch, { force: true });
  }
}

/**
 * Commit identity, derived from `githubLogin` — NOT read from ambient git config.
 * Native runs inherit the host's `user.name`/`user.email`, but a fresh container
 * has none and `git commit` would abort with "Please tell me who you are". We
 * pass the identity explicitly so auto-fix commits are attributed consistently on
 * every run path. The email uses GitHub's `<login>@users.noreply.github.com`
 * form, which GitHub links back to the account without exposing a real address.
 */
function commitIdentityArgs(): string[] {
  const { githubLogin } = loadConfig();
  if (!githubLogin) {
    throw new Error(
      "githubLogin is not configured — set it in config.json (or run `make setup`) " +
        "so auto-fix commits have a stable author identity."
    );
  }
  return [
    "-c",
    `user.name=${githubLogin}`,
    "-c",
    `user.email=${githubLogin}@users.noreply.github.com`,
  ];
}

export async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ["add", "-A"]);
  // --no-verify skips the repo's client-side git hooks (e.g. husky pre-commit).
  // Those hooks assume `husky install` ran (`.husky/_/husky.sh` exists), which it
  // never does in a throwaway worktree, so they'd abort the commit. Our pre-push
  // gate already self-verifies build/test/lint, so the hooks are redundant here.
  // Identity is passed explicitly (see commitIdentityArgs) so this works with no
  // ambient git config (e.g. in the container).
  await git(dir, [...commitIdentityArgs(), "commit", "--no-verify", "-m", message]);
}

/** Fast-forward-only push (no --force): git rejects a non-fast-forward push. */
export async function pushFastForward(dir: string, headRef: string): Promise<void> {
  // --no-verify for the same reason as commitAll: skip the repo's client-side
  // pre-push hook, which assumes `husky install` ran in this checkout.
  await git(dir, ["push", "--no-verify", "origin", `HEAD:${headRef}`]);
}
