import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the db at an isolated temp file BEFORE db.ts lazily reads the config.
// (loadConfig caches on first call, which happens inside getDb.)
process.env.BABYSIT_DATA_DIR = mkdtempSync(join(tmpdir(), "babysit-db-test-"));

const {
  upsertPr,
  getPrOverview,
  updatePrOverview,
  failStuckRisks,
  createThread,
  getThread,
  updateThread,
  failStuckExplanations,
  listAutoOverviewCandidates,
  failStuckOverviews,
} = await import("./db.js");

function seedPr(prKey: string, role: "author" | "reviewer" = "author"): void {
  const [ownerRepo, num] = prKey.split("#");
  const [owner, repo] = ownerRepo.split("/");
  upsertPr({
    prKey,
    owner,
    repo,
    number: Number(num),
    title: "t",
    url: "u",
    headRef: "feat",
    headSha: "livehead",
    role,
  });
}

test("risksHeadSha round-trips through updatePrOverview/getPrOverview", () => {
  const prKey = "o/r#1";
  seedPr(prKey);
  // Never analyzed → null.
  assert.equal(getPrOverview(prKey)!.risksHeadSha, null);

  updatePrOverview(prKey, { risksHeadSha: "analyzedhead" });
  assert.equal(getPrOverview(prKey)!.risksHeadSha, "analyzedhead");
});

test("risksStatus persists the on-demand 'generating' state", () => {
  const prKey = "o/r#2";
  seedPr(prKey);
  updatePrOverview(prKey, { risksStatus: "generating" });
  assert.equal(getPrOverview(prKey)!.risksStatus, "generating");
});

test("failStuckRisks resets a crashed 'generating' risk row to 'failed'", () => {
  const prKey = "o/r#3";
  seedPr(prKey);
  updatePrOverview(prKey, { risksStatus: "generating" });

  const reset = failStuckRisks();
  assert.ok(reset.includes(prKey));
  assert.equal(getPrOverview(prKey)!.risksStatus, "failed");
});

test("failStuckRisks leaves ready/failed risk rows untouched", () => {
  const readyKey = "o/r#4";
  seedPr(readyKey);
  updatePrOverview(readyKey, { risksStatus: "ready" });

  const reset = failStuckRisks();
  assert.ok(!reset.includes(readyKey));
  assert.equal(getPrOverview(readyKey)!.risksStatus, "ready");
});

// --- Thread Explanation artifact ---

function seedThread(prKey: string, threadKey: string): number {
  seedPr(prKey);
  const [ownerRepo, num] = prKey.split("#");
  const [owner, repo] = ownerRepo.split("/");
  return createThread({
    prKey,
    owner,
    repo,
    number: Number(num),
    reviewId: null,
    threadKey,
    authorClass: "human",
    itemGhIds: [],
  });
}

test("explanation fields round-trip through updateThread/getThread", () => {
  const id = seedThread("o/r#10", "thread:1");
  assert.equal(getThread(id)!.explanationStatus, null, "never generated → null");

  updateThread(id, {
    explanationMd: "The answer, citing code.",
    explanationStatus: "ready",
    explanationHeadSha: "builthead",
    explanationQuestion: "why is this safe?",
  });
  const t = getThread(id)!;
  assert.equal(t.explanationMd, "The answer, citing code.");
  assert.equal(t.explanationStatus, "ready");
  assert.equal(t.explanationHeadSha, "builthead");
  assert.equal(t.explanationQuestion, "why is this safe?");
});

test("a status change does NOT clear the explanation", () => {
  // Unlike a Proposal (frozen for one Approve) or the branch-advance marker, an
  // explanation is standalone reference the owner may still want after the Thread
  // resolves — so resolving must not wipe it.
  const id = seedThread("o/r#11", "thread:2");
  updateThread(id, { explanationMd: "keep me", explanationStatus: "ready" });
  updateThread(id, { status: "resolved" });
  assert.equal(getThread(id)!.explanationMd, "keep me");
  assert.equal(getThread(id)!.explanationStatus, "ready");
});

test("failStuckExplanations resets a crashed 'generating' row to 'failed'", () => {
  const id = seedThread("o/r#12", "thread:3");
  updateThread(id, { explanationStatus: "generating" });

  const reset = failStuckExplanations();
  assert.ok(reset.includes(id));
  assert.equal(getThread(id)!.explanationStatus, "failed");
});

test("failStuckExplanations leaves ready rows untouched", () => {
  const id = seedThread("o/r#13", "thread:4");
  updateThread(id, { explanationStatus: "ready", explanationMd: "done" });

  const reset = failStuckExplanations();
  assert.ok(!reset.includes(id));
  assert.equal(getThread(id)!.explanationStatus, "ready");
});

// ---- Auto-generated review briefs: which reviewer PRs the poll cycle picks ----

test("listAutoOverviewCandidates picks never-generated reviewer PRs, newest first, capped", () => {
  seedPr("auto/r#101", "reviewer");
  seedPr("auto/r#102", "reviewer");
  seedPr("auto/r#103", "reviewer");
  // #102 already has a brief → not a candidate.
  updatePrOverview("auto/r#102", { overviewStatus: "ready", overviewMd: "done" });

  assert.deepEqual(
    listAutoOverviewCandidates(2).map((p) => p.prKey),
    ["auto/r#103", "auto/r#101"]
  );
});

test("failStuckOverviews resets an interrupted brief with nothing to show to 'idle'", () => {
  // A restart killed the run before it produced any prose. `failed` would be a
  // lie AND would opt the PR out of auto-generation forever, so the truthful
  // state is `idle` — never generated, pick it up next cycle.
  seedPr("auto/r#110", "reviewer");
  updatePrOverview("auto/r#110", { overviewStatus: "generating" });

  const reset = failStuckOverviews();
  assert.ok(reset.includes("auto/r#110"));
  assert.equal(getPrOverview("auto/r#110")!.overviewStatus, "idle");
});

test("failStuckOverviews still fails an interrupted RE-generation, keeping its prose", () => {
  seedPr("auto/r#111", "reviewer");
  updatePrOverview("auto/r#111", { overviewMd: "the previous brief", overviewStatus: "ready" });
  updatePrOverview("auto/r#111", { overviewStatus: "generating" });

  failStuckOverviews();
  const pr = getPrOverview("auto/r#111")!;
  assert.equal(pr.overviewStatus, "failed", "had content → not a never-generated PR");
  assert.equal(pr.overviewMd, "the previous brief", "the old brief stays readable");
  const candidates = listAutoOverviewCandidates(50).map((p) => p.prKey);
  assert.ok(!candidates.includes("auto/r#111"), "a failed re-generation is never auto-retried");
  assert.ok(candidates.includes("auto/r#110"), "the reset-to-idle one IS picked up");
});
