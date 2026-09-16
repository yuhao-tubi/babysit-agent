# CLAUDE.md

Guidance for working in this repo. For the domain glossary and approved design
decisions, read `CONTEXT.md` first — it is the source of truth for terminology
(Poll cycle, Session, Thread, Verdict, Pre-push gate, Escalation, Instruction).
`README.md` covers setup/run/config.

## What this is

A long-lived local daemon that babysits the GitHub PRs you authored. Each poll
cycle discovers your open PRs, groups review feedback into **Threads**, and runs
each Thread through: **verdict** (Claude Agent SDK decides `auto_fix` / `reply` /
`amend_pr_body` / `escalate`) → **gate** (objective self-verification) →
**executor** (push a fix, post a reply, or escalate). A React dashboard shows the
PRs→Threads tree and is where you unblock escalations with an Instruction.

## Tech stack

- **Node ≥ 22**, TypeScript, ESM (`"type": "module"`). npm workspaces monorepo.
- **Server** (`@babysit/server`): Fastify HTTP/API, `better-sqlite3` for state,
  `@anthropic-ai/claude-agent-sdk` for verdicts/fixes, `node-notifier` for macOS
  banners. Dev via `tsx watch`, build via `tsc`; the daemon runs the build.
  Keep `better-sqlite3` on **≥13** — 13.0.0 moved the addon to the N-API, and the
  pre-13 `node::ObjectWrap` path aborted the whole process from a GC finalizer on
  Node ≥ 23 (`RemoveEnvironmentCleanupHook … Assertion (env) != nullptr`,
  upstream #1515). Don't downgrade it to dodge a build issue.
- **Web** (`@babysit/web`): Vite + React 18 + Ant Design v6, `react-markdown` +
  `remark-gfm`. Dev server proxies the API to the daemon's port.
- GitHub access is the user's authenticated **`gh` CLI** — there is no in-app
  token. Model runs on Bedrock (`claude-sonnet` via the TVM).

## Layout

```
packages/server/src
  index.ts      entrypoint: load config, migrate db, sweep worktrees, start all
  poller.ts     discover authored PRs → upsert Threads (the poll cycle)
  gh.ts         all `gh` CLI calls (PRs, comments, resolution state, push, reply)
  classify.ts   author-class + repo-scope (ignoreRepos) determination
  triage.ts     text-only pre-triage (no agent/checkout) → `dismiss` or carry on
  verdict.ts    Agent SDK call: read-only checkout → structured Verdict
  gate.ts       pre-push gate: build/test or repo-type validator
  executor.ts   acts on a Verdict (fix+push / reply / amend / escalate)
  processor.ts  pipeline orchestration: resolution recheck → verdict → loop-guard → execute
  worktrees.ts  git worktree lifecycle for isolated checkouts/fixes
  db.ts         SQLite schema, migrations, Thread/event queries
  api.ts        Fastify routes + SSE event stream for the dashboard
  queue.ts      SerialQueue (serializes work per repo)
  config.ts / types.ts / events.ts / notify.ts / cli.ts
packages/web/src
  App.tsx, ThreadDetail.tsx, Markdown.tsx, status.tsx, api.ts, useEventStream.ts
```

Runtime state lives under `~/.babysit-agent/` (SQLite `state.db` + repo clones) —
never committed. `config.json` is gitignored; edit `config.example.json` to add
documented keys.

## Principles

- **Read `CONTEXT.md` before changing behavior.** It records decisions already
  made and the ubiquitous language. Keep code, comments, and types using those
  exact terms (Thread, Verdict, gate, escalate…).
- **The Thread is the unit of triage** — one Verdict, one gate run, one
  attempt-loop guard per `(PR, threadKey)`. Status lifecycle:
  `pending → in_progress → (resolved | blocked | awaiting_approval | error)`.
- **Idempotent & state-derived.** Thread existence is recomputed from live GitHub
  state every poll, not from first-sight. The pipeline survives restarts (pending
  threads resume, blocked threads wait for an Instruction, awaiting_approval
  threads keep their frozen Proposal until Approve).
- **Safety first — guardrails are load-bearing, don't weaken them:**
  - `dryRun` (default **true**) gates all GitHub writes/pushes.
  - **Approve is the sole write path.** A code change is a **Proposal** (built,
    gate-verified, parked at `awaiting_approval`); it pushes only on the owner's
    Approve — re-checked against current HEAD (apply-check + re-gate) first. The
    only exception: author classes in `autoPushClasses` (default `[]`) auto-push
    on a passing gate. A freeform Instruction always re-proposes; it never pushes.
  - **A Proposal has two independently-approvable parts: the change and the
    reply.** Approving the change pushes/edits but does NOT post the reply;
    approving the reply posts it but does NOT push. Approving EITHER part resolves
    the Thread (the owner has acted); the other part stays approvable — the frozen
    Proposal is kept until both parts are settled (applied/posted or dismissed/
    absent), so its button still works on the resolved Thread. A
    `reply:` Instruction parks that text as a reply Proposal (verbatim — no agent
    run) for you to review and Post; it never posts directly. The immediate
    verbatim post is the **Reply on GitHub** button only. The instruction box's
    **AI refine** helper is a one-shot direct Claude rewrite (`refine.ts`, Bedrock
    `InvokeModel`) — not an agent run, touches nothing, just returns text.
  - **A stale Proposal is rebuilt, not dead-ended.** Approve's apply-check
    re-seats the frozen diff with a 3-way merge on mere context drift; on a
    same-line conflict with upstream it **auto-re-proposes** (fix agent re-run on
    the new HEAD, shown the diff that no longer applies) and parks the result for
    a second Approve — it never pushes bytes the owner didn't read. An invalid
    diff still blocks. `SerialQueue` is not re-entrant, so the rebuild is driven
    by `approveProposal`'s caller, not inline.
  - `risk:"high"` keeps the Proposal (so the owner reviews the exact diff) but
    **vetoes auto-push** — it always waits for Approve, even for `autoPushClasses`.
  - Fast-forward-only push (abort if the branch moved); serial per-repo queue;
    per-thread auto-push limit before escalating.
  - Never act on a GitHub-resolved Thread — checked at creation *and* just
    before action. Repo scope (`ignoreRepos`) is enforced in the pipeline, not
    just the poller.
  - **`dismiss` is the one Verdict with no Proposal and no GitHub write.** A Thread
    that asks for nothing (bot summary header, boilerplate, LGTM, an echo of our
    own reply) resolves locally — no reply, no diff, not even a GitHub thread
    resolve. Never a way to disagree: any concrete claim about the code is still
    `reply`/`propose`/`escalate`. `triage.ts`'s text-only pre-triage reaches it
    without a checkout and is **fail-open** — any doubt falls through to the
    grounded verdict. Invalid for CI.
  - `amend_pr_body` is **never** auto-applied — it is drafted as a description
    Proposal and applied only on the owner's Approve.
  - Restart recovery re-renders/re-applies durable artifacts (frozen Proposals);
    it **never** replays a stored Verdict decision (that re-escalated a resolved
    Thread). The **agent's own** acks never re-open a Thread — identified by the
    marker stamped on every reply it posts (`AGENT_MARKER`), *not* by the login,
    since the agent posts as `@me`. A comment the **owner** typed is real input: a
    note-to-self is work for the agent, so a Thread you rooted is triaged like any
    other, and only an entirely agent-authored group is never made a Thread.
- **`gh` CLI is the only GitHub surface.** Keep all of it in `gh.ts`; don't
  introduce an Octokit/token path.
- **Verdicts must be grounded.** The agent investigates the real checkout before
  deciding; bot false-positives require cited file/line proof. When unsure,
  escalate.

## Conventions

- ESM imports use explicit `.js` extensions (e.g. `import … from "./db.js"`) even
  for `.ts` sources — required by the module setup.
- Log Thread activity with `logEvent(id, kind, detail)` and broadcast UI updates
  with `emit({ type, threadId })`; the dashboard is driven by that SSE stream.
- Errors in the pipeline move a Thread to `error` (recorded, recoverable) — don't
  let them crash the daemon.

## Common commands

```bash
npm run dev:server     # daemon (tsx watch): poller + API + processor
npm run dev:web        # dashboard with hot reload, proxies API
npm run build && npm start   # production; serves built dashboard

# read-only verification (no GitHub writes)
npm run -w @babysit/server list-prs
npm run -w @babysit/server poll-once
npx tsx packages/server/src/cli.ts verdict <threadId>
```

## Applying changes to the running daemon

The recommended run path is **native under launchd**, running the **built**
daemon (`packages/server/dist/index.js`) directly — no npm wrapper, no
`tsx watch`. So a source change needs a rebuild, which `make restart` does for
you — no image rebuild:

```bash
make restart      # rebuild + kickstart the launchd agent (source AND config.json)
make restart-only # kickstart WITHOUT rebuilding (config.json-only changes)
make logs         # tail stdout/stderr;  make status  for PID/last exit
```

**Don't put `tsx watch` back under launchd.** The watcher outlives the child it
spawns: when the daemon crashed, the watcher stayed alive waiting for a file
change, so launchd's `KeepAlive` saw a healthy `ProgramArguments` process and
never restarted anything. A daemon that was down for days reported healthy in
`launchctl list`. Running node on `dist/index.js` makes the daemon *be* the
supervised process, so a crash is an exit and KeepAlive actually fires.

Because launchd serves the **prebuilt** `packages/web/dist` (via
`@fastify/static`), a frontend change also needs the rebuild + a hard browser
refresh — `make restart` covers both halves.

For live UI work, `npm run dev:web` gives hot reload while proxying the API to a
daemon — pair it with `npm run dev:server` (`tsx watch`) for a native dev loop
against the same code. `tsx watch` is fine *interactively*, where you can see it
die; it is only unsafe as the supervised process.

**Docker (alternative run path).** The image bakes in the built server plus the
prebuilt `packages/web/dist` at build time — neither is bundled on the fly nor
bind-mounted — so any source change is invisible to the running container until
you rebuild the image and recreate the container:

```bash
make docker-build     # rebuild the image with your changes
make docker-restart   # recreate the container (compose up -d --force-recreate)
```

Boot persistence for the container is handled by `restart: unless-stopped` in
`docker-compose.yml`.
