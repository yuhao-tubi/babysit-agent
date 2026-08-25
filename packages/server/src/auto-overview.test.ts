import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated db BEFORE db.ts lazily reads the config (prior art: db.test.ts).
process.env.BABYSIT_DATA_DIR = mkdtempSync(join(tmpdir(), "babysit-auto-test-"));

const { upsertPr, updatePrOverview, pruneClosedPrs } = await import("./db.js");
const { autoOverviewPrKeys } = await import("./overview.js");

const OVERVIEW = { enabled: true, autoGenerate: true, autoMaxPerCycle: 2, maxTurns: 1, reviewerModelName: "m" };

function seedReviewerPr(number: number): string {
  const prKey = `auto/r#${number}`;
  upsertPr({
    prKey,
    owner: "auto",
    repo: "r",
    number,
    title: "t",
    url: "u",
    headRef: "feat",
    headSha: "livehead",
    role: "reviewer",
  });
  return prKey;
}

test("picks the newest reviewer PRs that need a brief, capped by autoMaxPerCycle", () => {
  seedReviewerPr(1);
  seedReviewerPr(2);
  seedReviewerPr(3);

  assert.deepEqual(autoOverviewPrKeys(OVERVIEW), ["auto/r#3", "auto/r#2"]);
});

test("generates nothing when auto-generation is switched off", () => {
  seedReviewerPr(4);
  assert.deepEqual(autoOverviewPrKeys({ ...OVERVIEW, autoGenerate: false }), []);
  // The feature's master switch also covers it — no briefs at all means no auto ones.
  assert.deepEqual(autoOverviewPrKeys({ ...OVERVIEW, enabled: false }), []);
  // A zero ceiling is the same as off.
  assert.deepEqual(autoOverviewPrKeys({ ...OVERVIEW, autoMaxPerCycle: 0 }), []);
});

test("an already-generated or in-flight brief is never re-picked", () => {
  const key = seedReviewerPr(5);
  updatePrOverview(key, { overviewStatus: "generating" });
  assert.ok(!autoOverviewPrKeys(OVERVIEW).includes(key), "in flight");

  updatePrOverview(key, { overviewStatus: "ready", overviewMd: "brief" });
  assert.ok(!autoOverviewPrKeys(OVERVIEW).includes(key), "already has one");

  // Stale (a push moved the head past the brief) is NOT an auto trigger either —
  // the panel shows the stale hint and the owner clicks Regenerate.
  updatePrOverview(key, { overviewHeadSha: "oldhead" });
  assert.ok(!autoOverviewPrKeys(OVERVIEW).includes(key), "stale but present");
});

test("a merged/closed reviewer PR is never picked", () => {
  const key = seedReviewerPr(6);
  assert.ok(autoOverviewPrKeys(OVERVIEW).includes(key), "open → picked");

  // The next poll no longer sees it in the live open set → expired.
  pruneClosedPrs(["auto/r#1"]);
  assert.ok(!autoOverviewPrKeys(OVERVIEW).includes(key), "expired → no brief");
});
