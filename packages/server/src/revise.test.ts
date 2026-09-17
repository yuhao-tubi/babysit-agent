import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviseInstruction, buildRevisePrompt, reviseWorktreeKey } from "./revise.js";
import { explainWorktreeKey } from "./explain.js";
import type { FeedbackItem, Proposal, ThreadRow } from "./types.js";

const codeProposal: Proposal = {
  kind: "code",
  planMarkdown: "Guard the empty list before indexing.",
  baseSha: "aaaaaaa",
  gatePassed: true,
  diff: "--- a/src/x.ts\n+++ b/src/x.ts\n@@\n-  return items[0];\n+  return items[0] ?? null;",
  replyDraft: "Good catch — guarded.",
};

// ---- buildReviseInstruction ----
// It has to survive `execute`'s instruction pre-parsing: anything matching
// /^ignore\b/ or /^reply:/ is intercepted before the re-propose branch, so a
// revision that started with either word would silently resolve or park text.

test("the revise instruction is not swallowed by the ignore/reply prefixes", () => {
  const ins = buildReviseInstruction(codeProposal, "ignore the test file");
  assert.doesNotMatch(ins, /^ignore\b/i);
  assert.doesNotMatch(ins, /^reply:/i);
  assert.match(ins, /^Revise/);
});

test("the current diff and the owner's note are both quoted", () => {
  const ins = buildReviseInstruction(codeProposal, "do the same at the other call site");
  assert.match(ins, /do the same at the other call site/);
  assert.match(ins, /items\[0\] \?\? null/);
  assert.match(ins, /Guard the empty list/);
  // The agent must know the checkout does NOT already contain the change.
  assert.match(ins, /does NOT contain that change/);
});

test("a manual plan is revised as a brief, and quotes no diff", () => {
  const ins = buildReviseInstruction(
    { ...codeProposal, kind: "manual_plan", diff: undefined },
    "split it into two steps"
  );
  assert.match(ins, /implementation brief/);
  assert.doesNotMatch(ins, /```diff/);
});

test("an over-long diff is truncated rather than sent whole", () => {
  const huge = "+".repeat(20000);
  const ins = buildReviseInstruction({ ...codeProposal, diff: huge }, "shorten it");
  assert.ok(ins.length < 12000, `instruction was ${ins.length} chars`);
  assert.match(ins, /\(truncated\)/);
});

// ---- buildRevisePrompt ----

const thread = {
  id: 7,
  prKey: "acme/app#12",
  threadKey: "review_comment:99",
  authorClass: "human",
} as unknown as ThreadRow;

const items: FeedbackItem[] = [
  {
    author: "reviewer",
    authorType: "human",
    kind: "review_comment",
    path: "src/x.ts",
    line: 4,
    body: "this indexes an empty list",
  } as unknown as FeedbackItem,
];

test("the reply prompt leads with the current draft and the note", () => {
  const p = buildRevisePrompt({
    s: thread,
    items,
    part: "reply",
    current: "Good catch — guarded.",
    note: "also say we'll add a test",
  });
  assert.match(p, /Your current reply draft/);
  assert.match(p, /Good catch — guarded\./);
  assert.match(p, /also say we'll add a test/);
  // Feedback stays as context, after the task.
  assert.ok(p.indexOf("NOTE") < p.indexOf("this indexes an empty list"));
  assert.match(p, /revision\.md/);
});

test("an empty current draft is labelled, not left blank", () => {
  const p = buildRevisePrompt({ s: thread, items, part: "change", current: "", note: "n" });
  assert.match(p, /\(empty\)/);
  assert.match(p, /PR description/);
});

// ---- worktree key namespaces ----
// `addWorktree` WIPES the path keyed by this number, so a collision deletes a
// live checkout out from under another agent. A Revision can run while both a
// pipeline job (positive id) and an Explanation are in flight on the same Thread.

test("revision worktree keys collide with nothing", () => {
  for (const id of [1, 7, 999, 100000]) {
    assert.ok(reviseWorktreeKey(id) < 0);
    assert.notEqual(reviseWorktreeKey(id), explainWorktreeKey(id));
    assert.notEqual(reviseWorktreeKey(id), -id);
  }
  // Distinct per thread, and never overlapping the explain range for any pair.
  assert.notEqual(reviseWorktreeKey(1), reviseWorktreeKey(2));
  assert.ok(reviseWorktreeKey(0) < explainWorktreeKey(1_000_000));
});
