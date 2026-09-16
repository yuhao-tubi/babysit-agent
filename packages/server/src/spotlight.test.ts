import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { excludeFromSpotlight, spotlightExcludeRoots } from "./spotlight.js";

const tmp = () => mkdtempSync(join(tmpdir(), "babysit-spotlight-"));

test("writes the marker Spotlight looks for, and creates the root if absent", () => {
  const root = join(tmp(), "not", "created", "yet");
  assert.deepEqual(excludeFromSpotlight([root]), [root]);
  const marker = join(root, ".metadata_never_index");
  assert.ok(existsSync(marker));
  assert.equal(readFileSync(marker, "utf8"), "");
});

test("is idempotent — a second start marks nothing again", () => {
  const root = tmp();
  assert.deepEqual(excludeFromSpotlight([root]), [root]);
  assert.deepEqual(excludeFromSpotlight([root]), []);
});

test("dedupes roots so nested config paths are marked once", () => {
  const root = tmp();
  assert.deepEqual(excludeFromSpotlight([root, root, ""]), [root]);
});

test("never throws on an unwritable root — this is performance, not correctness", () => {
  assert.deepEqual(excludeFromSpotlight(["/dev/null/nope"]), []);
});

test("derives roots from config, using the db file's DIRECTORY", () => {
  const roots = spotlightExcludeRoots({
    dbPath: "/data/state.db",
    reposRoot: "/data/repos",
    worktreesRoot: "/data/cache/worktrees",
    ciLogsRoot: "/data/cache/ci-logs",
  });
  // The data dir comes first: marking it covers the whole subtree in one file.
  assert.equal(roots[0], "/data");
  assert.ok(roots.includes("/data/cache/worktrees"));
});
