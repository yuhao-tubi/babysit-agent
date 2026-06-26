# Domain glossary — PR Babysitting Agent

Ubiquitous language for this project. Glossary only — no implementation detail.

- **Poll cycle** — one pass of the daemon: discover the PRs you authored (skipping `ignoreRepos`), fetch all their feedback grouped by thread, and upsert a Thread-unit for every thread with actionable, non-resolved feedback. Idempotent: unit existence is derived from live GitHub state each poll, not from first-sight.

- **Session** — a PR and all its Threads. The PR-level grouping for triage and the dashboard; it is *not* itself a status-bearing unit (its status is rolled up from its Threads). Discovered PRs in `ignoreRepos` (e.g. `adRise/chatgpt-app`) are skipped entirely.

- **Thread** — the unit of triage and the decision unit. One per `(PR, threadKey)`: an inline review-comment thread (root + replies), a review summary body, or a standalone issue-tab comment. A Thread carries one Verdict, one Pre-push gate run, and the thread-attempt loop guard, and moves through a status lifecycle. A Thread GitHub-marked **resolved** is never acted on — skipped at both creation and just-before-action.

- **Feedback item** — a single comment belonging to a Thread: an inline review comment, a review summary body, or an issue-tab comment.

- **Author class** — `bot` or `human`, determined deterministically from the GitHub user type and a configurable login list, fixed to the Thread's **root** comment author. Drives the reply policy.

- **Verdict** — the agent's categorical decision for a Thread: `auto_fix`, `reply`, or `escalate`. There is no numeric confidence; routing is the verdict plus the objective gate result.

- **Pre-push gate** — the objective self-verification a fix must pass before any push: the repo's build/test, or a repo-type validator when there is no test suite.

- **Escalation** — a Thread that needs your judgment. It is marked **blocked**, fires a notification (coalesced per PR — one banner deep-linking to the PR, reflecting how many Threads need you), and waits for your Instruction.

- **Instruction** — your freeform input on a blocked Thread from the dashboard. The executor re-runs and acts on it (make a fix, post a specific reply, or ignore).

- **Thread attempt** — the count of autonomous fixes already pushed for a Thread. Bounds the fix↔re-review loop: after the configured maximum, the next round escalates instead of fixing.

## Status lifecycle

`pending` → `in_progress` → (`resolved` | `blocked` | `error`)

A **blocked** Thread waits for an Instruction and survives daemon restarts. New activity on a `resolved` or `error` Thread re-opens it to `pending` (subject to the thread-attempt loop guard, which escalates to `blocked` once the max is reached). New activity on a `blocked`/`pending`/`in_progress` Thread just attaches the new items — it doesn't reset state. A Thread GitHub-marked resolved is moved to `resolved` and skipped.
