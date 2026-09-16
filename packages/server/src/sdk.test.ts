import { test } from "node:test";
import assert from "node:assert/strict";

import { isMaxTurnsError, RunTrace, transcriptPath } from "./sdk.js";

const CWD = "/Users/leo/dev/tubi/ai_workspaces/babysit-agent/.data/cache/worktrees/adRise__www/596";

test("transcriptPath reproduces the SDK's real on-disk slug", () => {
  process.env.CLAUDE_CONFIG_DIR = "/home/.claude";
  // Verbatim from the directory the SDK actually wrote for the max-turns Verdict
  // on thread 596: every non-alphanumeric char becomes `-`, so `/.data` doubles
  // up and `adRise__www` becomes `adRise--www`. Getting this wrong makes the
  // logged path a dead link, which is the whole point of logging it.
  assert.equal(
    transcriptPath(CWD, "7f54cc19-821c-416a-91c5-974ca0191132"),
    "/home/.claude/projects/-Users-leo-dev-tubi-ai-workspaces-babysit-agent--data-cache-worktrees-adRise--www-596/7f54cc19-821c-416a-91c5-974ca0191132.jsonl"
  );
  delete process.env.CLAUDE_CONFIG_DIR;
});

test("counts assistant turns and points at the transcript", () => {
  const t = new RunTrace(CWD);
  t.note({ type: "system", subtype: "init", session_id: "sess" });
  t.note({ type: "assistant", session_id: "sess" });
  t.note({ type: "assistant", session_id: "sess" });
  t.note({ type: "result", subtype: "success", session_id: "sess", num_turns: 12 });
  const line = t.describe();
  // `num_turns` from the result wins over our own count — it is the SDK's own
  // accounting, and it is the number that must be compared against maxTurns.
  assert.match(line, /turns=12/);
  assert.match(line, /end=success/);
  assert.match(line, /transcript=.*sess\.jsonl/);
});

test("records a turn-budget cutoff, which arrives as no result message at all", () => {
  const t = new RunTrace(CWD);
  t.note({ type: "assistant", session_id: "sess" });
  assert.equal(t.endSubtype, "");
  t.setEnd("error_max_turns");
  assert.equal(t.endSubtype, "error_max_turns");
  // Our own turn count is all there is when the SDK never reports num_turns.
  assert.match(t.describe(), /turns=1 end=error_max_turns/);
});

test("a real result subtype is never overwritten by setEnd", () => {
  const t = new RunTrace(CWD);
  t.note({ type: "result", subtype: "error_during_execution", session_id: "s" });
  t.setEnd("error_max_turns");
  assert.equal(t.endSubtype, "error_during_execution");
});

test("keeps only a bounded tail of stderr", () => {
  const t = new RunTrace(CWD);
  for (let i = 0; i < 40; i++) t.stderr(`line ${i}\n`);
  t.stderr("x".repeat(1000));
  const line = t.describe();
  assert.ok(!line.includes("line 0"), "old stderr lines are dropped");
  assert.ok(line.includes("line 39"), "the most recent stderr survives");
  assert.ok(line.length < 2500, `stderr tail stays bounded, got ${line.length}`);
});

test("blocked filesystem scans show up in the audit line", () => {
  const t = new RunTrace(CWD);
  assert.ok(!t.describe().includes("blocked_scans"), "silent when nothing was denied");
  t.deny();
  t.deny();
  assert.match(t.describe(), /blocked_scans=2/);
});

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
