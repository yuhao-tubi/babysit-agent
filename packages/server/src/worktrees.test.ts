import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { allDepsPresentInBase } = await import("./worktrees.js");

/** Make a fake checkout dir with a package.json and (optionally) a base clone
 *  whose node_modules contains the named package dirs. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "babysit-wt-test-"));
}

function writePkg(
  dir: string,
  deps: Record<string, string>,
  dev: Record<string, string> = {},
  optional: Record<string, string> = {}
): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: deps, devDependencies: dev, optionalDependencies: optional })
  );
}

function installInBase(base: string, names: string[]): void {
  for (const name of names) mkdirSync(join(base, "node_modules", name), { recursive: true });
}

test("all declared deps present in base → safe to symlink", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, ["react", "@myorg/hls.js"]);
  // Worktree bumped @myorg/hls.js to a different version — still the SAME
  // package dir, so presence holds.
  writePkg(wt, { react: "^18.0.0", "@myorg/hls.js": "npm:@myorg/hls.js@1.5.7-rc.56" });
  assert.equal(allDepsPresentInBase(base, wt), true);
});

test("a newly-added dep absent from base → must copy", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, ["react"]);
  writePkg(wt, { react: "^18.0.0", "brand-new-lib": "^1.0.0" });
  assert.equal(allDepsPresentInBase(base, wt), false);
});

test("scoped package resolves under node_modules/@scope/name", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, ["@scope/pkg"]);
  writePkg(wt, { "@scope/pkg": "^2.0.0" });
  assert.equal(allDepsPresentInBase(base, wt), true);
});

test("devDependencies are checked too", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, ["react"]);
  writePkg(wt, { react: "^18.0.0" }, { "missing-dev-tool": "^1.0.0" });
  assert.equal(allDepsPresentInBase(base, wt), false);
});

test("absent optionalDependencies do NOT force a copy (cross-platform native variants)", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, ["react", "@statsig/statsig-node-core-darwin-arm64"]);
  // The PR declares native variants for every platform as optionalDependencies;
  // only the host's variant is installed in base. The others are legitimately
  // absent and must not trip the presence check into a full copy.
  writePkg(
    wt,
    { react: "^18.0.0" },
    {},
    {
      "@statsig/statsig-node-core-darwin-arm64": "^1.0.0",
      "@statsig/statsig-node-core-linux-x64-gnu": "^1.0.0",
      "@statsig/statsig-node-core-linux-arm64-musl": "^1.0.0",
    }
  );
  assert.equal(allDepsPresentInBase(base, wt), true);
});

test("no package.json in worktree → can't prove safe, returns false", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, ["react"]);
  // wt has no package.json written.
  assert.equal(allDepsPresentInBase(base, wt), false);
});

// ---- lightDepsPlan: a renamed workspace package must not force a copy ----

const { lightDepsPlan } = await import("./worktrees.js");

/** Write a workspace member at `<wt>/<rel>` declaring itself as `name`. */
function writeWorkspacePkg(wt: string, rel: string, name: string): void {
  mkdirSync(join(wt, rel), { recursive: true });
  writeFileSync(join(wt, rel, "package.json"), JSON.stringify({ name }));
}

function writeRootPkg(
  dir: string,
  deps: Record<string, string>,
  workspaces?: string[]
): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps, workspaces }));
}

test("everything present in base → plan is a single base symlink", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, ["react"]);
  writeRootPkg(wt, { react: "^18.0.0" });
  assert.equal(lightDepsPlan(base, wt).kind, "base");
});

test("a RENAMED local workspace package resolves via override, not a copy", () => {
  const base = scratch();
  const wt = scratch();
  // Base master installed the package under its old name only.
  installInBase(base, ["@myorg/hls.js"]);
  // The PR renamed the workspace package: same directory, new package name.
  writeRootPkg(wt, { "@myorg/hls": "*" }, ["packages/*"]);
  writeWorkspacePkg(wt, "packages/hls.js", "@myorg/hls");

  const plan = lightDepsPlan(base, wt);
  assert.equal(plan.kind, "base+workspace");
  if (plan.kind !== "base+workspace") return;
  assert.deepEqual([...plan.overrides.keys()], ["@myorg/hls"]);
  // The override must point at the directory already in the worktree.
  assert.equal(plan.overrides.get("@myorg/hls"), join(wt, "packages/hls.js"));
});

test("a genuinely NEW external dep still forces the copy+install path", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, ["react"]);
  writeRootPkg(wt, { react: "^18.0.0", "brand-new-lib": "^1.0.0" }, ["packages/*"]);
  writeWorkspacePkg(wt, "packages/local", "@myorg/local");
  // `brand-new-lib` is not a workspace member, so it has to be fetched.
  assert.equal(lightDepsPlan(base, wt).kind, "copy");
});

test("one workspace override plus one external addition → copy (no half measures)", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, ["react"]);
  writeRootPkg(wt, { react: "^18", "@myorg/hls": "*", "needs-download": "^1" }, ["packages/*"]);
  writeWorkspacePkg(wt, "packages/hls.js", "@myorg/hls");
  assert.equal(lightDepsPlan(base, wt).kind, "copy");
});

test("no package.json → copy, never a guess", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, ["react"]);
  assert.equal(lightDepsPlan(base, wt).kind, "copy");
});

test("a missing dep that is NOT a workspace member → copy even with workspaces declared", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, []);
  writeRootPkg(wt, { "some-lib": "^1.0.0" }, ["packages/*"]);
  // packages/ exists but holds an unrelated member.
  writeWorkspacePkg(wt, "packages/other", "@myorg/other");
  assert.equal(lightDepsPlan(base, wt).kind, "copy");
});

// ---- inherited deps: a stale PR must not look like it ADDED what master dropped ----

test("a missing dep the PR inherited (master dropped it since) → base symlink, no copy", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, ["react"]);
  // The PR branch predates master removing `preact-render-to-string`, so it still
  // declares it while base's install (built from current master) lacks it.
  writeRootPkg(wt, { react: "^18", "preact-render-to-string": "^6" });
  assert.equal(lightDepsPlan(base, wt, new Set(["react", "preact-render-to-string"])).kind, "base");
});

test("a missing dep the PR itself ADDED still forces the copy, even beside inherited ones", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, ["react"]);
  writeRootPkg(wt, { react: "^18", "dropped-by-master": "^1", "brand-new-lib": "^1" });
  assert.equal(lightDepsPlan(base, wt, new Set(["react", "dropped-by-master"])).kind, "copy");
});

test("an inherited-but-missing workspace member is still overridden, not skipped", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, ["react"]);
  writeRootPkg(wt, { react: "^18", "@myorg/hls": "*" }, ["packages/*"]);
  writeWorkspacePkg(wt, "packages/hls.js", "@myorg/hls");
  const plan = lightDepsPlan(base, wt, new Set(["react", "@myorg/hls"]));
  assert.equal(plan.kind, "base+workspace");
});

test("unknown merge-base (null) → strict: a missing dep forces the copy", () => {
  const base = scratch();
  const wt = scratch();
  installInBase(base, ["react"]);
  writeRootPkg(wt, { react: "^18", "preact-render-to-string": "^6" });
  assert.equal(lightDepsPlan(base, wt, null).kind, "copy");
});

const { declaredDepsAtMergeBase } = await import("./worktrees.js");

test("declaredDepsAtMergeBase reads the manifest the PR branched from, not master's tip", async () => {
  const dir = scratch();
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const commitPkg = (deps: Record<string, string>) => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps }));
    run(["add", "-A"]);
    run(["commit", "-qm", "pkg"]);
  };
  run(["init", "-q", "--initial-branch=master"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  commitPkg({ react: "1", preact: "1" });
  run(["checkout", "-q", "-b", "pr"]);
  commitPkg({ react: "1", preact: "1", "pr-added": "1" });
  run(["checkout", "-q", "master"]);
  commitPkg({ react: "1" }); // master dropped preact after the PR branched
  run(["checkout", "-q", "pr"]);

  const inherited = await declaredDepsAtMergeBase(dir, "master");
  assert.deepEqual([...(inherited ?? [])].sort(), ["preact", "react"]);
});

test("declaredDepsAtMergeBase → null when the base ref doesn't resolve", async () => {
  const r = repo("x;\n");
  assert.equal(await declaredDepsAtMergeBase(r.dir, "origin/nope"), null);
});

// ---- cloneTree: one-call COW clone of node_modules, with a safe fallback ----

const { cloneTree } = await import("./worktrees.js");
const { statSync, lstatSync, readlinkSync, symlinkSync, chmodSync, existsSync, readdirSync } =
  await import("node:fs");

/** A small node_modules lookalike: nested file, executable, relative symlink. */
function fakeNodeModules(): string {
  const src = join(scratch(), "node_modules");
  mkdirSync(join(src, "pkg", "lib"), { recursive: true });
  mkdirSync(join(src, ".bin"), { recursive: true });
  writeFileSync(join(src, "pkg", "lib", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(src, "pkg", "cli.js"), "#!/usr/bin/env node\n");
  chmodSync(join(src, "pkg", "cli.js"), 0o755);
  symlinkSync("../pkg/cli.js", join(src, ".bin", "pkg"));
  return src;
}

test("cloneTree reproduces files, modes and symlinks", async () => {
  const src = fakeNodeModules();
  const dst = join(scratch(), "node_modules");
  const how = await cloneTree(src, dst);
  // APFS → real clonefile; elsewhere (CI on Linux) the cp fallback must still be exact.
  if (process.platform === "darwin") assert.equal(how, "clonefile");
  assert.equal(readFileSync(join(dst, "pkg", "lib", "index.js"), "utf8"), "module.exports = 1;\n");
  assert.equal(statSync(join(dst, "pkg", "cli.js")).mode & 0o777, 0o755);
  assert.ok(lstatSync(join(dst, ".bin", "pkg")).isSymbolicLink());
  assert.equal(readlinkSync(join(dst, ".bin", "pkg")), "../pkg/cli.js");
});

test("cloneTree is private: writing the clone never changes the source", async () => {
  const src = fakeNodeModules();
  const dst = join(scratch(), "node_modules");
  await cloneTree(src, dst);
  writeFileSync(join(dst, "pkg", "lib", "index.js"), "changed\n");
  writeFileSync(join(dst, "pkg", "added.js"), "new\n");
  assert.equal(readFileSync(join(src, "pkg", "lib", "index.js"), "utf8"), "module.exports = 1;\n");
  assert.equal(existsSync(join(src, "pkg", "added.js")), false);
});

test("cloneTree falls back to cp when the clone helper is unavailable, without nesting", async () => {
  const src = fakeNodeModules();
  const dst = join(scratch(), "node_modules");
  assert.equal(await cloneTree(src, dst, "/nonexistent/python3"), "cp");
  assert.equal(readFileSync(join(dst, "pkg", "lib", "index.js"), "utf8"), "module.exports = 1;\n");
  // `cp -cR src dst` onto an existing dst would put a second node_modules inside.
  assert.equal(existsSync(join(dst, "node_modules")), false);
  assert.deepEqual(readdirSync(dst).sort(), [".bin", "pkg"]);
});

test("cloneTree removes a partial dst before the fallback so cp can't nest into it", async () => {
  const src = fakeNodeModules();
  const dst = join(scratch(), "node_modules");
  // A failed clone helper that already created dst (the partial-clone case).
  const helper = join(scratch(), "partial.sh");
  writeFileSync(helper, `#!/bin/sh\nmkdir -p "$4"\nexit 1\n`);
  chmodSync(helper, 0o755);
  assert.equal(await cloneTree(src, dst, helper), "cp");
  assert.equal(existsSync(join(dst, "node_modules")), false);
  assert.deepEqual(readdirSync(dst).sort(), [".bin", "pkg"]);
});

// ---- applyPatchRebasing: landing a frozen proposal on a moved tree ----

const { applyPatchRebasing } = await import("./worktrees.js");

/** A real git repo with one committed file, plus a helper to commit edits. */
function repo(initial: string): { dir: string; commit: (content: string) => void } {
  const dir = scratch();
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  run(["init", "-q", "--initial-branch=master"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  const file = join(dir, "f.ts");
  writeFileSync(file, initial);
  run(["add", "-A"]);
  run(["commit", "-qm", "init"]);
  return {
    dir,
    commit: (content: string) => {
      writeFileSync(file, content);
      run(["add", "-A"]);
      run(["commit", "-qm", "edit"]);
    },
  };
}

/** The frozen diff a proposal stores: `git diff HEAD` after an uncommitted edit. */
function freeze(dir: string, edited: string): string {
  writeFileSync(join(dir, "f.ts"), edited);
  const diff = execFileSync("git", ["diff", "HEAD"], { cwd: dir, encoding: "utf8" });
  execFileSync("git", ["reset", "--hard"], { cwd: dir });
  return diff;
}

const BASE = ["a;", "b;", "keep;", "/** doc */", "target;", "/** sibling doc */", "tail;", ""].join("\n");

test("unchanged tree → frozen bytes apply exactly (WYSIWYG preserved)", async () => {
  const r = repo(BASE);
  const frozen = freeze(r.dir, BASE.replace("/** doc */\n", ""));
  const landed = await applyPatchRebasing(r.dir, frozen);
  assert.equal(landed.mode, "exact");
  // Byte-exact: the pushed diff must be the frozen diff, not a re-rendered one.
  if (landed.mode === "exact") assert.equal(landed.diff, frozen);
});

test("sibling edit moved the CONTEXT → 3-way re-seats the same edit (thread 326)", async () => {
  const r = repo(BASE);
  // Proposal removes `/** doc */` above `target;`.
  const frozen = freeze(r.dir, BASE.replace("/** doc */\n", ""));
  // A sibling thread's approval lands first and deletes the doc-block BELOW —
  // inside this patch's trailing context, but not a line this patch edits.
  r.commit(BASE.replace("/** sibling doc */\n", ""));

  const landed = await applyPatchRebasing(r.dir, frozen);
  assert.equal(landed.mode, "rebased");
  // The intended edit landed, and ONLY that edit.
  const now = readFileSync(join(r.dir, "f.ts"), "utf8");
  assert.ok(!now.includes("/** doc */"), "target comment should be gone");
  assert.ok(now.includes("target;"), "target line itself must survive");
  assert.ok(!now.includes("<<<<<<<"), "no conflict markers");
});

test("upstream edited the SAME line → conflict, tree restored (thread 318)", async () => {
  const r = repo(BASE);
  const frozen = freeze(r.dir, BASE.replace("target;", "target(1);"));
  // Upstream changes the very line the proposal edits, differently.
  r.commit(BASE.replace("target;", "target(2);"));

  const landed = await applyPatchRebasing(r.dir, frozen);
  assert.equal(landed.mode, "conflict");
  // Worktree must be left clean — no half-merged state, no markers.
  const now = readFileSync(join(r.dir, "f.ts"), "utf8");
  assert.ok(!now.includes("<<<<<<<"), "conflict must not leak markers into the tree");
  assert.ok(now.includes("target(2);"), "upstream content must be restored");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: r.dir, encoding: "utf8" }).trim(), "");
});

test("malformed frozen diff → invalid, not a false conflict", async () => {
  const r = repo(BASE);
  const landed = await applyPatchRebasing(r.dir, "diff --git a/f.ts b/f.ts\n@@ -1,2 +1,1 @@\n-nope;\n");
  assert.equal(landed.mode, "invalid");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: r.dir, encoding: "utf8" }).trim(), "");
});

test("pre-image blob absent (no 3-way possible) → invalid, never a silent no-op", async () => {
  const r = repo(BASE);
  // A diff whose `index` pre-image blob was never in THIS repo, and whose context
  // does not match either — plain apply fails and 3-way has nothing to merge from.
  const frozen = [
    "diff --git a/f.ts b/f.ts",
    "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,3 +1,2 @@",
    " totally;",
    "-different;",
    " content;",
    "",
  ].join("\n");
  const landed = await applyPatchRebasing(r.dir, frozen);
  assert.equal(landed.mode, "invalid");
});

// ---- gitDiff: a CREATED file must reach the Proposal (thread 343) ----
//
// `git diff HEAD` only reports tracked paths, so a file the fix agent created was
// missing from the frozen diff entirely: the owner reviewed an incomplete change,
// and since the frozen patch is what Approve re-applies, the new file never
// reached the branch either.

const { gitDiff } = await import("./worktrees.js");

const write = (dir: string, rel: string, body: string | Buffer) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body as any);
};

test("a created file appears in the diff as a new-file hunk", async () => {
  const r = repo(BASE);
  write(r.dir, "added.ts", "export const n = 1;\n");
  writeFileSync(join(r.dir, "f.ts"), BASE.replace("target;", "target(1);"));

  const diff = await gitDiff(r.dir);
  assert.match(diff, /^diff --git a\/added\.ts b\/added\.ts$/m);
  assert.match(diff, /^new file mode/m);
  assert.match(diff, /^\+export const n = 1;$/m, "the new file's content must be in the patch");
  assert.match(diff, /target\(1\);/, "the tracked-file edit must still be there");
});

test("a created file in a NEW nested directory is included", async () => {
  const r = repo(BASE);
  write(r.dir, "src/deep/nested.ts", "export const d = 1;\n");
  assert.match(await gitDiff(r.dir), /^diff --git a\/src\/deep\/nested\.ts/m);
});

test("a created file survives the freeze → Approve round trip", async () => {
  const r = repo(BASE);
  write(r.dir, "added.ts", "export const n = 1;\n");
  const frozen = await gitDiff(r.dir);
  execFileSync("git", ["reset", "--hard"], { cwd: r.dir });
  // reset --hard removes it: intent-to-add made it an index entry, not untracked.
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: r.dir, encoding: "utf8" }).trim(), "");

  const landed = await applyPatchRebasing(r.dir, frozen);
  assert.equal(landed.mode, "exact");
  assert.equal(readFileSync(join(r.dir, "added.ts"), "utf8"), "export const n = 1;\n");
});

test("a created BINARY file is encoded so the patch still applies", async () => {
  const r = repo(BASE);
  // "Binary files differ" (the default, informational form) makes `git apply` fail
  // with "cannot apply binary patch ... without full index line" — hence --binary.
  write(r.dir, "fixture.bin", Buffer.from([0, 1, 2, 255, 0, 7]));
  const frozen = await gitDiff(r.dir);
  assert.match(frozen, /GIT binary patch/);
  execFileSync("git", ["reset", "--hard"], { cwd: r.dir });

  const landed = await applyPatchRebasing(r.dir, frozen);
  assert.equal(landed.mode, "exact");
  assert.deepEqual([...readFileSync(join(r.dir, "fixture.bin"))], [0, 1, 2, 255, 0, 7]);
});

test("gitignored output is never pulled into the diff", async () => {
  const r = repo(BASE);
  write(r.dir, ".gitignore", "node_modules/\n*.tsbuildinfo\n");
  r.commit(BASE); // commit the .gitignore via the helper's add -A
  write(r.dir, "node_modules/pkg/index.js", "module.exports = 1;\n");
  write(r.dir, "app.tsbuildinfo", "{}\n");
  write(r.dir, "real.ts", "export const r = 1;\n");

  const diff = await gitDiff(r.dir);
  assert.match(diff, /real\.ts/);
  assert.doesNotMatch(diff, /node_modules/);
  assert.doesNotMatch(diff, /tsbuildinfo/);
});

test("agent scratch artifacts are excluded even when not gitignored", async () => {
  const r = repo(BASE);
  // Written by applyPatchRebasing / explain / overview+risks+quiz respectively.
  write(r.dir, ".babysit-proposal.patch", "stale patch\n");
  write(r.dir, "explanation.md", "# explanation\n");
  write(r.dir, "overview/risks.json", "{}\n");
  write(r.dir, "real.ts", "export const r = 1;\n");

  const diff = await gitDiff(r.dir);
  assert.match(diff, /real\.ts/);
  for (const scratch of [".babysit-proposal.patch", "explanation.md", "overview/risks.json"]) {
    assert.doesNotMatch(diff, new RegExp(scratch.replace(/[.*]/g, "\\$&")));
  }
});

test("a clean worktree still yields an empty diff (the fix_noop signal)", async () => {
  assert.equal((await gitDiff(repo(BASE).dir)).trim(), "");
});
