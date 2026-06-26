# PR Babysitting Agent

A long-lived service that babysits your open GitHub PRs. It polls the PRs you
authored, triages each new piece of review feedback with the **Claude Agent
SDK**, and then:

- **auto-fixes & pushes** when it can make the change and self-verify it (build/test or a repo-type validator passes),
- **auto-replies** to *bot* false-positives / nits (with cited proof),
- **escalates** anything needing your judgment — fires a clickable macOS notification (one per PR) and blocks the thread until you weigh in from the **web dashboard**.

See `CONTEXT.md` for the domain glossary and the approved design decisions.

## Architecture

```
packages/server   daemon: poller → verdict (Agent SDK) → gate → executor → API
packages/web      Vite + React dashboard (PRs → threads tree)
```

Runtime state lives under `~/.babysit-agent/` (SQLite `state.db` + repo clones).

## Setup

```bash
npm install
cp config.example.json config.json   # edit; dryRun defaults to true
```

`config.json` keys:

| key | meaning |
|-----|---------|
| `githubLogin` | your GitHub login; its own comments are skipped |
| `pollIntervalMs` | poll cadence (default 5 min) |
| `port` | dashboard/API port (default 4317) |
| `dryRun` | **true** = no GitHub writes/pushes (verdicts + would-be actions only) |
| `reposRoot` | where PR clones live |
| `dbPath` | SQLite state file |
| `maxThreadAttempts` | auto-fixes per thread before escalating (loop guard) |
| `botLogins` | extra bot logins beyond `user.type=="Bot"` and `*[bot]` |
| `ignoreRepos` | repos to skip; `owner/repo` matches exactly, a bare name matches any owner |
| `model` | Agent SDK model id (Bedrock: `us.anthropic.claude-opus-4-8`) |

Uses your existing authenticated `gh` CLI — no in-app GitHub token.

## Run

```bash
# dashboard dev server (hot reload) — proxies API to :4317
npm run dev:web        # http://localhost:4318

# daemon (poller + API + processor)
npm run dev:server     # dev (tsx watch)
npm run build && npm start   # production; serves built dashboard at :4317
```

### Read-only verification CLI

```bash
npm run -w @babysit/server list-prs            # list authored open PRs
npm run -w @babysit/server poll-once           # one cycle: upsert threads (sqlite only)
npx tsx packages/server/src/cli.ts threads     # dump threads
npx tsx packages/server/src/cli.ts verdict <id> # run verdict on one thread (no GitHub writes)
```

## Safety / rollout

1. Keep `dryRun: true`. Run `poll-once`, inspect verdicts in the dashboard.
2. Confirm the gate runs the right check per repo and notifications click through.
3. Flip `dryRun: false` and let it act on **one** low-risk comment first.

Guardrails: fast-forward-only push (aborts if the branch moved), `risk:"high"`
forces escalate, serial per-repo queue, and a per-thread auto-fix limit.

## Optional: run at login (launchd)

Copy `launchd/com.tubi.babysit-agent.plist` to `~/Library/LaunchAgents/`, edit the
paths, then `launchctl load` it. Not installed automatically.
