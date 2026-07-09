import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuizFile } from "./quiz.js";

const good = {
  question: "What does foo() return for an empty list after this PR?",
  options: ["throws", "returns []", "returns null"],
  correctIndex: 1,
  explanation: "The new guard at foo.ts:42 short-circuits to an empty array.",
};

test("parses a well-formed quiz array", () => {
  const out = parseQuizFile(JSON.stringify([good]));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], good);
});

test("returns [] on non-array / malformed JSON", () => {
  assert.deepEqual(parseQuizFile("not json"), []);
  assert.deepEqual(parseQuizFile(JSON.stringify({ question: "x" })), []);
});

test("drops entries with out-of-range correctIndex", () => {
  assert.deepEqual(parseQuizFile(JSON.stringify([{ ...good, correctIndex: 3 }])), []);
  assert.deepEqual(parseQuizFile(JSON.stringify([{ ...good, correctIndex: -1 }])), []);
});

test("drops entries with too few or too many options", () => {
  assert.deepEqual(parseQuizFile(JSON.stringify([{ ...good, options: ["only one"] }])), []);
  assert.deepEqual(
    parseQuizFile(JSON.stringify([{ ...good, options: ["a", "b", "c", "d", "e"] }])),
    []
  );
});

test("drops entries missing required fields but keeps the valid ones", () => {
  const out = parseQuizFile(
    JSON.stringify([good, { question: "", options: ["a", "b"], correctIndex: 0, explanation: "" }])
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].question, good.question);
});

test("rejects non-integer correctIndex", () => {
  assert.deepEqual(parseQuizFile(JSON.stringify([{ ...good, correctIndex: 1.5 }])), []);
});
