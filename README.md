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

The simplest way to run it is the bundled Docker image (below); a native
Node setup is documented further down.

## Quick start (Docker)

The image bundles the whole runtime — Node 22, `gh`, `git`, `yarn`, and
Playwright Chromium — plus the prebuilt dashboard. **`./.data/` is the single
source of truth**, tiered by how expensive each thing is to rebuild:

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
wholesale — the daemon rebuilds it from `repos/` on the next poll — so a stuck
worktree or stale log is a one-command fix (`make docker-reset-cache`) that never
touches your creds or the costly base clones.

```bash
make docker-build     # build the image (once, and after code changes)
make docker-setup     # interactive wizard: prompts + validates + writes creds/config
make docker-up        # start the daemon → dashboard at http://localhost:4317
make docker-logs      # tail logs;   make docker-down  to stop
```

`make docker-setup` prompts for your **GitHub token** (a PAT with `repo` scope —
`gh` uses it for both the API and raw `git push`) and your **KeySmith** key, then
validates them live (`gh api user` + a real Bedrock token mint) before writing
`./.data/.env` and `./.data/config.json`. Re-validate any time with `make docker-doctor`.

Equivalent raw `docker run` (compose is just a wrapper):

```bash
docker build -t babysit-agent:latest .
# one-time setup wizard (interactive)
docker run -it --rm -v "$PWD/.data":/data -e PUID=$(id -u) -e PGID=$(id -g) \
  babysit-agent:latest setup
# run the daemon
docker run -d --name babysit-agent --restart unless-stopped \
  -p 4317:4317 -v "$PWD/.data":/data -e PUID=$(id -u) -e PGID=$(id -g) \
  babysit-agent:latest run
```

> The container runs on Linux, so native macOS escalation banners are disabled;
> escalations still surface in the dashboard (and its live event stream).

## Credentials

**Bedrock** access uses **KeySmith** ([docs](https://keysmith.int.tubi.io/docs)),
not an AWS profile. Create an API key on the *My Keys* page (the secret is shown
only once). The daemon mints short-lived Bedrock bearer tokens on demand and
resolves `bedrockModelName` to the inference-profile ARN your key may invoke.

**GitHub** access is a token (`GH_TOKEN`) in `./.env` — a PAT with `repo` scope,
or the output of `gh auth token`. The container's entrypoint runs
`gh auth setup-git` so the same token authorizes raw `git push`/`clone`, not just
`gh api`.

The wizard writes these to `./.env`:

```
GH_TOKEN=...            GITHUB_TOKEN=...
KEYSMITH_URL=https://keysmith.int.tubi.io
KEYSMITH_KEY_ID=01J...  KEYSMITH_SECRET=btv_...
```

## Configuration

`config.json` keys (the wizard fills `githubLogin` + `allowRepos`; edit the rest
by hand):

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
| `bedrockModelName` | KeySmith friendly model name, resolved to a Bedrock inference-profile ARN (e.g. `claude-opus`) |

| `allowRepos` | if non-empty, only these repos are processed; blank = all authored PRs |

## Run natively (without Docker)

Requires Node ≥ 22 and an authenticated `gh` CLI on the host. State then lives
under `~/.babysit-agent/` (unless `BABYSIT_DATA_DIR` is set).

```bash
npm install
cp config.example.json config.json   # edit; dryRun defaults to true
cp .env.example .env                  # KeySmith key (+ GH_TOKEN if gh isn't logged in)

npm run dev:web        # dashboard dev server (hot reload) — http://localhost:4318
npm run dev:server     # daemon (tsx watch)
npm run build && npm start   # production; serves built dashboard at :4317
```

### Read-only verification CLI

```bash
npm run -w @babysit/server list-prs            # list authored open PRs
npm run -w @babysit/server poll-once           # one cycle: upsert threads (sqlite only)
npx tsx packages/server/src/cli.ts threads     # dump threads
npx tsx packages/server/src/cli.ts verdict <id> # run verdict on one thread (no GitHub writes)
```

In the container, run these against the live daemon with
`docker compose exec babysit-agent npm run -w @babysit/server list-prs`, etc.

## Maintenance & recovery

- **Clear the cache** (stuck worktree, stale CI logs): `make docker-reset-cache`
  stops the daemon, wipes `.data/cache/`, and restarts. Base clones and creds are
  untouched; worktrees are rebuilt from `repos/` on the next poll.

- **A wedged base clone.** A base clone's `.git` can be left corrupt by an
  interrupted fetch (daemon killed mid-poll, container OOM, disk full). The
  symptom: a PR that sits in `error` every cycle and never clears. The daemon only
  re-clones when a clone is *missing*, so a present-but-corrupt one won't
  self-heal. Diagnose and get the exact fix with:

  ```bash
  make docker-recover     # probes each base clone; prints recovery commands (deletes nothing)
  ```

  It never deletes anything — it names the wedged clone(s) and prints the
  commands to run, which delete the one repo dir so the next poll re-clones and
  reprovisions it:

  ```bash
  make docker-down
  rm -rf .data/repos/<owner>__<repo>
  make docker-up
  ```

  (Deleting just `node_modules` inside a clone is always safe — the next poll
  reinstalls it automatically; only a corrupt `.git` needs the whole dir gone.)

## Safety / rollout

1. Keep `dryRun: true`. Run `poll-once`, inspect verdicts in the dashboard.
2. Confirm the gate runs the right check per repo and notifications click through.
3. Flip `dryRun: false` and let it act on **one** low-risk comment first.

Guardrails: fast-forward-only push (aborts if the branch moved), `risk:"high"`
forces escalate, serial per-repo queue, and a per-thread auto-fix limit.

## Run at login

`restart: unless-stopped` in `docker-compose.yml` restarts the daemon at boot
(as long as Docker Desktop is set to start at login) — nothing else to install.
