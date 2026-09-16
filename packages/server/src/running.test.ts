import { test } from "node:test";
import assert from "node:assert/strict";

import { claimRun, isRunning, releaseRun, runningThreadIds } from "./running.js";

test("claim is exclusive — a second claim for the same thread is refused", () => {
  assert.equal(claimRun(1), true);
  assert.equal(claimRun(1), false); // the double-run guard
  releaseRun(1);
  assert.equal(claimRun(1), true);
  releaseRun(1);
});

test("claim/release is synchronous, so there is no await between check and claim", () => {
  // This is the whole point: `processThread` reads status, awaits a network call,
  // then writes `in_progress`. That await is a yield point where a second copy of
  // the same thread can interleave. A synchronous claim closes it.
  assert.equal(typeof claimRun(2), "boolean");
  assert.equal(isRunning(2), true);
  releaseRun(2);
  assert.equal(isRunning(2), false);
});

test("different threads claim independently", () => {
  assert.equal(claimRun(10), true);
  assert.equal(claimRun(11), true);
  assert.deepEqual(runningThreadIds().sort((a, b) => a - b), [10, 11]);
  releaseRun(10);
  assert.deepEqual(runningThreadIds(), [11]);
  releaseRun(11);
  assert.deepEqual(runningThreadIds(), []);
});

test("release is idempotent — a finally block may run after an early return", () => {
  claimRun(3);
  releaseRun(3);
  releaseRun(3); // must not throw
  assert.equal(isRunning(3), false);
});

test("only a CLAIMED thread counts as running — a queued one must not", () => {
  // The bug this exists to kill: `approveThread` flips status to `in_progress`
  // synchronously BEFORE entering the serial queue, so the dashboard rendered a
  // thread that had not executed a single line as "Running 16m". A thread is
  // running only while it holds a claim.
  assert.equal(isRunning(42), false); // status may be in_progress; not running
  claimRun(42);
  assert.equal(isRunning(42), true); // the queued job actually started
  releaseRun(42);
  assert.equal(isRunning(42), false);
});
