import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BABYSIT_DATA_DIR = mkdtempSync(join(tmpdir(), "babysit-takeover-test-"));

const { buildTakeover } = await import("./takeover.js");

const PR = {
  prKey: "owner/repo#12",
  owner: "owner",
  repo: "repo",
  number: 12,
  title: "Add a retry ledger",
  url: "https://github.com/owner/repo/pull/12",
  headRef: "feature/retry-ledger",
  headSha: "aaaaaaaaaaaa",
} as any;

const THREAD = {
  id: 7,
  prKey: "owner/repo#12",
  owner: "owner",
  repo: "repo",
  number: 12,
  threadKey: "thread:5",
  authorClass: "human",
  status: "awaiting_approval",
} as any;

const ITEM = {
  ghId: 1,
  kind: "review_comment",
  author: "bafolts",
  authorType: "User",
  body: "This retries forever if the socket never drains.",
  path: "src/a.ts",
  line: 42,
  createdAt: "2026-08-01T00:00:00Z",
  threadKey: "thread:5",
} as any;

test("the header states the checkout facts a paste needs to be safe", () => {
  // Pasting a Takeover into the wrong checkout is the main way this bites you:
  // the branch name and head sha are what make that a checkable precondition.
  const md = buildTakeover(THREAD, [ITEM], PR, null, null);
  assert.match(md, /owner\/repo/);
  assert.match(md, /#12/);
  assert.match(md, /https:\/\/github\.com\/owner\/repo\/pull\/12/);
  assert.match(md, /feature\/retry-ledger/);
  assert.match(md, /aaaaaaaaaaaa/);
});

test("the feedback conversation is included verbatim with author and location", () => {
  const md = buildTakeover(THREAD, [ITEM], PR, null, null);
  assert.match(md, /This retries forever if the socket never drains\./);
  assert.match(md, /bafolts/);
  assert.match(md, /src\/a\.ts:42/);
});

test("a code Proposal's diff is included, labelled with its gate result and base", () => {
  // Option 1 of the design: the most expensive artifact on the Thread is handed
  // over, but only as facts — what it is, that it is unpushed, what it was built
  // against. The baseSha is how the receiving agent can notice it has moved on.
  const md = buildTakeover(THREAD, [ITEM], PR, null, {
    kind: "code",
    planMarkdown: "Bound the retry loop.",
    baseSha: "bbbbbbbbbbbb",
    gatePassed: true,
    diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  } as any);
  assert.match(md, /Bound the retry loop\./);
  assert.match(md, /\+new/);
  assert.match(md, /bbbbbbbbbbbb/);
  assert.match(md, /not been pushed/i);
  assert.match(md, /passed/i);
});

test("a code Proposal whose gate did NOT pass is not described as verified", () => {
  const md = buildTakeover(THREAD, [ITEM], PR, null, {
    kind: "code",
    planMarkdown: "Bound the retry loop.",
    baseSha: "bbbbbbbbbbbb",
    gatePassed: false,
    gateInconclusive: true,
    diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  } as any);
  assert.doesNotMatch(md, /gate passed/i);
  assert.match(md, /inconclusive/i);
});

test("a pr_body Proposal is labelled as a description rewrite needing no code edit", () => {
  // The odd kind out: pasting a description rewrite into a coding agent would
  // otherwise invite it to edit files, when the pending action is `gh pr edit`.
  const md = buildTakeover(THREAD, [ITEM], PR, null, {
    kind: "pr_body",
    planMarkdown: "The description omits the retry cap.",
    baseSha: "",
    gatePassed: false,
    proposedBody: "## What\nAdds a retry ledger with a cap.",
  } as any);
  assert.match(md, /description/i);
  assert.match(md, /no code change/i);
  assert.match(md, /Adds a retry ledger with a cap\./);
  // A description rewrite has no diff to apply — it must not be presented as one.
  assert.doesNotMatch(md, /unified diff/i);
});

test("a manual_plan Proposal is included as prose, with no diff and no gate claim", () => {
  const md = buildTakeover(THREAD, [ITEM], PR, null, {
    kind: "manual_plan",
    planMarkdown: "Step 1: bound the loop in src/a.ts.",
    baseSha: "",
    gatePassed: false,
  } as any);
  assert.match(md, /Step 1: bound the loop in src\/a\.ts\./);
  assert.doesNotMatch(md, /gate/i);
});

test("a drafted reply is included, marked as unposted", () => {
  const md = buildTakeover(THREAD, [ITEM], PR, null, {
    kind: "reply",
    planMarkdown: "",
    baseSha: "",
    gatePassed: false,
    replyDraft: "Good catch — capped at 5 now.",
  } as any);
  assert.match(md, /Good catch — capped at 5 now\./);
  assert.match(md, /not been posted/i);
});

test("an already-applied change part is reported as applied, not as pending", () => {
  // Approving the reply first resolves the Thread while the change stays
  // approvable, and vice versa — so `changeApplied` must be reflected honestly
  // or the prompt will ask for work that already landed on the branch.
  const md = buildTakeover(THREAD, [ITEM], PR, null, {
    kind: "code",
    planMarkdown: "Bound the retry loop.",
    baseSha: "bbbbbbbbbbbb",
    gatePassed: true,
    diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    changeApplied: true,
  } as any);
  assert.match(md, /already been pushed/i);
  assert.doesNotMatch(md, /has not been pushed/i);
});

test("the Verdict and its rationale are included, with escalation options", () => {
  const md = buildTakeover(
    THREAD,
    [ITEM],
    PR,
    {
      action: "escalate",
      summary: "Two ways to bound the loop; needs a call.",
      reply_draft: "",
      risk: "medium",
      options: ["Cap at 5 retries", "Add a deadline instead"],
    } as any,
    null
  );
  assert.match(md, /escalate/);
  assert.match(md, /Two ways to bound the loop; needs a call\./);
  assert.match(md, /Cap at 5 retries/);
  assert.match(md, /Add a deadline instead/);
});

test("the Explanation is included and marked as never posted to GitHub", () => {
  const md = buildTakeover(
    { ...THREAD, explanationMd: "The socket drains first, so…", explanationStatus: "ready", explanationHeadSha: "cccccccccccc" },
    [ITEM],
    PR,
    null,
    null
  );
  assert.match(md, /The socket drains first, so…/);
  assert.match(md, /never posted/i);
  assert.match(md, /cccccccccccc/);
});

test("an unfinished or failed Explanation is omitted rather than shown empty", () => {
  const generating = buildTakeover(
    { ...THREAD, explanationMd: null, explanationStatus: "generating" },
    [ITEM],
    PR,
    null,
    null
  );
  assert.doesNotMatch(generating, /## Explanation/);
  const failed = buildTakeover(
    { ...THREAD, explanationMd: "half a doc", explanationStatus: "failed" },
    [ITEM],
    PR,
    null,
    null
  );
  assert.doesNotMatch(failed, /half a doc/);
});

test("renders on a bare Thread with no verdict, no proposal and no feedback", () => {
  // Available on EVERY Thread in ANY status (it is a projection, not an
  // artifact), so the degenerate case must produce a usable prompt, not throw.
  const md = buildTakeover({ ...THREAD, status: "pending" }, [], PR, null, null);
  assert.match(md, /owner\/repo/);
  assert.ok(md.trim().length > 0);
  assert.doesNotMatch(md, /## Review feedback/);
});

test("renders when the PR row is missing entirely", () => {
  // The Thread carries owner/repo/number itself; the PR row only adds branch,
  // title and url. A missing row must degrade, not blow up.
  const md = buildTakeover(THREAD, [ITEM], undefined, null, null);
  assert.match(md, /owner\/repo/);
  assert.match(md, /#12/);
});

test("the imperative is thin: it states provenance, not what to do with the diff", () => {
  // The whole point of the neutral label — you copied the Thread out precisely
  // because the judgment is now yours, so the prompt must not steer.
  const md = buildTakeover(THREAD, [ITEM], PR, null, {
    kind: "code",
    planMarkdown: "Bound the retry loop.",
    baseSha: "bbbbbbbbbbbb",
    gatePassed: true,
    diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  } as any);
  assert.doesNotMatch(md, /starting point/i);
  assert.doesNotMatch(md, /you should/i);
  assert.doesNotMatch(md, /recommend/i);
});

test("under dryRun, an 'applied' part is not claimed to have reached GitHub", () => {
  // The executor sets changeApplied/replyPosted in its dryRun branches WITHOUT
  // touching GitHub, and dryRun ships as the default. Reporting those flags as
  // "already pushed" would tell the receiving agent the work landed when the
  // branch is untouched — the exact class of false provenance this document
  // exists to avoid.
  const md = buildTakeover(
    THREAD,
    [ITEM],
    PR,
    null,
    {
      kind: "code",
      planMarkdown: "Bound the retry loop.",
      baseSha: "bbbbbbbbbbbb",
      gatePassed: true,
      diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      changeApplied: true,
      replyDraft: "Capped.",
      replyPosted: true,
    } as any,
    { dryRun: true }
  );
  assert.match(md, /dry-run/i);
  assert.doesNotMatch(md, /already been pushed/i);
  assert.doesNotMatch(md, /already been posted/i);
});

test("a change that really was pushed is shown, not silently omitted", () => {
  // Auto-push and a fully-settled Approve clear the Proposal and leave the diff on
  // the Thread. Projecting only the Proposal would render NO change section while
  // the header says nothing was pushed unless stated — so the pushed diff has to
  // come from `diff` when there is no Proposal to carry it.
  const md = buildTakeover(
    { ...THREAD, status: "resolved", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+landed\n" },
    [ITEM],
    PR,
    null,
    null
  );
  assert.match(md, /\+landed/);
  assert.match(md, /already on the branch|already been pushed/i);
});

test("the applied diff is not repeated when a Proposal already carries one", () => {
  const md = buildTakeover(
    { ...THREAD, diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" },
    [ITEM],
    PR,
    null,
    {
      kind: "code",
      planMarkdown: "Bound the retry loop.",
      baseSha: "bbbbbbbbbbbb",
      gatePassed: true,
      diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    } as any
  );
  assert.equal((md.match(/```diff/g) ?? []).length, 1);
  assert.doesNotMatch(md, /already pushed/i);
});

test("escalation options are only framed as an open decision for an escalate verdict", () => {
  // `options` is documented as escalate-only, but a stray one on a `propose`
  // verdict would otherwise print "it could not settle this itself" directly
  // under a decision that says it did.
  const md = buildTakeover(THREAD, [ITEM], PR, {
    action: "propose",
    summary: "Cap the loop.",
    reply_draft: "",
    risk: "low",
    options: ["Cap at 5 retries"],
  } as any, null);
  assert.doesNotMatch(md, /could not settle/i);
});

test("blank lines inside a quoted body and diff survive verbatim", () => {
  // The feedback and the diff are quoted, not summarised: a diff whose hunk body
  // has consecutive empty lines no longer applies if they are collapsed, while the
  // document still claims it was built against a base sha.
  const body = "para one\n\n\nafter three newlines";
  const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,4 +1,4 @@\n-old\n+new\n \n \n";
  const md = buildTakeover(THREAD, [{ ...ITEM, body } as any], PR, null, {
    kind: "code",
    planMarkdown: "",
    baseSha: "bbbbbbbbbbbb",
    gatePassed: true,
    diff,
  } as any);
  assert.ok(md.includes(body), "feedback body was rewritten");
  assert.ok(md.includes("-old\n+new\n \n \n"), "diff body was rewritten");
});

test("an indented fence in a feedback body cannot break out either", () => {
  // CommonMark lets a closing fence be indented up to three spaces, and a snippet
  // nested in a list is exactly how that arrives in a review comment.
  const md = buildTakeover(
    THREAD,
    [{ ...ITEM, body: "1. do this:\n\n   ```ts\n   const x = 1;\n   ```\n\n2. then that" } as any],
    PR,
    null,
    null
  );
  const fences = md.match(/^ {0,3}`{3,}/gm) ?? [];
  assert.equal(fences.length % 2, 0, "unbalanced code fences");
  assert.match(md, /then that/);
});

test("a CI-failure feedback item names the failing check", () => {
  const md = buildTakeover(
    THREAD,
    [{ ...ITEM, kind: "ci_failure", author: "github-actions", checkName: "lint", path: null, line: null, body: "eslint: no-unused-vars" } as any],
    PR,
    null,
    null
  );
  assert.match(md, /lint/);
  assert.match(md, /no-unused-vars/);
});

test("fenced code in a feedback body cannot break out of its own fence", () => {
  // Reviewers paste fenced snippets constantly; a naive ``` wrapper would let the
  // body terminate the fence early and scramble the rest of the document.
  const md = buildTakeover(
    THREAD,
    [{ ...ITEM, body: "```ts\nconst x = 1;\n```\nfix this" } as any],
    PR,
    null,
    null
  );
  assert.match(md, /const x = 1;/);
  assert.match(md, /fix this/);
  // Every fence opened in the document must also close.
  const fences = md.match(/^`{3,}/gm) ?? [];
  assert.equal(fences.length % 2, 0, "unbalanced code fences");
});
