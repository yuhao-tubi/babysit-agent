import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
  installInBase(base, ["react", "@adrise/hls.js"]);
  // Worktree bumped @adrise/hls.js to a different version — still the SAME
  // package dir, so presence holds.
  writePkg(wt, { react: "^18.0.0", "@adrise/hls.js": "npm:@adrise/hls.js@1.5.7-rc.56" });
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
