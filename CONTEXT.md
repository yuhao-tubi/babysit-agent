# Domain glossary — PR Babysitting Agent

Ubiquitous language for this project. Glossary only — no implementation detail.

- **Poll cycle** — one pass of the daemon: discover the PRs you authored (skipping `ignoreRepos`), fetch all their feedback grouped by thread, and upsert a Thread-unit for every thread with actionable, non-resolved feedback. Idempotent: unit existence is derived from live GitHub state each poll, not from first-sight.

- **Session** — a PR and all its Threads. The PR-level grouping for triage and the dashboard; it is *not* itself a status-bearing unit (its status is rolled up from its Threads). Discovered PRs in `ignoreRepos` (e.g. `adRise/chatgpt-app`) are skipped entirely.

- **Expired Session** — a Session whose PR has merged or closed (fallen out of the live open set the poll cycle observes). It is *retained*, not deleted: its Threads and history stay queryable and it is surfaced in the dashboard's own **Expired** section. The pipeline never acts on an expired Session's Threads. Re-appearing in the open set un-expires it.

- **Thread** — the unit of triage and the decision unit. One per `(PR, threadKey)`: an inline review-comment thread (root + replies), a review summary body, or a standalone issue-tab comment. A Thread carries one Verdict, one Pre-push gate run, and the thread-attempt loop guard, and moves through a status lifecycle. A Thread GitHub-marked **resolved** is never acted on — skipped at both creation and just-before-action.

- **Feedback item** — a single comment belonging to a Thread: an inline review comment, a review summary body, or an issue-tab comment.

- **Author class** — `bot` or `human`, determined deterministically from the GitHub user type and a configurable login list, fixed to the Thread's **root** comment author. Drives the reply policy.

- **Verdict** — the agent's categorical decision for a Thread: `propose`, `reply`, `escalate`, or `amend_pr_body`. There is no numeric confidence; routing is the verdict plus the objective gate result. `propose` (a code change), `amend_pr_body` (a description change), and `reply` (a comment to post) all yield a **Proposal**; `escalate` means a decision is needed and carries no diff (it may list **options**). No GitHub write — push *or* reply — happens without an explicit **Approve** (except `autoPushClasses`).

- **Proposal** — a frozen, owner-reviewable artifact parked on an Awaiting-approval Thread. It can carry up to two **independently-approvable parts**: a **change** (a gate-passed code diff built against a recorded `baseSha`, or a rewritten PR description) and a **reply** (a drafted comment to post). The owner approves them separately — pushing the code does not post the reply, and vice versa; either part can be approved, and the reply can be copied-out to refine by hand or dismissed. A `reply`-kind Proposal carries only the reply part. It is the durable truth for the Awaiting-approval state — restart recovery re-renders it and never re-runs the verdict. **Approve** acts on exactly these bytes. Approving **either** part (the change is applied, **or** the reply is posted) resolves the Thread — the owner has acted, so it no longer blocks on the other part; the un-acted part stays approvable (the frozen Proposal is kept until both parts are settled — applied/posted or dismissed/absent). A further kind, **Manual plan**, is not approvable.

- **Manual plan** — the fallback when a `propose` change is too large to apply within the fix agent's turn budget (the agent hits its max-turns cap). Instead of erroring the Thread, a read-only planning pass runs in the same worktree and emits a self-contained implementation brief; it is parked as a `manual_plan` Proposal and the Thread is marked **blocked**. The daemon **never pushes** a manual plan — the owner copies the brief from the dashboard and runs it in Claude Code on the PR branch by hand. Like any Proposal it survives restarts; **Approve** is a no-op for it.

- **Approve** — the owner's one-click acceptance of a Proposal part, and the **sole write path**. Approving the **change**: for a code Proposal, re-check the frozen diff still applies to the current HEAD, re-run the gate, then fast-forward push the exact reviewed bytes; for a description Proposal, `gh pr edit --body`. Approving the **reply** posts the drafted comment. The two are approved independently and neither implies the other. Nothing else pushes or comments on a PR (except the verbatim **Reply on GitHub** escape hatch, and classes opted into `autoPushClasses`, which auto-push and self-ack).

- **Options** — for an `escalate` Verdict, the concrete choices the agent sees. In the dashboard they are clickable chips that pre-fill the Instruction box; selecting one does not run the agent by itself.

- **Pre-push gate** — the objective self-verification a change must pass: the repo's build/test, or a repo-type validator when there is no test suite. Run when a Proposal is built, and again at Approve time against the current HEAD.

- **Escalation** — a Thread that needs your judgment (a decision, not a change). It is marked **blocked**, fires a notification (coalesced per PR), and waits for your Instruction.

- **Instruction** — your freeform input on a blocked / awaiting-approval Thread from the dashboard. A freeform Instruction always **re-proposes** (builds a fresh Proposal to review — it never pushes); `reply:` parks that text as a **reply Proposal** you review and post (it does not post directly — that is the verbatim **Reply on GitHub** button's job); `ignore` drops it. The box has an **AI refine** helper — a one-shot direct Claude rewrite of the box text (apply a note like "make it firmer"), not an agent run; the refined text returns to the box for you to edit and submit.

- **Thread attempt** — the count of autonomous (auto-pushed) fixes already pushed for a Thread. Bounds the fix↔re-review loop for `autoPushClasses`: after the configured maximum, the next round escalates instead of fixing. Owner-approved pushes are the owner's call and aren't loop-limited.

- **Auto-push classes** — `autoPushClasses` config: author classes (`ci`/`bot`/`human`) allowed to push without owner approval when the gate passes. Default `[]` — everything parks for Approve. `risk:"high"` always vetoes auto-push regardless.

- **Branch advanced** — an annotation on a **waiting** Thread (`blocked` / `awaiting_approval` / `error`) listing the commits pushed to the PR branch after the Thread stalled. A branch push never re-opens a frozen Thread (that invariant stands), but the owner may have landed the fix by hand; the poller snapshots the head when a Thread first enters a waiting state and, once the head moves past it, records the new commits (shown under Feedback in the dashboard). It never changes status — the owner still resolves/acts. Cleared automatically the moment the Thread is re-worked or resolved.

- **Verified risk analysis** — a reviewer-role-only artifact produced by the **same** on-demand Generate run as the PR overview, in the shared read-only worktree, right after the overview (fed it as context). Two sequential read-only agent passes: a **finder** surfaces the handful of grounded risks a reviewer must scrutinize (each with a severity `level`, a cited `file:line` permalink, an illustrative diff hunk, and an optional mermaid chart) into `overview/risks.json`; an adversarial **confirmer** re-investigates each and writes verdict-only records (`confirmed`, optional `level` override, cited `rationale`) into `overview/risks-confirmed.json`. The server merges them by `id`: a match becomes **confirmed** or **dismissed**; a finder risk with no matching record is shown **unverified** (never silently dropped); an orphan confirmer id is ignored. Its status (`ready`/`failed`) is **independent** of the overview's — a failed risk stage never blanks a ready overview, and a confirmer failure degrades to all-unverified/`ready`. It performs NO GitHub writes (`dryRun` does not gate it) and is reviewer-only (authored PRs keep the overview's inline `## Risks` prose instead).

## Status lifecycle

`pending` → `in_progress` → (`resolved` | `blocked` | `awaiting_approval` | `error`)

A **blocked** Thread (a decision is needed) waits for an Instruction. An **awaiting_approval** Thread holds a frozen Proposal and waits for Approve (or a revising Instruction); both survive daemon restarts. New activity on a `resolved` or `error` Thread re-opens it to `pending` for a **fresh** Verdict (subject to the thread-attempt loop guard) — but activity authored by you (`@me`), including the agent's own ack replies, never counts as new activity. New activity on a `blocked`/`awaiting_approval`/`pending`/`in_progress` Thread just attaches the new items — it doesn't reset state. A Thread GitHub-marked resolved is moved to `resolved` (dropping any Proposal) and skipped.

Restart recovery is keyed on the most durable artifact, never on replaying a stored Verdict decision: an interrupted Approve re-applies the frozen Proposal; an interrupted Instruction re-proposes; a Thread with a frozen Proposal re-applies it; otherwise the Verdict pipeline re-runs from `pending`. An `awaiting_approval` Thread is left untouched — its Proposal is the durable truth.
