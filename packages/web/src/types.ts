export type ThreadStatus =
  | "pending"
  | "in_progress"
  | "resolved"
  | "blocked"
  | "awaiting_approval"
  | "error";

/** A thread-unit as summarized under its PR. */
export interface ThreadSummary {
  id: number;
  status: ThreadStatus;
  authorClass: "bot" | "human" | "ci";
  threadKey: string;
  action: string | null;
  summary: string | null;
  updatedAt: string;
  /**
   * A job is EXECUTING for this Thread right now. Distinct from
   * `status === "in_progress"`, which also covers a claimed Thread still waiting
   * its turn on the per-repo queue — so this is the only honest input for a
   * "Running" indicator.
   */
  running: boolean;
}

/**
 * GitHub's own review decision for a PR (null = none required/unknown). There is
 * deliberately no "N of M approvals": the required count lives in branch
 * protection, which the `gh` token cannot read — see CONTEXT.md.
 */
export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

/** Failing/pending checks for a PR head, as of the last poll. */
export interface ChecksSummary {
  /** Names of checks that completed in a failure — shown in the badge tooltip. */
  failing: string[];
  /** Checks still queued or running. */
  pending: number;
  total: number;
}

/**
 * A PR's position in its Stack — a chain of PRs where each one's base branch is
 * the PR below it's head branch. Absent (null) for a standalone PR.
 */
export interface StackInfo {
  /** prKey of the bottom PR — the group identity the sidebar groups on. */
  rootKey: string;
  /** Base branch the bottom of the chain targets (e.g. "master"). */
  rootBaseRef: string;
  /** 1-based distance from the bottom: the `L1`/`L2`/`L3` label. */
  depth: number;
  /** Position in the chain's depth-first walk — the render order. */
  order: number;
  parentPrKey: string | null;
}

/** A PR (the "Session") and its threads. */
export interface PrGroup {
  prKey: string;
  title: string;
  url: string;
  /** "author" = you wrote it (full pipeline); "reviewer" = overview-only. */
  role: "author" | "reviewer";
  status: ThreadStatus;
  counts: { blocked: number; awaiting: number; ongoing: number; resolved: number };
  threads: ThreadSummary[];
  lastPolled: string | null;
  /** Set when the PR merged/closed since last poll; null while open. Expired PRs
   *  are retained (read-only history) and shown in their own dashboard section. */
  expiredAt: string | null;
  /** Base branch of the PR (null on rows polled before it was recorded). */
  baseRef: string | null;
  /** Login that opened the PR — rendered on reviewer rows ("whose PR is this").
   *  Null on rows last polled before it was recorded. */
  author: string | null;
  reviewDecision: ReviewDecision | null;
  /** People whose latest review is an approval. */
  approvalCount: number;
  /** Null when checks were never observed for this head. */
  checks: ChecksSummary | null;
  /** Position in its PR Stack; null when the PR stands alone. */
  stack: StackInfo | null;
}

export type OverviewStatus = "idle" | "generating" | "ready" | "failed";

/** The 4W1H sections a diagram can belong to. */
export type DiagramSection = "why" | "what" | "how";

/** A PR-overview diagram: a single sanitized, self-contained `<svg>` string the
 *  agent authored in one pass. Rendered inline read-only (see issue #1). */
export interface DiagramDoc {
  svg: string;
}

/** The diagram set: up to one read-only SVG diagram per 4W1H section. */
export type DiagramSet = Partial<Record<DiagramSection, DiagramDoc>>;

export type QuizStatus = "generating" | "ready" | "failed";

/** One multiple-choice PR-comprehension question (graded client-side). */
export interface QuizQuestion {
  question: string;
  options: string[];
  /** 0-based index into `options` of the correct answer. */
  correctIndex: number;
  explanation: string;
}

export type RiskLevel = "low" | "medium" | "high";
export type RiskState = "confirmed" | "dismissed" | "unverified";
// `generating` is used only by author Blind spots (an on-demand artifact like the
// quiz); reviewer risks only ever land `ready`/`failed`.
export type RiskStatus = "generating" | "ready" | "failed";

/**
 * A merged, display-ready risk: a reviewer Verified risk OR an author Blind spot
 * (same shape; role drives the framing). `layer`/`inDescription` are set only for
 * author Blind spots (see CONTEXT.md).
 */
export interface RiskItem {
  id: string;
  title: string;
  level: RiskLevel;
  category?: string;
  /** Author Blind spots: the LLM-derived layer (e.g. "analytics"). Absent for reviewer risks. */
  layer?: string;
  /** Author Blind spots (advisory): false when the PR description didn't claim this behavior. */
  inDescription?: boolean;
  location: { path: string; startLine: number; endLine?: number; permalink: string };
  explanation: string;
  codeSnippet: string;
  mermaid?: string;
  state: RiskState;
  verdict?: { confirmed: boolean; rationale: string };
}

/** PR-level overview + diagram-set artifact (a Session-level artifact). */
export interface PrOverview {
  prKey: string;
  title: string;
  url: string;
  role: "author" | "reviewer";
  status: OverviewStatus;
  overviewMd: string | null;
  diagrams: DiagramSet;
  overviewHeadSha: string | null;
  currentHeadSha: string | null;
  generatedAt: string | null;
  stale: boolean;
  /**
   * Risk analysis — reviewer Verified risks or author Blind spots. Withheld ([])
   * while generating and when stale (author head moved).
   */
  risks: RiskItem[];
  /** `generating`|`ready`|`failed`|null (never run). */
  risksStatus: RiskStatus | null;
  /** True when the author Blind spots' head has moved (Regenerate). Always false for reviewer risks. */
  risksStale: boolean;
  /** PR-comprehension quiz — questions ([] when generating/failed/stale). */
  quiz: QuizQuestion[];
  /** `generating`|`ready`|`failed`|null (never run). */
  quizStatus: QuizStatus | null;
  /** True when the quiz's head has moved (auto-invalidated — Regenerate). */
  quizStale: boolean;
}

export interface FeedbackItem {
  ghId: number;
  kind: string;
  author: string;
  authorType: string;
  body: string;
  path?: string | null;
  line?: number | null;
  htmlUrl?: string | null;
  createdAt: string;
}

export interface Verdict {
  action: string;
  summary: string;
  reply_draft: string;
  risk: string;
  options?: string[];
  proposed_body?: string;
  body_diff?: string;
}

/** A frozen, owner-reviewable proposal backing an awaiting_approval thread. */
export interface Proposal {
  kind: "code" | "pr_body" | "reply" | "manual_plan";
  planMarkdown: string;
  baseSha: string;
  gatePassed: boolean;
  /** Gate failed only on files the fix didn't touch; Approve is an informed override. */
  gateInconclusive?: boolean;
  diff?: string;
  proposedBody?: string;
  bodyDiff?: string;
  baseBody?: string;
  replyDraft?: string;
  changeApplied?: boolean;
  replyPosted?: boolean;
  replyDismissed?: boolean;
}

/** A commit pushed to the PR branch while a Thread was waiting. */
export interface BranchCommit {
  sha: string;
  message: string;
  author: string;
  url?: string;
  committedAt?: string;
}

/** Commits pushed to the branch while a Thread sat in a waiting state. */
export interface BranchAdvance {
  base: string;
  head: string;
  commits: BranchCommit[];
}

export interface ThreadDetail {
  id: number;
  prKey: string;
  /** The PR's title — the page leads with this, keeping `prKey` as the subtitle. */
  prTitle: string | null;
  /** Where this PR sits in its Stack; null when standalone. */
  stack: StackInfo | null;
  status: ThreadStatus;
  /**
   * A job is EXECUTING for this Thread right now. `status === "in_progress"` also
   * covers a claimed Thread still queued behind other work on the same repo, so
   * this is what any "working on it" indicator must key off.
   */
  running: boolean;
  /**
   * A text Revision (reply draft / PR description) is running. Separate from
   * `running`: it holds no run claim and leaves the Thread's status alone, so the
   * frozen Proposal stays approvable while it works.
   */
  revising: boolean;
  authorClass: "bot" | "human" | "ci";
  reviewId: number | null;
  threadKey: string;
  attemptCount: number;
  diff: string | null;
  error: string | null;
  verdict: Verdict | null;
  proposal: Proposal | null;
  newCommits: BranchAdvance | null;
  /**
   * Explanation artifact: the agent's read-only markdown answer to this Thread's
   * question (mermaid in fenced blocks). Owner-facing only — never posted.
   */
  explanationMd: string | null;
  explanationStatus: "generating" | "ready" | "failed" | null;
  /** The follow-up question the last run answered (null = the thread's own topic). */
  explanationQuestion: string | null;
  /** Soft hint: built against an older head, so its permalinks may be stale. */
  explanationStale: boolean;
  items: FeedbackItem[];
  events: { kind: string; message: string; at: string }[];
}
