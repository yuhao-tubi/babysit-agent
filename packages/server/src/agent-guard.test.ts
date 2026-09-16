import { test } from "node:test";
import assert from "node:assert/strict";

import { agentGuardHooks, createRepeatGuard, scanDenialReason, worktreeBriefing } from "./agent-guard.js";

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
  assert.equal(wired.hooks.PreToolUse?.length, 2);
  assert.equal(wired.hooks.PreToolUse?.[0].matcher, "Bash");
  // The repeat guard must see every tool (it resets on Edit/Write), so it is
  // deliberately registered WITHOUT a matcher.
  assert.equal(wired.hooks.PreToolUse?.[1].matcher, undefined);
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

// ── The repeat guard ────────────────────────────────────────────────────────
// Thread 634: 60 turns, ~60 tool calls, one line of prose, no verdict. The same
// two identifiers searched in the same file six times.
const HTML5 = `${WT}/packages/player/src/adapters/html5.ts`;

test("allows a search once and refuses the identical call the second time", () => {
  const g = createRepeatGuard(WT);
  const call = { pattern: "decodedFrames|droppedFrames", path: HTML5, output_mode: "content" };
  assert.equal(g.check("Grep", { ...call }), null);
  const reason = g.check("Grep", { ...call });
  assert.match(String(reason), /already/i);
  assert.match(String(reason), /FINAL ANSWER NOW/);
});

test("refuses the same question rephrased — flags, tool and regex order do not launder it", () => {
  const g = createRepeatGuard(WT);
  // Verbatim shapes from the 634 transcript, in order.
  assert.equal(g.check("Grep", { pattern: "decodedFrames|droppedFrames", path: HTML5 }), null);
  assert.equal(
    g.check("Bash", { command: `grep -n "decodedFrames\\|droppedFrames" ${HTML5}` }),
    null,
    "a second look with more context is still legitimate"
  );
  // The third, fourth and fifth ask nothing new.
  assert.ok(g.check("Grep", { pattern: "droppedFrames|decodedFrames", path: HTML5, "-A": 15 }));
  assert.ok(g.check("Bash", { command: `grep -n  "decodedFrames\\|droppedFrames"   ${HTML5}` }));
  assert.ok(g.check("Grep", { pattern: "decodedFrames|droppedFrames", path: HTML5, output_mode: "files_with_matches" }));
});

test("escalates the wording once the agent keeps re-asking", () => {
  const g = createRepeatGuard(WT);
  const read = { file_path: HTML5, offset: 1240, limit: 120 };
  assert.equal(g.check("Read", { ...read }), null);
  const first = String(g.check("Read", { ...read }));
  const second = String(g.check("Read", { ...read }));
  assert.ok(!first.includes("refusal #"));
  assert.match(second, /refusal #2/);
  assert.match(second, /search loop/);
});

test("an edit resets the memo — re-reading what you just changed is the point", () => {
  const g = createRepeatGuard(WT);
  const read = { file_path: HTML5 };
  assert.equal(g.check("Read", { ...read }), null);
  assert.ok(g.check("Read", { ...read }), "same bytes, no edit in between");
  assert.equal(g.check("Edit", { file_path: HTML5, old_string: "a", new_string: "b" }), null);
  assert.equal(g.check("Read", { ...read }), null, "the file changed; read it again");
});

test("a command that is not a pure read also resets the memo", () => {
  const g = createRepeatGuard(WT);
  const gate = { command: "yarn tsc --noEmit" };
  assert.equal(g.check("Bash", { ...gate }), null);
  assert.equal(g.check("Bash", { ...gate }), null, "re-running the gate after a fix must never be denied");
  assert.equal(g.check("Bash", { command: "npm test" }), null);
  assert.equal(g.check("Bash", { command: "npm test" }), null);
});

test("distinct questions are never confused for each other", () => {
  const g = createRepeatGuard(WT);
  assert.equal(g.check("Grep", { pattern: "decodedFrames", path: HTML5 }), null);
  assert.equal(g.check("Grep", { pattern: "updateFramesData", path: HTML5 }), null, "different terms");
  assert.equal(g.check("Grep", { pattern: "decodedFrames", path: `${WT}/packages/player/src/adapters/web.ts` }), null, "different file");
  assert.equal(g.check("Read", { file_path: HTML5, offset: 100, limit: 40 }), null);
  assert.equal(g.check("Read", { file_path: HTML5, offset: 3020, limit: 40 }), null, "different region");
  assert.equal(g.check("Bash", { command: "git log --oneline -5 -- packages/player" }), null);
  assert.equal(g.check("Bash", { command: "git show 3bcbfe417c^:packages/player/src/adapters/html5.ts" }), null);
});

test("each run gets its own memo", () => {
  const call = { pattern: "decodedFrames", path: HTML5 };
  assert.equal(createRepeatGuard(WT).check("Grep", { ...call }), null);
  assert.equal(createRepeatGuard(WT).check("Grep", { ...call }), null);
});

test("the wired repeat hook denies the second identical Read", async () => {
  const { hooks } = agentGuardHooks(WT);
  const hook = hooks.PreToolUse![1].hooks[0];
  const run = (tool: string, toolInput: Record<string, unknown>) =>
    hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput } as never, "tu_1", {
      signal: new AbortController().signal,
    }) as Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;

  assert.deepEqual(await run("Read", { file_path: HTML5 }), {});
  const blocked = await run("Read", { file_path: HTML5 });
  assert.equal(blocked.hookSpecificOutput?.permissionDecision, "deny");
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
