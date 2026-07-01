---
name: ci-feedback-design
description: Agreed design for treating CI check failures as a new "ci" author class of feedback in babysit-agent
metadata:
  type: project
---

Design (grilled & agreed 2026-06-26) for abstracting CI failures as a new feedback type. **Implemented 2026-06-26** (builds clean; pure logic smoke-tested). New file `packages/server/src/ci.ts` holds the pure CI logic (classifyCheck, ciFeedbackId negative-hash, ciThreadKey, materializeCiLog, cleanupCiLog). Touched: types.ts, config.ts, classify.ts (isCiEnabledRepo), gh.ts (getChecks/getFailedCheckLogs + CI items in collectFeedback), poller.ts, verdict.ts (CI policy + log file + ci_test_target), gate.ts (GateOpts ciClass/testTarget + runUnitTests), executor.ts (buildCiFixPrompt, silent push, skip relatedness guard), processor.ts (CI resolution recheck + cleanupCiLog on finalize), web/types.ts. Not yet exercised against a live failing CI run.

**Framing:** CI is a third `AuthorClass` `"ci"` (alongside bot/human), reusing the existing `FeedbackItem`/`Thread` machinery — NOT a separate "Signal" concept.

**Identity & lifecycle:**
- One Thread per failing check *name*: `threadKey = ci:<check-name>` (names are stable across commits; run-ids are not).
- Synthetic `ghId = -(hash(check-name + head-sha))` — **negative** to namespace away from real (positive) GitHub comment ids. Re-open keyed on "new commit" (new sha → new ghId → new activity), not new run or new logs.
- Only `status=completed` + `conclusion ∈ {failure, timed_out}` becomes actionable (excludes action_required/cancelled/stale/skipped/neutral, and all in_progress).
- `getChecks` filters strictly to the PR's **current head sha** — stale failures from superseded commits never re-open mid-flight.
- Resolution flows through the existing `resolvedThreadKeys` path: a CI key is "resolved" when its check is passing OR absent on current head. One `getChecks` in `gh.ts`, consumed symmetrically by `collectFeedback` AND the processor's just-before-action recheck.
- CI Thread born in `collectFeedback`: emits `kind: "ci_failure"` FeedbackItem; poller maps `kind === "ci_failure"` → authorClass `"ci"` (classifyAuthor stays user-only). Guard `isOwnAuthor` against the CI sentinel.

**Verdict (Q8/Q14):** CI verdicts restricted to `auto_fix | escalate` (parseVerdict coerces reply/amend → escalate for CI). One `runVerdict` with a CI branch: CI policy block + log injection + optional `ci_test_target {file, nameFilter?}` in schema. Logs fetched lazily at verdict time (poll-time body = name/conclusion/url only).

**Logs (Q14b/Q15/Q18/Q19):** Fetch full (hard-capped) failed-step log via `getFailedCheckLogs` (resolve run-id from current head; `gh run view --log-failed`). Write it to a file **OUTSIDE the worktree** (`~/.babysit-agent/ci-logs/<threadId>.log`, absolute path in prompt) so it's structurally impossible to commit (`commitAll` does `git add -A`). Agent Greps/Reads it rather than a prompt-injected tail. Shared helper used by BOTH verdict and executor fix worktrees. If logs unfetchable → escalate-with-URL (don't run verdict blind).

**Gate (Q9/Q22/Q21):** Gate becomes CI-class-aware: `runGate(dir, repo, { ciClass })`. Existing typecheck+lint = hard floor; class adds the appropriate script (build-class → `build`, unit-test-class → targeted test). Unit-test fixes: agent supplies `ci_test_target`, gate runs it, **falls back to whole suite** on missing/empty/wrong target; "0 tests matched" never counts as a pass. No detectable script → `ran=false` → escalate. CI Threads **skip the relatedness guard** in the fix→gate loop (the failing check IS the target — retry on any failure up to maxGateFixAttempts).

**Executor (Q10):** CI auto-fix pushes **silently** — no PR ack comment (green check is the acknowledgement). Re-materialize log in fix worktree so fix agent grounds on raw error. `reply:` instruction on a CI Thread falls back to a top-level PR comment.

**Config (Q24):** `ci.enabledRepos` (default `["www"]`, matching like ignoreRepos) is the SOLE enablement switch — replaces a global `ci.enabled` boolean AND drops package.json auto-detection (per-repo opt-in is the scoping). Scoped JS/TS-only for now via this list. `ci.checkAllowlist` = `{pattern, class}` entries (case-insensitive), default covering lint/eslint/typecheck/tsc/build/test/unit. Both repo-enabled AND name-matched required, enforced at poll-time AND re-checked in pipeline. Reuses maxThreadAttempts/maxGateFixAttempts/dryRun unchanged. Sharded checks (`test (shard 1)`) accepted as separate Threads (serial queue makes it safe).

**UI (Q13):** Minimal — widen `authorClass` union to include `"ci"` in web + server types; renders through existing generic components. Ensure run URL is clickable. Defer polish.

Loop-guard convergence (intended): our fix-push → new sha → CI re-runs → if still red, re-open + increment attempt_count (summed over persistent `ci:<name>` row) → eventually maxThreadAttempts → escalate.
