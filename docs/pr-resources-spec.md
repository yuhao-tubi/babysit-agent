# PR Resources — additive spec

Status: draft for review · Date: 2026-07-17 · Author lens: Leo

## What this is

An **additive** layer on the existing babysitter. Nothing in the current
write-path (poller → verdict → gate → executor → Approve/push, Proposals,
dryRun, autoPush) changes or is removed. We reuse the same ingestion (`gh.ts`),
grounded read-only checkout (`worktrees.ts`), Agent SDK plumbing, SQLite
artifact-lifecycle pattern, SSE stream, and web shell to generate
**NotebookLM-style resources** — gated by the PR's existing `role` field.

Two role-gated resource sets, one ingestion engine:

- **Reviewer role (others' PRs) — a learning corpus.** Heavyweight, durable
  artifacts to get unfamiliar code into your head:
  1. **Overview (4W1H)** — already built (`overview.ts`).
  2. **Diagrams (Excalidraw)** — already built (`render.ts` + Excalidraw loop).
  3. **Quiz** — already built (`quiz.ts`, client-graded MCQ).
  4. **Blind spots** — already built as risks (`risks.ts` finder→confirmer);
     **extend** to *logic blindness* (missed edge cases, flipped defaults,
     callers assuming old behavior), keeping cited detail. The heavier,
     higher-value extension is the **author** path (see below): same engine, run
     for my own PRs, grounded against my PR description.
  5. **Mindmap** — NET-NEW. A mermaid `mindmap` of the change structure. Cheap:
     one grounded pass emitting mermaid, no headless render loop.

- **Author role (my PRs) — Blind spots on my own change.** The primary author
  artifact (Phase 2). A **Blind spot** (see `CONTEXT.md`) is the author-role
  counterpart to a Verified risk — a distinct concept that *reuses the same
  finder→confirmer engine and storage*, not the same artifact. Run for my PRs,
  grounded against my **PR description**, it surfaces behaviors I didn't mention
  or didn't consider whose consequence is test-invisible harm (a query breaks, a
  metric stops reflecting truth, an experiment pollutes unenrolled users). An
  **LLM-derived layer split** (not fixed categories) makes it thorough and
  repo-agnostic. Reuses `risks_json` / `RisksPanel`.
- **Author role — lightweight per-thread feedback digest** (secondary). For each
  feedback thread, a short grounded markdown digest of *what's being asked and
  where*. No cross-thread synthesis, no mermaid, no quiz, no diagrams. Consumes
  `collectFeedback()` (already groups review/bot/issue comments into
  `FeedbackItem[]` per thread). Likely a single `refine.ts`-style call per
  thread, not a full agent.

Dropped: the Feynman examiner / human-grading loop is **not** in scope.

## Scope summary

Genuinely net-new = **~20%**: the mindmap artifact, the **author Blind-spot
finder** (folded-in layer split + PR-body-grounded framing + running `risks.ts`
for author PRs + dropping the overview's inline author `## Risks` prose), and the
per-thread author digest. Everything else is reuse of engines that already exist.
No deletions.

---

## Reuse map (from the code inventory)

| Concern | Existing asset | Action |
|---|---|---|
| Grounded read-only checkout | `worktrees.ts` `addWorktree(..., {skipDeps:true})` | reuse as-is |
| PR ingestion | `gh.ts` read fns + `collectFeedback()` | reuse; add linked-issue fetch (optional) |
| Answer-key-style investigation | `overview.ts` (4W1H, blast-radius grep) | reuse; template for mindmap |
| Blind-spot detection | `risks.ts` finder→confirmer, `RiskItem` | reuse + extend prompts; add layer-split + PR-body framing; **run for author PRs** |
| Diagrams | `render.ts` + `overview-assets/` Excalidraw loop | reuse as-is |
| Quiz | `quiz.ts` + `QuizPanel.tsx` | reuse as-is |
| Artifact lifecycle | `db.ts` per-PR artifact cols (`*_json`,`*_status`,`*_head_sha`) + `getPrOverview`/`updatePrOverview` shape + `failStuck*` recovery | copy pattern for new artifacts |
| On-demand generation | `overview.ts` `requestOverview` (in-flight guard + `repoQueue`) | copy pattern |
| Lightweight LLM call | `refine.ts` one-shot Bedrock `InvokeModel` | template for author digest |
| API + SSE | `api.ts` `GET/POST /api/prs/:key/{overview,quiz,question}`, `pr_*_updated` events | add parallel routes/events |
| Web shell | `App.tsx` PRs tree + main pane, `useEventStream`, `OverviewPanel`, `QuizPanel`, `RisksPanel`, `Mermaid.tsx` | add panels; role-gate tabs |

**Untouched:** `executor.ts`, `gate.ts`, `processor.ts`, Proposals, Approve,
dryRun, autoPush, all push/reply routes and thread-detail write UI.

---

## Data model additions (`db.ts`, `types.ts`)

Follow the existing per-PR artifact convention (status machine + head-sha
staleness), do **not** invent a new table shape:

- `prs.mindmap_json`, `prs.mindmap_status`, `prs.mindmap_head_sha` — reviewer mindmap.
- Reuse existing `risks_json`/`risks_status` for both the logic-blindness
  extension and the author Blind-spot finder — same storage, prompt + wiring
  changes. `RiskItem` gains an optional derived-`layer` tag and an advisory
  `inDescription` flag (additive fields, not a new table).
- **Add `prs.risks_head_sha`** (the one new column). Today reviewer risks
  piggyback on the overview's Generate run and inherit its sha implicitly — a
  reviewer-only assumption, since a reviewer's PR is static. The author path
  **decouples** Blind spots from the overview run, and an author branch moves
  constantly (fix after fix), so a Blind spot shown against a stale sha is
  actively misleading. `risks_head_sha` gives the analysis independent staleness
  tracking (stale-on-head-move like overview/quiz); **regenerate on demand when
  the user opens a stale panel** — *not* auto-regen on every push (deferred: real
  Bedrock spend on a PR nobody's looking at).
- Author digest: `thread_items` already exists per feedback item; add a
  `digest_md` column on the feedback/thread row (per-thread, cited markdown),
  plus a `digest_status`. (Confirm exact table in Phase 3.)

New types in `types.ts`: `Mindmap` (mermaid string + head sha) and
`FeedbackDigest` (per-thread `{ threadKey, digest_md, status }`). `RiskItem`
gains optional `layer?: string` + `inDescription?: boolean`; its generating
prompt broadens and now also runs for author PRs.

Artifact status reuses the existing `idle | generating | ready | error` shape
and the `failStuck*` crash-recovery ladder.

---

## Phased plan

### Phase 1 — Mindmap (reviewer) — smallest net-new, proves the pattern
- New `mindmap.ts` modeled on `overview.ts`: read-only `skipDeps` worktree,
  grounded pass, emit a mermaid `mindmap` block; write manifest to
  `overview/mindmap.json`, read back, persist to `prs.mindmap_*`.
- `requestMindmap()` fire-and-forget with in-flight guard + `repoQueue` (copy
  `requestOverview`).
- API: `POST /api/prs/:key/mindmap` (generate), `GET` via the PR payload;
  emit `pr_mindmap_updated`.
- Web: `MindmapPanel.tsx` rendering the mermaid via existing `Mermaid.tsx`;
  add as a reviewer-only tab.
- **Milestone:** open a reviewer PR → generate → see a grounded mindmap.

### Phase 2 — Author Blind spots (author) — the primary net-new value

**The failure mode.** The PR is mine. I wrote a description asserting what it
does. But the code *also* does things I didn't mention or didn't fully consider,
and CI is green because these harms are invisible to tests — they land later in a
dashboard or an experiment readout:

- **Query / data health** — a downstream query breaks: a field that can now be
  null, a type/cardinality change, a column a consumer quietly depends on.
- **Metric fidelity** — the event compiles and fires but won't reflect truth:
  fires on render not action, counts retries, no dedup, wrong grain
  (per-session vs per-user), an unintended conditional.
- **Experiment integrity** — exposure logged *before/outside* the gate check →
  pollutes users never enrolled; control path mutated; wrong bucketing key;
  treatment leaks into the holdout.

These are **guidance/priorities in the finder prompt, not fixed buckets** — they
fire hard on www and stay dormant where irrelevant.

**Harm-hunting is primary; the PR body is a lens, not the gate.** The finder's
core job is to surface downstream harm *regardless of what the description says*
— a blind spot is worth flagging whether or not I mentioned it. The PR body is
*one input*: it lets the finder *also* tag a finding **not-in-description**
(advisory), which is why an empty, stale, or aspirational body degrades
gracefully to pure harm-hunting instead of producing "you didn't mention X" noise
about real current behavior. The `inDescription` flag is advisory metadata on a
finding, never a filter that suppresses one.

**Two-pass pipeline (unchanged pass count from today), author-role, harm-hunting
with the PR body as an advisory lens:**

1. **Finder with folded-in layer split.** *One* finder pass (reuse `risks.ts`
   finder), prompted to **partition-then-hunt**: first name the diff's own layers
   — a www PR might yield `analytics / experiment / UI-UX / logic`; another repo
   surfaces different ones (**LLM names the layers; nothing is hardcoded**, so the
   engine stays repo-agnostic) — then hunt each layer for behaviors whose
   consequence is real downstream harm. Each finding is **tagged with its layer**,
   and *advisorily* with **not-in-description** when the PR body didn't claim it.
   Harm classes above are prompt priorities. The layer split is an *instruction
   inside the finder prompt*, **not** a separate agent pass — so pass count is
   unchanged from today's finder→confirmer.
2. **Confirmer verifies facts, never intent.** A Blind spot decomposes into two
   *grounded facts* + one *open question*: **(fact)** the code does X at
   `file:line` — **(fact)** X has downstream consequence Y — **(question)** did
   you intend X? The confirmer applies the existing cited-proof discipline to the
   **facts only** (both need a `file:line`; unproven facts get killed). It
   **never adjudicates intent** — intent lives in the author's head, not the
   checkout, so the panel surfaces it as a *question* ("…counts views after the
   API returns, not on tap. Intended?"), never a verdict ("your metric is
   wrong"). The `inDescription` flag is one input to whether the question is worth
   asking.

**Every Blind spot carries a why-it-matters chain.** Not a bare flag — a short
grounded chain of reasoning (code fact → consequence → why that consequence
matters) that lets the author *understand the stakes*, then decide. The value is
not just intent-alignment; it's that the alignment is **worth the author's
attention**.

**Materiality bar — a two-part test, not an adjective.** "Material logic drift,
not nits" is too mushy for a prompt (every finding thinks it's material). The
sharp, confirmer-checkable gate a finding must pass **both** parts of:

1. **Invisible at PR time** — the harm is *not* caught by CI or by reading this
   diff (a green build and a right-looking diff still ship it). This excludes
   nits (a type-cast/style issue is *visible right there* → fails part 1) and
   CI-catchable bugs (the gate already handles those → fails part 1).
2. **Manifests away from the change** — the harm surfaces somewhere the author
   isn't looking: a dashboard, an experiment readout, a downstream data consumer,
   or a different code path — days/weeks later. This is the **drift-to-a-distance**
   signature that excludes "this line is ugly" (no downstream manifestation).

Enforced in *both* the finder prompt (don't raise it) and the confirmer (dismiss
it if raised) — the confirmer's kill criteria become "fact unproven **or** fails
either part of the two-part test."

**Scope boundary (8b): drift-to-a-distance only.** A plain in-diff logic bug that
CI wouldn't catch (an off-by-one in the changed function itself) is *invisible*
(part 1) but *manifests in the change* (fails part 2) — so it is **out of scope**
for Blind spots. Other review bots and the reviewer-risk path cover in-diff bugs;
Blind spots stay narrowly about drift that **escapes to a distance**. Don't widen
the finder to general bug-hunting — that dilutes the signal this tool exists for.

> **Deferred: per-layer fan-out.** Fanning the finder out into one focused pass
> *per* layer (1 + N + N passes) would raise recall on huge diffs but is a real
> cost/latency multiplier. Not bought up front — ship the single-pass split,
> look at real Blind-spot output on a www analytics PR, and only fan out per
> layer (adaptively, gated on diff size / layer count) if a single-context
> finder is shown to miss blind spots it should have caught.

**Wiring.** The core change is running `risks.ts` for **author** PRs, not just
reviewer (today gated at `overview.ts:299`). Reuse `risks_json` / `risks_status`
and `RisksPanel` (no new artifact). Findings carry their derived-layer tag so the
panel groups by layer; add a "not in your description" signal on the `RiskItem`.
Confirm `RisksPanel` copy reads in the author voice.

**Worktree key: shared `-pr.number`, serialized (decided).** Blind spots are a
*PR-level* artifact, same category as overview/risks, so they take the same
negative worktree key `-pr.number` (`overview.ts:233`). The negation partitions
one integer keyspace: thread worktrees are `+id` (the executor's fix path),
PR-level artifact worktrees are `-pr.number` — disjoint, so a Blind-spot checkout
can never collide with (and wipe, per the wipe-first contract at
`worktrees.ts:164`) a live thread's worktree, and the restart sweep
(`sweepWorktrees`, `worktrees.ts:289`) always garbage-collects it since a negative
key is never a live thread id. Read-only, so `skipDeps: true` (no `node_modules`
provisioning at all). Because overview and Blind spots share the single-occupancy
`-pr.number` folder, they must run through the **same `inFlight` guard +
`repoQueue`** (`overview.ts:424`) — serialized, one detached checkout at a time.
Rejected: a distinct offset key (e.g. `-pr.number - 1_000_000`) to allow
concurrent checkouts — it buys concurrency nobody needs (the user isn't watching
both panels generate at once) at the cost of a duplicate checkout + duplicate lazy
blob fetches. Switchable later with zero schema change (it's an in-memory arg).

**Blind spots replace the inline `## Risks` prose on author PRs** (not coexist).
Today the overview pass emits an ungrounded inline `## Risks` section for authors
(per `CONTEXT.md`). The structured Blind-spot panel becomes the *single* author
risk surface — so the overview prompt must **stop emitting the author `## Risks`
section**. This is a small prompt edit to the overview pass, i.e. Phase 2 is
*not* purely "run risks.ts for authors" — it also touches `overview.ts`'s
author-branch prompt. Call this out so the change isn't mistaken for wiring-only.

**Panel placement: appended collapsible section (decided).** Author PRs render
the babysitter's **thread UI** (the write surface — verdicts/proposals/Approve);
the Blind-spot panel is a *third* surface that must coexist with it without
disturbing it. Render `RisksPanel` as a **collapsible section below the thread UI**
in the same scrolling pane — matching how `RisksPanel` already nests inside
`OverviewPanel`. No new tab component (App has none today; `OverviewPanel` is
embedded directly, and `App.tsx` renders `ThreadDetailView` *or* `OverviewPanel`
mutually exclusively). Rejected: a Threads|Blind-spots tab (builds infra we don't
need yet) and routing author PRs through `OverviewPanel` (drags the reviewer
learning corpus onto author PRs). Revisit tabs in Phase 4 only if the pane feels
cramped.

- **Milestone:** open my PR → risks panel surfaces layer-tagged blind spots
  (e.g. "experiment: exposure logged in `render` before gate check —
  `foo.tsx:88` — pollutes unenrolled users") with cited proof.

> Reviewer logic-blindness (the original Phase 2: edge cases, flipped defaults,
> callers assuming old behavior) is the *same engine without the layer-split and
> PR-body framing* — it falls out for free once the finder prompt is broadened.
> Keep it, but the author path above is the primary target.

**Deferred: Adjacent suggestions (a separate class, not v1).** A *generative*
counterpart to the defensive Blind spot — "while you're already touching this
analytics event, you could log field Z too." Named now (see `CONTEXT.md`
**Adjacent suggestion**) so the concept is pinned, but **not built in Phase 2**.
It is deliberately a **separate class** from Blind spots for three reasons:
(1) it fails the Blind-spot two-part test — an absent good has no at-a-distance
*harm*, so the confirmer would kill every one; (2) a suggestion has no disprovable
`file:line` fact for the confirmer to verify; (3) "suggest improvements" is the
highest-noise instruction an LLM can be given. Its own bar replaces the two-part
test: **genuinely adjacent** (enabled by *this* diff, not general "code could be
better") **and cheap relative to payoff**. Build it only after the defensive
harm-hunt earns trust — don't let it bloat the MVP.

### Phase 3 — Per-thread author digest (author) — secondary, lighter pipeline
- New `digest.ts`: for an author PR, iterate `collectFeedback()` threads; for
  each, one `refine.ts`-style Bedrock call producing cited markdown ("what's
  asked, where"). Grounded via permalinks already in `FeedbackItem`; a worktree
  is optional (only if we want to cite current code, not just the comment).
- Persist per-thread `digest_md`/`digest_status`; emit `pr_digest_updated`.
- Web: a compact digest list on author PRs (no heavy panels).
- **Milestone:** open my PR → see a per-thread feedback digest.

### Phase 4 — Role-gated UI consolidation + polish
- Ensure the reviewer PR view shows all five learning artifacts
  (overview/diagrams/quiz/mindmap/blind-spots) and the author PR view shows the
  babysitter's existing thread UI **plus** the author blind-spot panel (primary)
  and the lightweight digest (secondary) — cleanly gated by `role`, without
  disturbing the existing thread-detail write surface.
- Staleness: verify all new artifacts invalidate on head-sha change like
  overview/quiz do — including author Blind spots via the new `risks_head_sha`
  (stale-marked on head move, regenerated on demand when the panel is opened).

---

## Open questions / to confirm in-code before each phase
1. Exact table for the author per-thread digest (`threads` vs `thread_items` vs
   `feedback`) — confirm in Phase 3.
2. Whether the author digest needs a worktree at all (cite code vs cite comment
   only). Default: no worktree, comment-grounded, add worktree only if needed.
3. Mindmap grounding depth — reuse overview's blast-radius grep, or lighter.
4. Linked-issue ingestion (`closingIssuesReferences`) — only if the mindmap/
   overview intent section needs it; not required for v1.
5. **Generation trigger — on-demand first (decided).** Author Blind spots are
   generated **on-demand** (`POST`, same in-flight guard as overview), not at poll
   time, for v1. Rationale: a push system that fires low-quality notifications is
   *worse* than none — it trains the owner to dismiss. Prove finding quality
   pull-based first. **Design the trigger so poll-time push is a config flag away**
   later: gate poll-time generation to once per head-sha (the `risks_head_sha`
   column from the data model is exactly what keeps it from re-burning on every
   push — author branches move constantly) and notify only on a *confirmed
   high-severity* Blind spot (reuse the coalesced-per-PR notify path). Known
   tradeoff accepted for v1: the busy author must remember to open the panel; the
   push path is the answer once output is trusted.
6. Layer tags — a free-form string per finding, or a small controlled vocab the
   finder is nudged toward? Default: free-form (repo-agnostic), panel groups by
   whatever strings come back. Revisit only if per-layer fan-out is later added.
7. `RisksPanel` copy in the author voice ("blind spots in your change" vs
   reviewer "risks to review") — confirm labels read correctly for both roles.
