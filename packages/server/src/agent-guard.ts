/**
 * A load-bearing guardrail on the Bash tool of EVERY agent run: no
 * whole-filesystem scans.
 *
 * Every agent surface (verdict, gate/executor, overview, risks, quiz, explain)
 * gets `Bash` with `permissionMode: "dontAsk"`, because a grounded verdict needs
 * to actually run `git`/`grep`/build commands in the checkout. The failure mode
 * that guardrail leaves open is not a write — it is a READ that never ends: an
 * agent that cannot find a symbol in the worktree reaches for `find / -iname
 * "<thing>*"`. That scans every file on the machine, so it:
 *
 *   - burns the whole turn budget on one command, so the artifact never renders
 *     (a Session brief stuck on "Generating overview…" forever);
 *   - thrashes the page cache and fills swap, which drags the owner's ENTIRE
 *     machine, not just the daemon;
 *   - wakes every file-watching daemon on macOS (Spotlight `mds_stores`, DLP
 *     agents) to re-observe millions of paths.
 *
 * The worktree is a complete checkout, so a scan rooted outside it can never
 * answer a question about the PR — denying it costs the agent nothing and it
 * retries scoped to `cwd`. `permissionDecisionReason` is fed back to the model,
 * so the denial teaches the correct command instead of just failing.
 *
 * A PreToolUse deny is the right layer for this (not a prompt line): prompts are
 * advice, and the whole point is that this must hold on a model that ignores the
 * advice.
 */
import { resolve } from "node:path";
import type { HookCallbackMatcher, HookInput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

/**
 * Commands that walk a directory tree. `locate`/`mdfind` query a machine-wide
 * index and take no path argument at all, so they are unconditionally out.
 */
const TREE_WALKERS = new Set(["find", "fd", "fdfind"]);
const INDEX_SEARCHERS = new Set(["locate", "mdfind", "glocate"]);

/** Recursive-by-argument searchers: only a scan rooted outside `cwd` is a problem. */
const RECURSIVE_GREPS = new Set(["grep", "egrep", "rg", "ag", "ack"]);

/**
 * Split a shell command into the segments that could each be their own
 * invocation. The observed failures chained several scans in one Bash call
 * (`find / … ; find / … | head`), so checking only the first word of the whole
 * string would wave the second and third one through.
 */
function segments(command: string): string[] {
  return command.split(/(?:\|\||&&|[;|&\n])+/g);
}

/** Bare-bones argv split — good enough to read the binary name and path args. */
function words(segment: string): string[] {
  const out = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return out.map((w) => w.replace(/^['"]|['"]$/g, ""));
}

/**
 * A path argument that leaves the worktree. `~`/`$HOME` never resolve to the
 * worktree, and an absolute path is only fine if it sits under `cwd` (the
 * worktree path itself is absolute, so agents legitimately pass it).
 */
function escapesWorktree(arg: string, cwd: string): boolean {
  if (arg === "~" || arg.startsWith("~/") || arg.startsWith("$HOME")) return true;
  if (!arg.startsWith("/")) return false;
  const root = resolve(cwd);
  return arg !== root && !arg.startsWith(`${root}/`);
}

/**
 * `null` = allowed. A string = the denial reason handed back to the model.
 * Exported for the unit test; the hook below is the wiring.
 */
export function scanDenialReason(command: string, cwd: string): string | null {
  for (const segment of segments(command)) {
    const argv = words(segment.trim());
    if (argv.length === 0) continue;
    // Skip a leading `sudo`/`time`/`env` wrapper so it can't smuggle a scan past.
    let i = 0;
    while (i < argv.length && /^(sudo|time|nice|command|env)$/.test(argv[i])) i++;
    const bin = (argv[i] ?? "").split("/").pop() ?? "";

    if (INDEX_SEARCHERS.has(bin)) {
      return `\`${bin}\` searches a machine-wide index outside this checkout and is not allowed. The worktree at ${cwd} is a complete checkout — use Grep/Glob, or \`git grep\`, scoped to it.`;
    }
    if (!TREE_WALKERS.has(bin) && !RECURSIVE_GREPS.has(bin)) continue;

    for (const arg of argv.slice(i + 1)) {
      if (arg.startsWith("-")) continue;
      if (!escapesWorktree(arg, cwd)) continue;
      return `A filesystem scan rooted at \`${arg}\` is not allowed — it would walk the whole machine, exhaust this run's turn budget, and answer nothing. The worktree at ${cwd} is a complete checkout of the PR: re-run the search scoped to it (Grep/Glob, \`git grep\`, or \`find . …\`). If what you are looking for is a dependency, look in \`${cwd}/node_modules\`; if it is genuinely absent from the checkout, say so and move on.`;
    }
  }
  return null;
}

/**
 * Spread this into EVERY `query()` options object. Pass the same `cwd` the run
 * gets — the check is relative to that worktree.
 *
 * It returns the `{ hooks: … }` WRAPPER, not the bare event record, and that is
 * load-bearing: spreading an object into an object literal skips TypeScript's
 * excess-property check, so a version of this that returned `{ PreToolUse: … }`
 * compiled clean, silently set `options.PreToolUse`, and never fired. If you
 * refactor this signature, assert on the shape — the type system will not.
 */
export function agentGuardHooks(
  cwd: string,
  onDeny?: (detail: string) => void
): { hooks: Partial<Record<"PreToolUse", HookCallbackMatcher[]>> } {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            async (input: HookInput) => {
              const command = (
                (input as PreToolUseHookInput).tool_input as { command?: string } | undefined
              )?.command;
              const reason = command ? scanDenialReason(command, cwd) : null;
              if (!reason) return {};
              onDeny?.(`blocked filesystem scan: ${command}`);
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: reason,
                },
              };
            },
          ],
        },
      ],
    },
  };
}

/**
 * The location briefing to put in an agent's PROMPT — the soft half of the same
 * concern `agentGuardHooks` enforces.
 *
 * Every agent run gets `cwd` set on the SDK options, but nothing ever told the
 * MODEL where it is: the system prompts said only "a checkout of the PR branch".
 * That is fine while relative paths work, and goes wrong the moment the agent
 * wants to confirm its own location — one observed Verdict run guessed
 * `cd /home/user/www` (a container path, on a macOS host), fell through to
 * `find / -maxdepth 3 -iname www`, and then spent its remaining budget on git
 * archaeology (11 repeats of `git log --oneline`) instead of reading the code.
 * It hit `error_max_turns` at 119 turns and 161k output tokens without producing
 * a verdict.
 *
 * The hook denies the scan; this stops the agent needing one. Cheap insurance:
 * three lines of prompt against a whole wasted run.
 */
export function worktreeBriefing(dir: string): string {
  return [
    `Working directory (absolute): ${dir}`,
    `  This is a COMPLETE checkout of the PR branch — every file you need is under it.`,
    `  Never look for the repo elsewhere on this machine, and never run a filesystem`,
    `  scan rooted outside it (\`find /\`, \`locate\`, \`mdfind\`): such commands are`,
    `  refused. Use paths relative to this directory, or Grep/Glob/\`git grep\`.`,
  ].join("\n");
}
