/**
 * Load-bearing guardrails on the tools of EVERY agent run. Two failure modes,
 * both of which end a run at `error_max_turns` with nothing to show for it:
 * a read that never ends (`find /`), and a read that never STOPS BEING REPEATED
 * (the same search, over and over, until the budget is gone).
 *
 * ── 1. No whole-filesystem scans (`scanDenialReason`) ──
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
 * ── 2. No repeated searches (`createRepeatGuard`) ──
 *
 * Observed on Thread 634 (a `cursor[bot]` comment on a 3k-line `html5.ts`): the
 * Verdict agent spent all 60 turns on ~60 tool calls and ONE line of prose. It
 * ran `decodedFrames|droppedFrames` against the same file six times — same
 * 424-character result every time, only the flags and the tool (Grep vs. Bash
 * `grep`) varied — never emitted the JSON block, and the Thread escalated
 * unanswered. The answer was in the first result.
 *
 * So a repeat of a READ, with no edit in between, cannot teach the agent
 * anything: the checkout has not changed, so the bytes coming back are the ones
 * already in its context. Denying it costs nothing and the reason ("you already
 * ran this; use what it returned or decide now") is the nudge that breaks the
 * loop. A mutation resets the memo, because after an Edit a re-read is the whole
 * point — that is what keeps this safe for the fix agent.
 *
 * A PreToolUse deny is the right layer for both (not a prompt line): prompts are
 * advice — `verdict.ts` already spends a paragraph on budget discipline, and this
 * run ignored it — and the whole point is that this must hold on a model that
 * ignores the advice.
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
 *
 * Quote-aware, and that is not cosmetic: a plain `split(/[;|&]/)` cuts
 * `grep -n "decodedFrames\|droppedFrames" f` in half, and the second half
 * (`droppedFrames" f`) reads as an unknown binary. The scan guard could live with
 * that (an extra segment only ever denies more), but the repeat guard reads the
 * same segments to decide whether a command is a pure read — and there, one
 * alternation in a regex would have wiped its memo.
 */
function segments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      // Only double quotes honour backslash escapes; in single quotes it is literal.
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += ch + command[++i];
        continue;
      }
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[++i];
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.filter((segment) => segment.trim().length > 0);
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

/** Tools that change the checkout — after one, every earlier read is fair to redo. */
const MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Bash binaries that only READ (or only move the shell around). Anything not
 * listed — `yarn`, `npm`, `git apply`, a test run — is assumed to change the
 * tree, which just resets the memo. The list errs toward "not reading": a
 * mistake there costs a missed dedupe, while the reverse would deny a legitimate
 * re-run after a build.
 */
const READING_BINS = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd", "fdfind",
  "ls", "cat", "bat", "head", "tail", "sed", "awk", "wc", "sort", "uniq", "cut",
  "tr", "nl", "jq", "yq", "file", "stat", "tree", "du", "basename", "dirname",
  "which", "echo", "printf", "cd", "pwd", "true", ":",
]);

/**
 * `git` subcommands that only read. `config`/`branch`/`tag` are deliberately
 * absent — each has a writing form (`git config a b`, `git branch -D`), and the
 * cost of leaving them out is only a reset memo.
 */
const READING_GIT = new Set([
  "log", "show", "diff", "grep", "status", "blame", "ls-files", "ls-tree",
  "rev-parse", "rev-list", "merge-base", "describe", "cat-file", "shortlog",
  "name-rev", "whatchanged", "reflog",
]);

/** grep-family binaries, whose argv is `<pattern> <path…>` after the flags. */
const GREP_BINS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);

/**
 * Identifier-ish words, minus the keywords that appear in half of all searches
 * and would collide two unrelated queries.
 */
const NOISE_TERMS = new Set([
  "this", "const", "function", "return", "true", "false", "null", "undefined",
  "export", "import", "async", "await", "from", "type", "class", "private",
  "public", "void", "then", "case", "else", "with", "self",
]);

/** The distinct identifiers a search is really asking about, order-independent. */
function searchTerms(pattern: string): string[] {
  const found = pattern.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [];
  return [...new Set(found.filter((t) => !NOISE_TERMS.has(t)))].sort();
}

/** Worktree-relative, so the same file named absolutely and relatively collides. */
function relTarget(path: string, cwd: string): string {
  const root = resolve(cwd);
  const rel = path === root ? "." : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  return rel.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}

/** Split a command the way `scanDenialReason` does, then read each binary name. */
function commandBins(command: string): { bin: string; argv: string[] }[] {
  const out: { bin: string; argv: string[] }[] = [];
  for (const segment of segments(command)) {
    const argv = words(segment.trim());
    if (argv.length === 0) continue;
    let i = 0;
    while (i < argv.length && /^(sudo|time|nice|command|env)$/.test(argv[i])) i++;
    const bin = (argv[i] ?? "").split("/").pop() ?? "";
    out.push({ bin, argv: argv.slice(i + 1) });
  }
  return out;
}

/** Does every segment of this command merely read the checkout? */
function isReadingCommand(command: string): boolean {
  const parts = commandBins(command);
  if (parts.length === 0) return false;
  return parts.every(({ bin, argv }) =>
    bin === "git" ? READING_GIT.has(argv.find((a) => !a.startsWith("-")) ?? "") : READING_BINS.has(bin)
  );
}

/**
 * A key naming the QUESTION a search asks — terms plus target, with the flags
 * thrown away. This is what makes `Grep{pattern:"a|b", path:f}`,
 * `grep -n "a\|b" f` and `grep -A5 "b|a" f` one key instead of three: they
 * return the same lines, so the second and third teach nothing.
 */
function questionKey(pattern: string, targets: string[], cwd: string): string | null {
  const terms = searchTerms(pattern);
  if (terms.length === 0) return null; // punctuation-only regex — too vague to judge
  const where = targets.length > 0 ? targets.map((t) => relTarget(t, cwd)).sort().join(",") : ".";
  return `question:${terms.join(",")}@${where}`;
}

/** The keys a call is remembered by, each with how many times it may be asked. */
function callKeys(tool: string, input: Record<string, unknown>, cwd: string): { key: string; limit: number }[] {
  // An IDENTICAL call may happen once; a rephrasing of the same question twice
  // (locate-then-read-in-detail is a real pattern) — the third is a loop.
  const exact = { key: `exact:${tool}:${JSON.stringify(input, Object.keys(input).sort())}`, limit: 1 };

  if (tool === "Grep") {
    const q = questionKey(String(input.pattern ?? ""), [String(input.path ?? ".")], cwd);
    return q ? [exact, { key: q, limit: 2 }] : [exact];
  }
  if (tool === "Bash") {
    const command = String(input.command ?? "");
    // Normalize whitespace so re-indenting a command is not a new call.
    const keys = [{ key: `exact:Bash:${command.replace(/\s+/g, " ").trim()}`, limit: 1 }];
    for (const { bin, argv } of commandBins(command)) {
      if (!GREP_BINS.has(bin)) continue;
      const positional = argv.filter((a) => !a.startsWith("-"));
      const [pattern, ...paths] = positional;
      const q = pattern ? questionKey(pattern, paths, cwd) : null;
      if (q) keys.push({ key: q, limit: 2 });
    }
    return keys;
  }
  return [exact];
}

/**
 * `null` = allowed. A string = the denial reason handed back to the model.
 *
 * Stateful ON PURPOSE: one guard per agent run (see `agentGuardHooks`), so the
 * memo dies with the run. Exported for the unit test.
 */
export function createRepeatGuard(cwd: string): {
  check: (tool: string, input: Record<string, unknown>) => string | null;
} {
  const seen = new Map<string, number>();
  let denials = 0;

  return {
    check(tool, input) {
      // The world changed: everything read before this is worth reading again.
      if (MUTATING_TOOLS.has(tool)) {
        seen.clear();
        return null;
      }
      if (tool === "Bash" && !isReadingCommand(String(input.command ?? ""))) {
        seen.clear();
        return null;
      }

      let over: { key: string; limit: number; count: number } | null = null;
      for (const { key, limit } of callKeys(tool, input, cwd)) {
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count > limit && !over) over = { key, limit, count };
      }
      if (!over) return null;

      denials++;
      const what = over.key.startsWith("question:")
        ? `You have already searched for these same terms in the same place ${over.count - 1}× in this run (Grep and Bash \`grep\` count as the same search)`
        : `You have already made this exact ${tool} call ${over.count - 1}× in this run`;
      const lines = [
        `${what}, and nothing in the checkout has changed since — the result would be byte-for-byte what you already have above. Refused.`,
        `Use the result you already got: open the specific file:line it pointed at, or, if you have enough to decide, WRITE YOUR FINAL ANSWER NOW. Varying the flags, the tool, or the regex to re-ask the same question will be refused too.`,
      ];
      if (denials > 1) {
        lines.push(
          `This is refusal #${denials} in this run. You are in a search loop and burning the turn budget: a run that ends without its final answer decides nothing. Stop investigating and answer with what you have.`
        );
      }
      return lines.join("\n");
    },
  };
}

/**
 * Spread this into EVERY `query()` options object. Pass the same `cwd` the run
 * gets — the check is relative to that worktree.
 *
 * Call it ONCE PER RUN: the repeat guard's memo lives in the closure, so sharing
 * one return value across two runs would deny the second run's first search.
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
  const repeats = createRepeatGuard(cwd);
  const deny = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  });

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
              return deny(reason);
            },
          ],
        },
        {
          // No matcher — the repeat guard must see EVERY tool call, including the
          // Edit/Write ones that reset its memo.
          hooks: [
            async (input: HookInput) => {
              const call = input as PreToolUseHookInput;
              const toolInput = (call.tool_input ?? {}) as Record<string, unknown>;
              const reason = repeats.check(call.tool_name, toolInput);
              if (!reason) return {};
              onDeny?.(`blocked repeat ${call.tool_name} call: ${JSON.stringify(toolInput).slice(0, 200)}`);
              return deny(reason);
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
