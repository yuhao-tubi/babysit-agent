// Domain types — see CONTEXT.md glossary.

export type AuthorClass = "bot" | "human";

export type VerdictAction = "auto_fix" | "reply" | "escalate";

export type ThreadStatus =
  | "pending"
  | "in_progress"
  | "resolved"
  | "blocked"
  | "error";

/** A single GitHub comment belonging to a Thread. */
export interface FeedbackItem {
  /** GitHub id of the comment (review-comment id, review id, or issue-comment id). */
  ghId: number;
  /** Which GitHub surface this came from. */
  kind: "review_comment" | "review_summary" | "issue_comment";
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
  /** Risk level; `high` forces escalate even on auto_fix. */
  risk: "low" | "medium" | "high";
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
  diff: string | null;
  attemptCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
