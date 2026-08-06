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
