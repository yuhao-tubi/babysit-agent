import { test } from "node:test";
import assert from "node:assert/strict";

import { agentGuardHooks, scanDenialReason, worktreeBriefing } from "./agent-guard.js";

const WT = "/data/cache/worktrees/adRise__www/-35613";
const denied = (cmd: string) => scanDenialReason(cmd, WT) !== null;

test("denies the whole-filesystem scans observed in the wild", () => {
  // Verbatim from the runs that pegged the owner's machine.
  assert.ok(denied('find / -iname "*.tgz" -path "*popcorn*"'));
  assert.ok(denied('find / -iname "popcorn-ui*" -path "*cache*" | head'));
  assert.ok(denied('find / -type d -iname "popcorn-ui"'));
  assert.ok(denied('find / -iname "gap-controller*" | grep -v Trash'));
  assert.ok(denied('find ~/.cache ~/.npm -iname "*popcorn*"'));
});

test("denies a scan hidden in a later segment of a chained command", () => {
  // The real failures chained several scans in one Bash call, so a check that
  // only reads the first word of the command would wave these through.
  assert.ok(denied('cd packages/player && find / -iname "*.tgz"'));
  assert.ok(denied('git status; find / -name foo'));
  assert.ok(denied('rg needle . || find / -name needle'));
  assert.ok(denied('sudo find / -name foo'));
});

test("denies index searchers outright — they have no path argument to scope", () => {
  assert.ok(denied("locate popcorn-ui"));
  assert.ok(denied('mdfind "kMDItemFSName == gap-controller*"'));
});

test("allows every legitimate search scoped to the worktree", () => {
  assert.ok(!denied('find . -name "*.ts"'));
  assert.ok(!denied('find src packages -iname "gap-controller*"'));
  assert.ok(!denied(`find ${WT}/packages -name "*.tsx"`));
  assert.ok(!denied(`find ${WT} -maxdepth 2 -name package.json`));
  assert.ok(!denied('grep -rn "gapController" src'));
  assert.ok(!denied("rg -n useAutoplay packages/player/src"));
  assert.ok(!denied("git grep -n gapController"));
  assert.ok(!denied('find node_modules/@adrise -maxdepth 1 -type d'));
});

test("leaves non-search commands alone, including ones with absolute paths", () => {
  assert.ok(!denied("yarn pre-build && yarn tsc --noEmit"));
  assert.ok(!denied("git diff origin/master...HEAD -- packages/player"));
  assert.ok(!denied("cat /etc/hosts"));
  assert.ok(!denied("ls -la /tmp"));
});

// The first version of this shipped the bare `{ PreToolUse: … }` record instead
// of `{ hooks: { PreToolUse: … } }`. Spreading it into the query() options
// literal skips TypeScript's excess-property check, so it compiled, set
// `options.PreToolUse`, and the guard never ran — the daemon kept scanning the
// whole disk. These two tests are the only thing standing between that mistake
// and production.
test("wires under the `hooks` key the Agent SDK actually reads", () => {
  const wired = agentGuardHooks(WT);
  assert.deepEqual(Object.keys(wired), ["hooks"]);
  assert.equal(wired.hooks.PreToolUse?.length, 1);
  assert.equal(wired.hooks.PreToolUse?.[0].matcher, "Bash");
});

test("the wired hook denies a Bash scan and allows a scoped one", async () => {
  const { hooks } = agentGuardHooks(WT);
  const hook = hooks.PreToolUse![0].hooks[0];
  const run = (command: string) =>
    hook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } } as never,
      "tu_1",
      { signal: new AbortController().signal }
    );

  const blocked = (await run('find / -iname "*.tgz"')) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  assert.equal(blocked.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(String(blocked.hookSpecificOutput?.permissionDecisionReason), /complete checkout/);

  assert.deepEqual(await run('find . -name "*.ts"'), {});
});

test("the denial reason names the offending root and points at the worktree", () => {
  const reason = scanDenialReason('find / -iname "*.tgz"', WT);
  assert.ok(reason?.includes("`/`"));
  assert.ok(reason?.includes(WT));
});

test("the prompt briefing states the absolute cwd and names the refused commands", () => {
  // The soft half of the same guardrail. A Verdict run that did not know where it
  // was guessed `cd /home/user/www`, fell through to `find /`, and burned its whole
  // budget on git archaeology (error_max_turns at 119 turns / 161k output tokens).
  const b = worktreeBriefing(WT);
  assert.ok(b.includes(WT), "must state the absolute path, not just 'a checkout'");
  assert.match(b, /find \//, "must name the shape that gets refused");
  assert.match(b, /COMPLETE checkout/i, "must say everything needed is inside");
});
