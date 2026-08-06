import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BABYSIT_DATA_DIR = mkdtempSync(join(tmpdir(), "babysit-explain-test-"));

const { isGrounded, buildExplainPrompt, explainWorktreeKey } = await import("./explain.js");

const BLOB = "https://github.com/owner/repo/blob/abc123";

test("isGrounded accepts a doc citing at least one permalink", () => {
  const md = `The flush is safe because the socket is drained first —
see [html5.ts:2726](${BLOB}/packages/player/src/adapters/html5.ts#L2726).`;
  assert.equal(isGrounded(md, BLOB), true);
});

test("isGrounded rejects a doc with no citation at all", () => {
  // Confident-sounding but ungrounded: exactly the failure mode the floor exists
  // to catch, since a plausible mermaid chart reads as authoritative either way.
  const md = `## Why this is safe

The player drains the socket before flushing, so no event can be lost.

\`\`\`mermaid
sequenceDiagram
  Player->>Socket: flush()
  Socket-->>Player: drained
\`\`\``;
  assert.equal(isGrounded(md, BLOB), false);
});

test("isGrounded rejects a permalink to a DIFFERENT repo/sha", () => {
  // A link to some other tree isn't grounding in THIS checkout.
  const md = `See https://github.com/owner/repo/blob/deadbeef/src/other.ts#L1`;
  assert.equal(isGrounded(md, BLOB), false);
});

test("isGrounded rejects empty/whitespace docs", () => {
  assert.equal(isGrounded("", BLOB), false);
  assert.equal(isGrounded("   \n\t ", BLOB), false);
});

test("isGrounded requires a line anchor, not a bare file link", () => {
  // "#L<n>" is what makes a citation checkable — a bare blob link doesn't say
  // which code backs the claim.
  assert.equal(isGrounded(`See ${BLOB}/src/a.ts`, BLOB), false);
  assert.equal(isGrounded(`See ${BLOB}/src/a.ts#L12`, BLOB), true);
});

test("buildExplainPrompt uses the Thread's feedback when no question is given", () => {
  const p = buildExplainPrompt(
    { prKey: "owner/repo#1", threadKey: "thread:5", authorClass: "human" } as any,
    [{ author: "bafolts", authorType: "User", kind: "review_comment", body: "When does X become true?", path: "src/a.ts", line: 4 } as any],
    BLOB,
    null
  );
  assert.match(p, /When does X become true\?/);
  assert.match(p, /bafolts/);
  assert.match(p, /src\/a\.ts:4/);
  assert.ok(p.includes(BLOB));
});

test("buildExplainPrompt puts the owner's follow-up question front and center", () => {
  const p = buildExplainPrompt(
    { prKey: "owner/repo#1", threadKey: "thread:5", authorClass: "human" } as any,
    [{ author: "bafolts", authorType: "User", kind: "review_comment", body: "When does X become true?" } as any],
    BLOB,
    "Explain the retry ledger instead"
  );
  assert.match(p, /Explain the retry ledger instead/);
  // The feedback is still supplied as context, but the owner's question governs.
  assert.match(p, /When does X become true\?/);
});

test("explainWorktreeKey never collides with Thread or PR-artifact keys", () => {
  // A worktree path is keyed ONLY by this number, and addWorktree wipes the path
  // before checkout — so a collision deletes a live checkout out from under a
  // concurrently running agent (overviewQueue and repoQueue run concurrently).
  const threadIds = [1, 2, 329, 334, 99999];
  const prNumbers = [1, 34739, 31091, 999999];

  for (const id of threadIds) {
    const k = explainWorktreeKey(id);
    // Not the Thread pipeline's own key (positive thread id).
    assert.notEqual(k, id);
    assert.ok(k < 0, "must be negative so it can never be a thread id");
    // Not a PR-level read-only artifact key (`-pr.number`).
    for (const n of prNumbers) assert.notEqual(k, -n);
  }

  // Distinct per thread, so two Explanations never share a checkout.
  const keys = threadIds.map(explainWorktreeKey);
  assert.equal(new Set(keys).size, keys.length);
});
