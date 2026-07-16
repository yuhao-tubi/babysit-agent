// Domain types — see CONTEXT.md glossary.

export type AuthorClass = "bot" | "human" | "ci";

/**
 * Verdict actions. A code change is ALWAYS a `propose` (never an autonomous
 * push) — it is built, gate-verified, and parked at `awaiting_approval` for the
 * owner to Approve. `escalate` now means a DECISION is needed (no diff to
 * approve, optionally with `options`). `amend_pr_body` is the PR-description
 * flavor of a proposal; it parks at `awaiting_approval` like `propose` and is
 * applied only on Approve.
 */
export type VerdictAction = "propose" | "reply" | "escalate" | "amend_pr_body";

/**
 * Gate class for a CI failure — selects which local check the pre-push gate must
 * run to self-verify a CI fix. Derived from the failing check's name via the
 * configured allowlist. `unit_test` additionally consults `ci_test_target`.
 */
export type CiClass = "lint" | "typecheck" | "build" | "unit_test";

/** The 4W1H sections a PR-overview diagram canvas can belong to. */
export type DiagramSection = "why" | "what" | "how";

/**
 * A raw Excalidraw document — the `.excalidraw` file shape (`type:"excalidraw"`,
 * `elements`, `appState`, `files`). The overview agent AUTHORS these directly
 * (coordinates and all), self-correcting via the render loop; the dashboard
 * mounts them in an editable `@excalidraw/excalidraw` canvas. We keep it loosely
 * typed — the durable truth is whatever Excalidraw reads/writes, and we only
 * validate the wrapper (`type` + non-empty `elements`) before persisting.
 */
export interface ExcalidrawDoc {
  type: "excalidraw";
  version?: number;
  source?: string;
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

/**
 * The PR-overview diagram artifact: up to one editable Excalidraw canvas per
 * 4W1H section. Replaces the old abstract React-Flow `DiagramSpec[]`. A section
 * is present only if the agent produced (and the render loop validated) a canvas
 * for it; a trivial PR can have an empty map.
 */
export type DiagramSet = Partial<Record<DiagramSection, ExcalidrawDoc>>;

/** Severity vocabulary for a Risk — reuses the Verdict `risk` levels. */
export type RiskLevel = "low" | "medium" | "high";

/**
 * A candidate risk the FINDER pass produces for a reviewer-role PR (see
 * CONTEXT.md). Grounded: `location` cites real lines and a PR-head permalink;
 * `codeSnippet` is the illustrative diff hunk (preferred) or plain code; the
 * optional `mermaid` chart is authored only when the risk earns one. The
 * verdict is added later by the merge with the confirmer's records.
 */
export interface RiskCandidate {
  /** Finder-generated, unique within one run's risks.json. */
  id: string;
  title: string;
  level: RiskLevel;
  category?: string;
  location: { path: string; startLine: number; endLine?: number; permalink: string };
  /** Markdown prose: what the risk is and why it matters. */
  explanation: string;
  /** A fenced ```diff hunk (preferred) or plain code illustrating the risk. */
  codeSnippet: string;
  /** Optional mermaid source; rendered client-side. Omitted for trivial risks. */
  mermaid?: string;
}

/**
 * A verdict-only record the CONFIRMER pass produces, keyed by the finder's risk
 * `id`. The confirmer never re-authors the heavy content — it only judges
 * (`confirmed`), may adjust `level`, and cites its `rationale`. The server
 * merges these onto the finder's candidates by id.
 */
export interface RiskVerdictRecord {
  id: string;
  confirmed: boolean;
  level?: RiskLevel;
  rationale: string;
}

/**
 * How a merged Risk stands after confirmation: `confirmed` (skeptic agreed it is
 * real), `dismissed` (skeptic rejected it as a false positive, rationale kept),
 * or `unverified` (no confirmer record matched — shown honestly, not dropped and
 * not auto-confirmed).
 */
export type RiskState = "confirmed" | "dismissed" | "unverified";

/** A finder candidate merged with the confirmer's judgment — the display unit. */
export interface RiskItem extends RiskCandidate {
  state: RiskState;
  verdict?: { confirmed: boolean; rationale: string };
}

/**
 * One multiple-choice PR-comprehension question. Authored by the quiz agent from
 * a grounded read of the diff/checkout: `options` are 2–4 answers, `correctIndex`
 * points at the right one, and `explanation` is the teaching moment shown after
 * the owner answers (why the answer is right, citing the change). Wrong options
 * are drawn from the OLD behavior or plausible misreadings.
 */
export interface QuizQuestion {
  question: string;
  options: string[];
  /** 0-based index into `options` of the correct answer. */
  correctIndex: number;
  explanation: string;
}

export type ThreadStatus =
  | "pending"
  | "in_progress"
  | "resolved"
  | "blocked"
  | "awaiting_approval"
  | "error";

/** A single GitHub comment belonging to a Thread. */
export interface FeedbackItem {
  /** GitHub id of the comment (review-comment id, review id, or issue-comment id). */
  ghId: number;
  /** Which GitHub surface this came from. `ci_failure` is synthesized from a failing check. */
  kind: "review_comment" | "review_summary" | "issue_comment" | "ci_failure";
  author: string;
  authorType: string; // raw GitHub user.type
  body: string;
  /** File path for inline review comments. */
  path?: string | null;
  /** Diff line for inline review comments. */
  line?: number | null;
  htmlUrl?: string | null;
  createdAt: string;
  /** Thread key for loop-guard: review-comment thread root or issue-comment id. */
  threadKey: string;
  /** For `ci_failure`: the GitHub check name (e.g. "lint"). */
  checkName?: string;
  /** For `ci_failure`: gate class derived from the check name. */
  ciClass?: CiClass;
}

/** A discovered pull request. */
export interface Pr {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  headRefName: string;
  /** Branch the PR head was at when last polled (sha). */
  headSha?: string;
}

/** The agent's structured verdict for a Thread. */
export interface Verdict {
  action: VerdictAction;
  /** One-line summary of the decision/reasoning. */
  summary: string;
  /** Proposed reply text (used for `reply`, or the acknowledgement after a fix). */
  reply_draft: string;
  /** Risk level; `high` keeps the proposal but vetoes any autonomous push. */
  risk: "low" | "medium" | "high";
  /**
   * For `escalate` (decision needed): suggested choices the owner can pick from.
   * Each option is a one-click instruction-prefill — selecting it just seeds the
   * instruction box; it does not run the agent on its own.
   */
  options?: string[];
  /**
   * For `amend_pr_body`: the full rewritten PR description the agent proposes.
   * Never applied autonomously — it is drafted, the Thread is escalated, and the
   * PR owner approves it with an `apply` instruction from the dashboard.
   */
  proposed_body?: string;
  /** For `amend_pr_body`: a unified-style old→new diff of the PR body, for display. */
  body_diff?: string;
  /**
   * For CI unit-test fixes: the failing test the gate should run to self-verify.
   * The gate runs this target; on a missing/empty/zero-match target it falls back
   * to the whole suite. Optional — absent for non-test CI classes.
   */
  ci_test_target?: { file: string; nameFilter?: string };
}

/**
 * A frozen, owner-reviewable proposal parked on an `awaiting_approval` thread.
 * It is the durable truth for that state — recovery re-renders it and never
 * re-runs the verdict. Approve acts on exactly these bytes (WYSIWYG).
 *
 * A proposal can carry up to two INDEPENDENTLY-approvable parts: a **change**
 * (code diff or PR-description rewrite) and a **reply** (`replyDraft`). The owner
 * approves them separately — pushing the code does not post the reply, and vice
 * versa. The Thread resolves only once the change is applied (or there is none)
 * AND the reply is posted or dismissed. `changeApplied`/`replyPosted`/
 * `replyDismissed` track that progress and survive restarts in the frozen JSON.
 */
export interface Proposal {
  /**
   * `code` = a git diff to push; `pr_body` = a PR-description rewrite;
   * `reply` = a reply-only proposal (no change — a drafted comment to post);
   * `manual_plan` = a copy-paste handoff the owner runs in Claude Code by hand
   * (used when the change is too large for the fix agent's turn budget). A
   * `manual_plan` is NOT approvable — it parks the Thread at `blocked` and is
   * never pushed by the daemon.
   */
  kind: "code" | "pr_body" | "reply" | "manual_plan";
  /**
   * Human-readable plan/rationale shown above the diff. For `manual_plan` this
   * is the full self-contained prompt the owner pastes into Claude Code.
   */
  planMarkdown: string;
  /** Base sha the proposal was built+gated against (for the "advanced X→Y" hint). */
  baseSha: string;
  /** Whether the build-time gate passed (proposals are only parked when it did). */
  gatePassed: boolean;
  /**
   * Set when the gate did NOT pass cleanly, but every failure was in files the
   * fix did not touch (pre-existing/unrelated errors — e.g. a dirty monorepo
   * baseline). The proposal is still parked for the owner: Approve is an informed
   * override of the inconclusive gate. Never auto-pushed (see `mayAutoPush`).
   */
  gateInconclusive?: boolean;
  /** For `code`: the unified git diff to apply+push. */
  diff?: string;
  /** For `pr_body`: the full rewritten PR description to apply via `gh pr edit`. */
  proposedBody?: string;
  /** For `pr_body`: a display old→new diff of the description. */
  bodyDiff?: string;
  /** For `pr_body`: snapshot of the description at draft time (concurrency hook). */
  baseBody?: string;
  /**
   * The reply to post — the acknowledgement after a change, or the whole point
   * of a `reply`-kind proposal. Empty/absent means there is no reply part.
   */
  replyDraft?: string;
  /** Set once the change part (code push / pr_body edit) has been applied. */
  changeApplied?: boolean;
  /** Set once the reply has been posted to GitHub. */
  replyPosted?: boolean;
  /** Set once the owner dismissed the drafted reply without posting it. */
  replyDismissed?: boolean;
}

/** A single commit that landed on the PR branch after a Thread stalled. */
export interface BranchCommit {
  sha: string;
  message: string; // first line of the commit message
  author: string;
  url?: string;
  committedAt?: string;
}

/**
 * Commits pushed to the PR branch while a Thread sat in a WAITING state
 * (`blocked` / `awaiting_approval` / `error`) — surfaced under Feedback as a
 * "branch advanced" marker so the owner sees a fix may already have landed. It
 * never re-opens the Thread (blocked stays frozen until you act); it is cleared
 * the moment the Thread is re-worked or resolved. `base` is the head snapshotted
 * when the Thread first entered its waiting state; `head` is the current head.
 */
export interface BranchAdvance {
  base: string;
  head: string;
  commits: BranchCommit[];
}

/** A thread-unit: the decision unit. One per (prKey, threadKey). */
export interface ThreadRow {
  id: number;
  prKey: string; // owner/repo#number
  owner: string;
  repo: string;
  number: number;
  reviewId: number | null; // provenance for review-summary threads
  threadKey: string;
  authorClass: AuthorClass;
  status: ThreadStatus;
  verdictJson: string | null;
  replyDraft: string | null;
  /** Forensic record of the last diff actually applied/pushed (the "Applied diff"). */
  diff: string | null;
  /** Frozen Proposal (JSON) backing an `awaiting_approval` thread; null otherwise. */
  proposalJson: string | null;
  /** Commits pushed to the branch while this Thread was waiting (JSON BranchAdvance); null otherwise. */
  newCommitsJson: string | null;
  attemptCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
