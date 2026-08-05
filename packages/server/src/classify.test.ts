import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated data dir + config BEFORE classify.ts lazily reads the config.
const dir = mkdtempSync(join(tmpdir(), "babysit-classify-test-"));
process.env.BABYSIT_DATA_DIR = dir;
writeFileSync(join(dir, "config.json"), JSON.stringify({ githubLogin: "owner-login" }));
process.env.BABYSIT_CONFIG = join(dir, "config.json");

const { AGENT_MARKER, isAgentAuthored, isOwnAuthor, markAgentAuthored, predatesAgentMarker } = await import(
  "./classify.js"
);

test("isOwnAuthor matches the configured login case-insensitively", () => {
  assert.equal(isOwnAuthor("owner-login"), true);
  assert.equal(isOwnAuthor("Owner-Login"), true);
  assert.equal(isOwnAuthor("bafolts"), false);
});

test("markAgentAuthored stamps a body, and isAgentAuthored detects it", () => {
  const marked = markAgentAuthored("Fixed in abc123.");
  assert.ok(marked.startsWith("Fixed in abc123."), "keeps the original body first");
  assert.ok(marked.includes(AGENT_MARKER));
  assert.equal(isAgentAuthored(marked), true);
});

test("markAgentAuthored is idempotent — a re-posted body gains only one marker", () => {
  const once = markAgentAuthored("Done.");
  const twice = markAgentAuthored(once);
  assert.equal(once, twice);
  assert.equal(twice.split(AGENT_MARKER).length - 1, 1);
});

test("an owner-typed note is NOT agent-authored (the login alone must not decide)", () => {
  // The crux: the agent posts under the owner's login, so both share an author.
  // Only the marker separates the agent's OUTPUT from the owner's INPUT — a
  // note-to-self must stay triageable.
  const note = "Why is this safe when the socket closes mid-flush?";
  assert.equal(isOwnAuthor("owner-login"), true, "same login as the agent's replies");
  assert.equal(isAgentAuthored(note), false, "but not the agent's own output");
});

test("isAgentAuthored tolerates absent/empty bodies", () => {
  assert.equal(isAgentAuthored(null), false);
  assert.equal(isAgentAuthored(undefined), false);
  assert.equal(isAgentAuthored(""), false);
});

test("predatesAgentMarker backstops legacy acks that carry no marker", () => {
  // Acks posted before the marker shipped are indistinguishable from an owner
  // note by content, so they fall back to a timestamp.
  assert.equal(predatesAgentMarker("2026-08-04T22:08:03Z"), true, "legacy ack");
  assert.equal(predatesAgentMarker("2026-08-06T10:00:00Z"), false, "written after release");
  // No/!parseable timestamp (e.g. a synthetic CI item) must NOT be called legacy —
  // defaulting to "agent output" there would silently mute real feedback.
  assert.equal(predatesAgentMarker(null), false);
  assert.equal(predatesAgentMarker(""), false);
  assert.equal(predatesAgentMarker("not-a-date"), false);
});
