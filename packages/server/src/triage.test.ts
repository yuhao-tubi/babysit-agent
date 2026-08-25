import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTriagePrompt, parseTriage } from "./triage.js";
import type { FeedbackItem } from "./types.js";

// ---- parseTriage: FAIL-OPEN ----
// A wrong dismiss:false costs one extra (grounded) review. A wrong dismiss:true
// silently drops real reviewer feedback. So every ambiguity must land on false.

test("a well-formed dismiss is honored", () => {
  const r = parseTriage('{"dismiss": true, "reason": "Codex review summary header, no findings"}');
  assert.equal(r.dismiss, true);
  assert.match(r.reason, /summary header/);
});

test("a well-formed keep is honored", () => {
  const r = parseTriage('{"dismiss": false, "reason": "asks for a null check"}');
  assert.equal(r.dismiss, false);
  assert.equal(r.reason, "asks for a null check");
});

test("a fenced reply still parses (stray prose and fences tolerated)", () => {
  const text = ['Here you go:', "```json", '{"dismiss": true, "reason": "LGTM only"}', "```"].join("\n");
  assert.equal(parseTriage(text).dismiss, true);
});

test("unparseable text never dismisses", () => {
  for (const text of ["", "   ", "yes, dismiss it", "{not json", "}{"]) {
    const r = parseTriage(text);
    assert.equal(r.dismiss, false, `dismissed on ${JSON.stringify(text)}`);
  }
});

test("a truthy non-boolean dismiss never dismisses", () => {
  for (const raw of ['{"dismiss": "true"}', '{"dismiss": 1}', '{"dismiss": "yes"}', "{}"]) {
    assert.equal(parseTriage(raw).dismiss, false, `dismissed on ${raw}`);
  }
});

test("a non-object reply never dismisses", () => {
  assert.equal(parseTriage("true").dismiss, false);
  assert.equal(parseTriage("[1,2]").dismiss, false);
});

test("a dismiss with no reason still gets a summary to show", () => {
  const r = parseTriage('{"dismiss": true}');
  assert.equal(r.dismiss, true);
  assert.ok(r.reason.trim().length > 0);
});

// ---- buildTriagePrompt: text only ----

const item = (over: Partial<FeedbackItem> = {}): FeedbackItem =>
  ({
    ghId: 1,
    author: "chatgpt-codex-connector",
    authorType: "Bot",
    kind: "review_summary",
    body: "## Codex Review",
    createdAt: "2026-08-24T00:00:00Z",
    ...over,
  }) as FeedbackItem;

test("the prompt carries the bodies and the author class", () => {
  const p = buildTriagePrompt([item({ body: "LGTM 🚀" })], "bot");
  assert.match(p, /author_class: bot/);
  assert.match(p, /LGTM/);
});

test("an over-long body is truncated (a long quote adds no signal)", () => {
  const p = buildTriagePrompt([item({ body: "x".repeat(9000) })], "bot");
  assert.match(p, /\[truncated\]/);
  assert.ok(p.length < 6000);
});

test("an empty body is still rendered explicitly", () => {
  assert.match(buildTriagePrompt([item({ body: "" })], "bot"), /\(empty\)/);
});
