import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVerdictObject, parseVerdict } from "./verdict.js";

test("parses a plain trailing json verdict block", () => {
  const text = [
    "The bot's finding is valid.",
    "```json",
    '{ "action": "propose", "summary": "s", "reply_draft": "r", "risk": "low" }',
    "```",
  ].join("\n");
  const v = parseVerdict(text);
  assert.equal(v.action, "propose");
  assert.equal(v.risk, "low");
});

test("survives a nested code fence inside reply_draft (thread-33 regression)", () => {
  // The reply_draft value itself contains a ```javascript ... ``` fence. The old
  // non-greedy /```json...```/ regex closed on that inner fence and truncated the
  // JSON, throwing → synthetic 'escalate' with no options/proposal.
  const replyDraft =
    "Valid catch. Fix it like:\\n```javascript\\nconst x = JSON.stringify(d).replace(/<\\\\//g, '<\\\\\\\\/');\\n```\\nThis is the standard mitigation.";
  const text = [
    "Now I can see the issue on line 43.",
    "```json",
    "{",
    '  "action": "propose",',
    '  "summary": "escape </script> in inlined JSON",',
    `  "reply_draft": "${replyDraft}",`,
    '  "risk": "low"',
    "}",
    "```",
  ].join("\n");
  const v = parseVerdict(text);
  assert.equal(v.action, "propose");
  assert.equal(v.risk, "low");
  assert.match(v.reply_draft, /standard mitigation/);
});

test("picks the LAST verdict object when prose contains earlier braces", () => {
  const text = [
    "Consider the object { not: 'a verdict' } shown earlier.",
    "```json",
    '{ "action": "escalate", "summary": "unclear", "reply_draft": "", "risk": "medium", "options": ["do A", "do B"] }',
    "```",
  ].join("\n");
  const v = parseVerdict(text);
  assert.equal(v.action, "escalate");
  assert.deepEqual(v.options, ["do A", "do B"]);
});

test("parses a bare (unfenced) trailing json object", () => {
  const text =
    'Analysis done.\n{ "action": "reply", "summary": "false positive", "reply_draft": "handled at line 10", "risk": "low" }';
  const v = parseVerdict(text);
  assert.equal(v.action, "reply");
});

test("extractVerdictObject ignores a trailing non-verdict object", () => {
  const text = [
    "```json",
    '{ "action": "propose", "summary": "s", "reply_draft": "r", "risk": "low" }',
    "```",
    "For reference the config was { \"foo\": 1 }.",
  ].join("\n");
  const obj = extractVerdictObject(text);
  assert.equal(obj.action, "propose");
});

test("throws when there is no verdict-shaped object", () => {
  assert.throws(() => parseVerdict("I could not decide. No JSON here."));
});

test("ci: coerces a non-propose action to escalate", () => {
  const text =
    '```json\n{ "action": "reply", "summary": "s", "reply_draft": "r", "risk": "low" }\n```';
  const v = parseVerdict(text, true);
  assert.equal(v.action, "escalate");
});
