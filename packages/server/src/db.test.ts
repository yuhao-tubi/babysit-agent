import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the db at an isolated temp file BEFORE db.ts lazily reads the config.
// (loadConfig caches on first call, which happens inside getDb.)
process.env.BABYSIT_DATA_DIR = mkdtempSync(join(tmpdir(), "babysit-db-test-"));

const { upsertPr, getPrOverview, updatePrOverview, failStuckRisks } = await import("./db.js");

function seedPr(prKey: string): void {
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
    role: "author",
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
