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

## Quick start

Requires **Node ≥ 22** and an authenticated **`gh` CLI** on the host.

```bash
npm install
npm run build          # build the dashboard bundle the daemon serves
make setup             # interactive wizard: prompts, validates creds live, writes ./.env + ./config.json
make start             # install & load the launchd agent → dashboard at http://localhost:4317
```

That's it. `make start` runs the daemon under launchd (`RunAtLoad` +
`KeepAlive`), so it comes up at login and respawns on crash — see
[Run at login](#run-at-login) for the full target list. Prefer a foreground
process you can watch? `make dev` runs the same daemon in the terminal (Ctrl-C to
stop).

### The setup wizard

`make setup` is the one thing you run to get configured. It **prompts, validates
each credential live, and only then writes** `./.env` + `./config.json`:

- **GitHub token** — a PAT with `repo` scope (`gh` uses it for both the API and
  raw `git push`). Validated with `gh api user`, which also resolves your login.
  Already logged into `gh`? Paste the output of `gh auth token`.
- **KeySmith key** — mints short-lived Bedrock tokens so the agent can call
  Claude. Validated by minting a real token against your configured model.

It fills `githubLogin` + `allowRepos` in `config.json` from your answers; edit
the rest by hand (see [Configuration](#configuration)). Re-validate the existing
creds any time — non-interactively, CI-friendly — with:

```bash
make doctor      # re-check ./.env + ./config.json creds without prompting
```

> `dryRun` defaults to **true**, so a fresh setup makes no GitHub writes — it
> only records verdicts and the actions it *would* take. See
> [Safety / rollout](#safety--rollout) before flipping it off.

### Credentials, in detail

**Bedrock** access uses **KeySmith** ([docs](https://keysmith.int.tubi.io/docs)),
not an AWS profile. Create an API key on the *My Keys* page (the secret is shown
only once). The daemon mints short-lived Bedrock bearer tokens on demand and
resolves `bedrockModelName` to the inference-profile ARN your key may invoke.

**GitHub** access is a token (`GH_TOKEN`) — a PAT with `repo` scope, or the
output of `gh auth token`. The same token authorizes raw `git push`/`clone`, not
just `gh api`.

The wizard writes these to `./.env` (gitignored — treat as secret):

```
GH_TOKEN=...            GITHUB_TOKEN=...
KEYSMITH_URL=https://keysmith.int.tubi.io
KEYSMITH_KEY_ID=01J...  KEYSMITH_SECRET=btv_...
```

Heavy state (SQLite `state.db`, repo clones, worktrees, CI logs) roots under
`BABYSIT_DATA_DIR` (default: the workspace `./.data/`).

## Configuration

`config.json` keys (the wizard fills `githubLogin` + `allowRepos`; edit the rest
by hand):

| key | meaning |
|-----|---------|
| `githubLogin` | your GitHub login; its own comments are skipped |
| `allowRepos` | if non-empty, only these repos are processed; blank = all authored PRs |
| `pollIntervalMs` | poll cadence (default 5 min) |
| `port` | dashboard/API port (default 4317) |
| `dryRun` | **true** = no GitHub writes/pushes (verdicts + would-be actions only) |
| `reposRoot` | where PR clones live |
| `dbPath` | SQLite state file |
| `maxThreadAttempts` | auto-fixes per thread before escalating (loop guard) |
| `botLogins` | extra bot logins beyond `user.type=="Bot"` and `*[bot]` |
| `ignoreRepos` | repos to skip; `owner/repo` matches exactly, a bare name matches any owner |
| `bedrockModelName` | KeySmith friendly model name, resolved to a Bedrock inference-profile ARN (e.g. `claude-opus`) |

## Run at login

`make start` from the quick start symlinks and loads
`launchd/io.tubi.babysit-agent.plist` (`RunAtLoad` + `KeepAlive`), so the daemon
comes up at login and respawns on crash. It runs `npm run dev:server` (tsx
watch), so a backend source change is picked up on the next restart. The full
target list:

```bash
make start    # symlink + load the launchd agent
make logs     # tail stdout/stderr;  make status  for PID/last exit
make restart  # pick up config.json changes;  make stop / uninstall
```

The launchd agent serves the **prebuilt** `packages/web/dist`, so a frontend
change needs `npm run build` + a hard browser refresh.

### Foreground dev loop

`make dev` runs the daemon in the terminal (`tsx watch`, Ctrl-C to stop) instead
of under launchd — handy for watching logs live. For UI work, `npm run dev:web`
gives a hot-reloading dashboard (on :4318) that proxies the API to the daemon —
pair it with `make dev`.

## Read-only verification CLI

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

## Alternative: Docker

Native under launchd is the recommended run path on macOS. A self-contained
Docker image is also available — but note the tradeoff:

> **Why native over Docker on a Mac?** Docker Desktop runs the container in a
> Linux VM and reaches your files over a VirtioFS bind mount, which carries a
> large small-file I/O penalty. This daemon's hot path — `git worktree`/checkout
> on a multi-GB repo and a `tsc`/ESLint gate that reads thousands of source +
> `@types` files — is exactly what that mount is worst at, so the container's
> gate runs much slower and needs a large Node heap to avoid OOM. Native has none
> of that tax and gets real macOS escalation banners (the container runs on
> Linux, so banners are disabled there — escalations still surface in the
> dashboard).

The image bundles the whole runtime — Node 22, `gh`, `git`, `yarn` — plus the
prebuilt dashboard. **`./.data/` is the single source of truth**, tiered by how
expensive each thing is to rebuild:

```
.data/
  .env, config.json     creds + config (precious — hand-entered)
  state.db              durable thread state (precious)
  repos/                base clones + warm node_modules + private-package auth +
                        pre-build output — EXPENSIVE to reprovision; kept outside cache/
  cache/
    worktrees/          per-fix checkouts (derive from repos/, cheap)
    ci-logs/            materialized CI failure logs (cheap)
```

Everything persists on the host across image upgrades. `cache/` is safe to wipe
wholesale — the daemon rebuilds it from `repos/` on the next poll.

```bash
make docker-build     # build the image (once, and after code changes)
make docker-setup     # same setup wizard, in the container (writes ./.data/.env + config.json)
make docker-up        # start the daemon → dashboard at http://localhost:4317
make docker-logs      # tail logs;   make docker-down  to stop
make docker-doctor    # re-validate creds + config non-interactively
```

`restart: unless-stopped` in `docker-compose.yml` restarts the container at boot
(as long as Docker Desktop is set to start at login).

In the container, run the verification CLI against the live daemon with
`docker compose exec babysit-agent npm run -w @babysit/server list-prs`, etc.

## Maintenance & recovery

- **Clear the cache** (stuck worktree, stale CI logs): `make docker-reset-cache`
  stops the daemon, wipes `.data/cache/`, and restarts. Base clones and creds are
  untouched; worktrees are rebuilt from `repos/` on the next poll. (Native:
  `make stop`, `rm -rf .data/cache`, `make start`.)

- **A wedged base clone.** A base clone's `.git` can be left corrupt by an
  interrupted fetch (daemon killed mid-poll, container OOM, disk full). The
  symptom: a PR that sits in `error` every cycle and never clears. The daemon only
  re-clones when a clone is *missing*, so a present-but-corrupt one won't
  self-heal. Diagnose and get the exact fix with:

  ```bash
  make recover       # native;  make docker-recover  in Docker
  ```

  It never deletes anything — it names the wedged clone(s) and prints the
  commands to run, which delete the one repo dir so the next poll re-clones and
  reprovisions it:

  ```bash
  make stop                              # or  make docker-down
  rm -rf .data/repos/<owner>__<repo>
  make start                             # or  make docker-up
  ```

  (Deleting just `node_modules` inside a clone is always safe — the next poll
  reinstalls it automatically; only a corrupt `.git` needs the whole dir gone.)
