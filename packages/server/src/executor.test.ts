import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BABYSIT_DATA_DIR = mkdtempSync(join(tmpdir(), "babysit-executor-test-"));

const { carryReplyProgress, buildStaleRebuildInstruction, parkAlreadyNotified, execute } =
  await import("./executor.js");
const { createThread, getThread, getEvents, upsertPr } = await import("./db.js");

import type { Proposal } from "./types.js";

const code = (over: Partial<Proposal> = {}): Proposal => ({
  kind: "code",
  planMarkdown: "Rebuilt fix.",
  baseSha: "b".repeat(40),
  gatePassed: true,
  diff: "diff --git a/f.ts b/f.ts\n",
  replyDraft: "Fixed in the latest commit.",
  ...over,
});

// ---- carryReplyProgress: a reply already settled is never re-offered ----
// A Proposal has two independently-approvable parts. Re-proposing builds a FRESH
// Proposal, so without this carry-over the owner is offered "Post reply" a second
// time for a reply already on GitHub (a duplicate comment) — or is re-offered one
// they explicitly dismissed.

test("no prior proposal → the rebuilt proposal is untouched", () => {
  const next = code();
  assert.deepEqual(carryReplyProgress(null, next), next);
});

test("a posted reply carries over, so it is not offered twice", () => {
  const prior = code({ replyPosted: true, replyDraft: "Already said this on GitHub." });
  const out = carryReplyProgress(prior, code());
  assert.equal(out.replyPosted, true);
  // The text shown is what was ACTUALLY posted, not the new draft nobody sent.
  assert.equal(out.replyDraft, "Already said this on GitHub.");
});

test("a dismissed reply stays dismissed", () => {
  const out = carryReplyProgress(code({ replyDismissed: true }), code());
  assert.equal(out.replyDismissed, true);
  // The draft is not swapped in for a dismissal: nothing was posted, so the new
  // proposal's own text is the honest thing to keep.
  assert.equal(out.replyDraft, "Fixed in the latest commit.");
});

test("an unsettled reply carries nothing — the fresh draft stands", () => {
  const out = carryReplyProgress(code({ replyDraft: "old draft" }), code());
  assert.equal(out.replyPosted, undefined);
  assert.equal(out.replyDismissed, undefined);
  assert.equal(out.replyDraft, "Fixed in the latest commit.");
});

test("changeApplied is NEVER carried — the rebuilt change is unpushed", () => {
  const out = carryReplyProgress(code({ changeApplied: true, replyPosted: true }), code());
  assert.equal(out.changeApplied, undefined);
  assert.equal(out.replyPosted, true);
});

test("reply progress carries across proposal kinds", () => {
  const prior: Proposal = {
    kind: "reply",
    planMarkdown: "Proposed reply.",
    baseSha: "",
    gatePassed: true,
    replyDraft: "posted answer",
    replyPosted: true,
  };
  assert.equal(carryReplyProgress(prior, code()).replyPosted, true);
});

// ---- buildStaleRebuildInstruction ----

const BASE = "1234567890abcdef1234567890abcdef12345678";
const HEAD = "fedcba0987654321fedcba0987654321fedcba09";

test("the instruction names both shas in short form", () => {
  const t = buildStaleRebuildInstruction({ baseSha: BASE, remoteSha: HEAD, diff: "a diff" });
  assert.match(t, /1234567/);
  assert.match(t, /fedcba0/);
  assert.ok(!t.includes(BASE), "full shas are noise in a prompt");
});

test("the stale diff is included so the agent re-applies the same intent", () => {
  const t = buildStaleRebuildInstruction({
    baseSha: BASE,
    remoteSha: HEAD,
    diff: "diff --git a/f.ts b/f.ts\n-old\n+new\n",
  });
  assert.match(t, /-old/);
  assert.match(t, /\+new/);
});

test("the agent is told to make NO change if upstream already handled it", () => {
  const t = buildStaleRebuildInstruction({ baseSha: BASE, remoteSha: HEAD, diff: "d" });
  assert.match(t, /no change/i);
  assert.match(t, /already/i);
});

test("a huge stale diff is truncated, and says so", () => {
  const t = buildStaleRebuildInstruction({
    baseSha: BASE,
    remoteSha: HEAD,
    diff: "x".repeat(20_000),
  });
  assert.ok(t.length < 6000, `instruction should stay prompt-sized, got ${t.length}`);
  assert.match(t, /truncated/i);
});

// ---- parkAlreadyNotified: one banner per stale->rebuild round trip ----
// Parking a rebuilt proposal raises its own banner when the gate was inconclusive or
// the change is high-risk. Without this check the rebuild path stacks a second
// "approve again" banner on top of a warning that already says to go look.

const row = (proposal: unknown, risk?: string) =>
  ({
    id: 7,
    proposalJson: proposal ? JSON.stringify(proposal) : null,
    verdictJson: risk ? JSON.stringify({ action: "propose", risk }) : null,
  }) as any;

test("a clean parked proposal raised no banner of its own", () => {
  assert.equal(parkAlreadyNotified(row(code(), "medium")), false);
});

test("an inconclusive gate already banners", () => {
  assert.equal(parkAlreadyNotified(row(code({ gateInconclusive: true }))), true);
});

test("a high-risk verdict already banners", () => {
  assert.equal(parkAlreadyNotified(row(code(), "high")), true);
});

test("no proposal parked → nothing was announced", () => {
  assert.equal(parkAlreadyNotified(row(null, "high")), false);
});

// ---- dismiss: resolves locally, writes NOTHING ----
// The whole point of `dismiss` is that a thread asking for nothing (a bot review-
// summary header, boilerplate, LGTM) costs the owner zero clicks. If it parked a
// Proposal or posted anything, it would be no better than the `reply` it replaced.
// Any GitHub call in this path would throw here (no `gh`, no network in tests).

test("a dismiss verdict resolves the thread with no proposal and no reply", async () => {
  upsertPr({
    prKey: "o/r#9",
    owner: "o",
    repo: "r",
    number: 9,
    title: "t",
    url: "u",
    headRef: "feat",
    headSha: "h",
    role: "author",
  });
  const id = createThread({
    prKey: "o/r#9",
    owner: "o",
    repo: "r",
    number: 9,
    reviewId: 123,
    threadKey: "review:123",
    authorClass: "bot",
    itemGhIds: [],
  });
  const s = getThread(id)!;
  const status = await execute(s, {
    action: "dismiss",
    summary: "Codex review summary header with no findings.",
    reply_draft: "",
    risk: "low",
  });
  assert.equal(status, "resolved");
  const after = getThread(id)!;
  assert.equal(after.proposalJson, null);
  assert.equal(after.diff, null);
  const kinds = getEvents(id).map((e) => e.kind);
  assert.ok(kinds.includes("dismissed"), `expected a dismissed event, got ${kinds.join(",")}`);
  // Nothing that writes to GitHub may be logged.
  for (const k of ["replied", "pushed", "proposed", "escalated", "dry_run"]) {
    assert.ok(!kinds.includes(k), `dismiss must not ${k}`);
  }
});

test("an owner instruction overrides a dismiss verdict (it never silences the owner)", async () => {
  const s = { id: 7, prKey: "o/r#9", owner: "o", repo: "r", number: 9, authorClass: "bot" } as any;
  const status = await execute(
    s,
    { action: "dismiss", summary: "nothing here", reply_draft: "", risk: "low" },
    { instruction: "reply: actually, please look again at the null check" }
  );
  // `reply:` parks a reply Proposal for review — it does NOT stay dismissed.
  assert.equal(status, "awaiting_approval");
});
