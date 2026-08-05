import { test } from "node:test";
import assert from "node:assert/strict";
import { isMaxTurnsError } from "./sdk.js";

test("recognizes the SDK's wrapped max-turns rejection", () => {
  // This is the verbatim shape the SDK throws: Query.readMessages replaces the
  // non-zero process exit with the last error-result text. Thread 213 hit this
  // and landed in `error` because verdict.ts had no catch around the loop.
  const err = new Error(
    "Claude Code returned an error result: Reached maximum number of turns (40)"
  );
  assert.equal(isMaxTurnsError(err), true);
});

test("recognizes the bare max-turns message", () => {
  assert.equal(isMaxTurnsError(new Error("Reached maximum number of turns (60)")), true);
});

test("does not swallow unrelated SDK failures", () => {
  assert.equal(isMaxTurnsError(new Error("Claude Code process exited with code 1")), false);
  assert.equal(
    isMaxTurnsError(new Error("Failed to spawn Claude Code process: ENOENT")),
    false
  );
});

test("tolerates non-Error throws", () => {
  assert.equal(isMaxTurnsError("Reached maximum number of turns (40)"), true);
  assert.equal(isMaxTurnsError(null), false);
  assert.equal(isMaxTurnsError(undefined), false);
});
