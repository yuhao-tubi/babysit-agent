# PR Overview + Diagram — design decisions (grilling session)

> **SUPERSEDED (diagram medium → EXCALIDRAW, 2026-07-07):** The abstract
> React-Flow `DiagramSpec` graph (the block immediately below) is replaced by
> **editable Excalidraw canvases**. The agent now AUTHORS raw `.excalidraw` JSON
> directly (coordinates, shapes, colors) and self-corrects via a
> **write→render→view→fix loop**: it writes each canvas to the worktree, renders
> it to PNG with an in-package TS+Playwright+Chromium renderer (`render.ts`, a
> port of the reference skill's `render_excalidraw.py`), Reads the PNG back, and
> edits until the layout is clean. Decisions locked in the follow-up grilling:
>
> - **Pipeline (Q1=B):** full pipeline replacement — agent owns coordinates; no
>   dagre, no React Flow. **Render loop (Q2, Q3=A, Q5=A):** the generation agent
>   drives the loop in-worktree; the renderer is TS+Playwright+**Chromium**
>   (esm.sh replaced by a **vendored `@excalidraw/utils`** served over loopback
>   HTTP — offline, version-pinned; fonts render via `fontFamily:3` monospace, so
>   the headless PNG matches the browser canvas).
> - **Artifact (Q6=A, Q8=A):** stored as a **map of Excalidraw docs keyed by
>   section** `{why?,what?,how?}` in the reused `diagrams_json` column (the shape
>   changed, not the column). One canvas per 4W1H section; section switcher kept.
> - **Frontend (Q6=A):** `DiagramSet.tsx` mounts `@excalidraw/excalidraw` in
>   **edit mode** with a **Save** button → new **`PUT /api/prs/:key/diagrams`**
>   (first mutating overview route; local-disk only, `dryRun`-exempt).
> - **Save vs Regenerate (Q7=A):** single source of truth — Save overwrites the
>   canvas and stamps `diagrams_edited_at`; Regenerate **warns before discarding**
>   manual edits and the edit-stamp **suppresses the head-SHA staleness nag**.
> - **Delivery (Q9=A):** agent writes `overview/{why,what,how}.excalidraw` +
>   `overview/overview.json`; server reads the FILES back from the worktree after
>   `query()` (verbose JSON never round-trips through output tokens).
> - **Methodology + deps (Q10=A, Q11=A):** the reference skill's docs are
>   **vendored** into `packages/server/src/overview-assets/` (methodology,
>   element-templates, json-schema, **rebranded color-palette**) + the render
>   template; the agent Reads them by absolute path. Sandbox stays sealed
>   (`settingSources: []`). `maxTurns` raised 60 → **150** for the loop.
> - **Failure model (Q12=B → Q13=A):** NO silent degradation — the diagrams are
>   the point. Missing Chromium (checked up front via `chromiumAvailable()`) or a
>   render that won't converge ⇒ the generation is `failed` with an actionable
>   message (`make setup-render`); the daemon keeps polling, Threads untouched.
> - **Acceptance:** Rungs 1–2 automated in `render.test.ts` (real headless render
>   of a fixture + round-trip + failure paths; skip when Chromium absent). Rungs
>   3–5 (CLI single-PR generation on adRise/www#33782, Save/Regenerate write
>   path, daemon in-situ) are the manual gate.
>
> Everything below (the React-Flow `DiagramSpec` block and the original SVG
> decisions) is retained for historical context only.

> **SUPERSEDED (diagram delivery, 2026-07-07):** The single pre-rendered inline
> SVG (decisions 4, 6, 7, 12, 13) has been replaced by a **4W1H diagram SET**.
> The agent now emits ONE JSON block `{summary, overview_md, diagrams: [...]}` —
> no `svg` block, no on-disk SVG file, no `/diagram` route. Each element of
> `diagrams` is a `DiagramSpec` graph (nodes + edges, NO coordinates); the
> frontend (`DiagramSet.tsx`) lays it out with **dagre** and renders it with
> **React Flow**. Storage moved from a file path (`diagram_path`) to a
> `diagrams_json` column on `prs`, returned inline in the overview payload. The
> overview markdown is now structured by **4W1H** (`## Why` / `## What` /
> `## How` / `## Risks`), and a diagram is produced for a Why/What/How idea only
> when it has ≥3 related items. Everything below about the SVG technique is
> retained for historical context only.

> **Status: IMPLEMENTED.** Server + web build clean (`npm run build`). Files:
> `overview.ts` (new), `db.ts` (migration + accessors), `api.ts` (3 routes),
> `cli.ts` (`overview <prKey>`), `config.ts`/`config.example.json` (`overview`
> block), `events.ts` (`pr_overview_updated`), `queue.ts` (shared `repoQueue`),
> `index.ts` (startup sweep), `poller.ts` (persist head_sha); web:
> `OverviewPanel.tsx` (new), `App.tsx`, `api.ts`, `types.ts`, `useEventStream.ts`.


Feature: generate a **PR-level overview** (prose) and a **codebase-relationship
diagram** (inline SVG) for a discovered PR, save the SVG locally, and serve it in
the dashboard.

## Decisions locked

1. **Domain placement (A):** PR-level (Session) artifact, stored on the `prs`
   table — outside the Thread/Verdict lifecycle. Sessions carry no status; this
   hangs off the Session view.
2. **Trigger (A):** On-demand only — a "Generate overview" button hits a new
   endpoint. Nothing runs automatically in the poll cycle.
3. **Staleness (A):** Record the `headSha` the overview was built against. If
   current head differs, show a "stale — regenerate?" banner but keep serving the
   old artifact. Mirrors `Proposal.baseSha` re-check pattern.
4. **Output format (D):** SVG-only. No headless browser / PNG rasterization.
   Adopt the Cocoon tool's *visual technique* (inline SVG), not its runtime.
   (Font: inline @font-face or accept system-mono fallback — settle at impl.)
5. **Single investigation (A):** One agent run produces BOTH `overview_md` and
   `diagram_svg` from one read-only worktree investigation. Shape mirrors
   `verdict.ts` (one `query()`, structured trailing output).
6. **Output/failure model (A):** Two separate fenced blocks — a ```json block for
   `{overview_md, summary}` and a dedicated ```svg block. Validate SVG
   well-formedness (XML parse + `<svg>` root) before persisting. Overview
   survives a bad/missing diagram (graceful degradation). Agent gets NO write
   tools — read-only investigation guarantee preserved.
7. **Storage/serving (A):** Save SVG to
   `~/.babysit-agent/diagrams/<sanitized-prKey>-<headSha>.svg`
   (`/`→`__`, `#`→`__`, matching `owner__repo` clone-dir convention). Serve via a
   dedicated Fastify route (`GET /api/prs/:prKey/diagram`) that resolves the path
   only from the DB row — NOT `@fastify/static` over the state dir. Overview
   markdown stored in SQLite on the `prs` row. On regenerate, delete the previous
   `diagram_path` file (one file per PR at a time).
8. **Concurrency (A):** Run generation inside the existing per-repo `SerialQueue`
   (keyed `owner/repo`) — collision-safety with worktree ops is mandatory. Add a
   per-PR in-flight guard so a double-click can't launch two agents. Accept that a
   diagram request queues behind in-flight Thread work for that repo.
9. **Budget/failure (A):** ~60 turns (broad PR-wide investigation, matches CI
   budget). Reuse `addWorktree` keyed on a PR-unique namespace (NOT a thread id —
   confirms this lives outside the Thread model). On max-turns/failure, save
   partial overview text with an "incomplete" marker; never throw.
10. **dryRun (A):** Feature is read-only w.r.t. GitHub → unaffected by `dryRun`.
    Runs in default config. Only local-disk writes (like SQLite/clones/worktrees).
11. **Dashboard UX (A):** Expandable "Overview" panel on the Session row —
    Generate/Regenerate button, `overview_md` via existing `Markdown.tsx`, inline
    SVG fetched from the Q7 route, stale banner (Q3). New PR-level SSE event
    `{type: "pr_overview_updated", prKey}` for live progress (first prKey-keyed
    event; extends the existing threadId-keyed SSE contract).
12. **Diagram delivery (B′):** Keep `settingSources: []` (sealed sandbox,
    identical to verdict.ts). Do NOT use SDK skill discovery.
    - `["project"]` was rejected: resolves relative to the agent's `cwd`, which is
      the TARGET PR repo's worktree — it would (a) MISS a babysit-agent-resident
      skill entirely and (b) load the target repo's arbitrary `.claude/` hooks
      into the auto-pushing daemon. Wrong on both counts.
    - Deliver the Cocoon SVG template + `diagramming-prs` scoping discipline as
      versioned resource files in babysit-agent, injected via `DIAGRAM_SYSTEM`
      and/or an explicit `Read` of an absolute path passed to the agent.
    - `allowedTools` set programmatically cannot be widened by filesystem
      settings — but we're not relying on that; the sandbox stays sealed.

13. **Diagram scoping (A):** Port `diagramming-prs` discipline into
    `DIAGRAM_SYSTEM` — nodes only for 1–4 core files, edges to AFFECTED
    (downstream dependent) code found via Grep/Glob, node cap ~4–8, annotate
    incidentals/tests/lockfiles, disclose include/omit in the overview text.
14. **Overview structure (A):** Fixed 4-part skeleton — (1) What this PR does
    (2–3 sentences), (2) Key changes (bullets), (3) Affected/blast-radius
    (downstream code, reuses diagram investigation), (4) Risks/things to review.
    Concise bullets over paragraphs (shares turn budget with the SVG).
15. **Config (A):** Minimal `overview: { enabled: true, maxTurns: 60 }` block in
    `config.example.json`. Diagrams dir DERIVED from state root (no new path
    key). `ignoreRepos` scope already applies.
16. **CLI (A):** Add `overview <prKey>` to `cli.ts`, mirroring `verdict
    <threadId>` — runs full generation read-only, writes SVG + prints overview,
    no daemon needed. Fast prompt/SVG iteration.
17. **Routing (B):** Keep `prKey` = `owner/repo#number` (poller.ts:51) as the
    identity everywhere; do NOT mint a numeric id. URL-encode it in the path:
    `GET /api/prs/:key/overview` + `/diagram`, client sends
    `encodeURIComponent(prKey)`, server decodes. No schema change to the PK.
    Frontend already has the exact key from `/api/prs`, so no hand-parsing.

18. **DB migration:** Additive columns on `prs` (same PRAGMA-guarded pattern as
    the existing `proposal_json` migration in db.ts):
    - `overview_md TEXT` — the 4-part overview markdown
    - `diagram_path TEXT` — absolute path to the saved SVG (null if none/failed)
    - `overview_head_sha TEXT` — head sha the artifact was built against (Q3 stale)
    - `overview_status TEXT` — `idle | generating | ready | failed`
    - `overview_generated_at TEXT`
    List views must NOT drag `overview_md` into every `prs` query (column hygiene).
19. **Restart of in-flight generation (A):** NO auto-recovery — an overview owes
    GitHub nothing (unlike a Thread mid-push/reply), so the Thread recovery ladder
    is deliberately NOT inherited. Startup sweep flips any
    `overview_status = "generating"` → `failed`; owner re-clicks Generate.

20. **Review-requested PRs (overview-only):** The daemon originally discovered
    ONLY authored PRs (`gh search prs --author=@me`), so review requests never
    appeared. Added `listReviewRequestedPrs()` (`--review-requested=@me`). These
    PRs are OVERVIEW-ONLY — upserted with `role='reviewer'`, NO feedback fetch,
    NO Threads, so they never enter verdict/gate/push (which assume it's your
    branch). New `role` column on `prs` (`author|reviewer`, default author);
    authored set wins if a PR is both. `/api/prs` unions authored (with threads)
    + reviewer (thread-less) rows; web shows a purple REVIEW tag + "Overview
    only", defaults the node open. Reviewer discovery is feature-gated on
    `overview.enabled` and STILL honors `allowRepos`/`ignoreRepos` (decision:
    keep the existing scope — only adRise/www review requests show). Verified:
    poll-once lands the 3 www reviewer PRs; out-of-scope repos filtered.

21. **skipDeps for read-only worktrees:** `addWorktree` grew an
    `opts.skipDeps` flag; the overview path sets it. The fix pipeline needs
    real deps (CoW-clone of a ~2.2GB node_modules + top-up install) to run the
    gate, but a read-only overview only does git diff/Read/Grep — provisioning
    deps was 6+ min of pure waste that stalled every generation. With skipDeps
    the worktree is ready in seconds. Also added a `logEvent` at generation
    START (was only logging on completion — no observability while running).
    VERIFIED end-to-end on adRise/www#30997: ready in ~3min, valid 5.9KB SVG
    served at image/svg+xml, overview correctly traced blast radius + flagged a
    real lazy-initializer timing bug.

## Summary of the shape

- New module `packages/server/src/overview.ts`: `generateOverview(prRow)` — runs a
  read-only worktree investigation on the PR head (reuse `addWorktree` with a
  PR-unique namespace, `settingSources: []`, allowedTools Read/Grep/Glob/Bash,
  ~60 turns), emits a ```json overview block + a ```svg block, validates the SVG,
  writes it to `~/.babysit-agent/diagrams/<sanitized-prKey>-<headSha>.svg`,
  updates the `prs` row + emits `{type:"pr_overview_updated", prKey}`.
- `DIAGRAM_SYSTEM` prompt + Cocoon SVG template as versioned resources, injected
  (B′) — never via settingSources skill discovery.
- Runs inside the per-repo `SerialQueue` with a per-PR in-flight guard.
- API: `POST /api/prs/:key/overview` (generate, key = encodeURIComponent(prKey)),
  `GET /api/prs/:key/overview` (fetch md+status+staleness), `GET
  /api/prs/:key/diagram` (stream the SVG from the DB-recorded path).
- Web: expandable Overview panel on the Session row (Markdown.tsx + inline SVG +
  stale banner + generating spinner driven by the new SSE event).
- CLI: `overview <prKey>` for read-only local iteration.
- Config: `overview: { enabled, maxTurns }` in config.example.json.
- Startup sweep: `generating` → `failed`.
