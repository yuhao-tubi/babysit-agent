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
}

export type OverviewStatus = "idle" | "generating" | "ready" | "failed";

/** PR-level overview + diagram artifact (a Session-level artifact). */
export interface PrOverview {
  prKey: string;
  title: string;
  url: string;
  role: "author" | "reviewer";
  status: OverviewStatus;
  overviewMd: string | null;
  hasDiagram: boolean;
  overviewHeadSha: string | null;
  currentHeadSha: string | null;
  generatedAt: string | null;
  stale: boolean;
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
  diff?: string;
  proposedBody?: string;
  bodyDiff?: string;
  baseBody?: string;
  replyDraft?: string;
  changeApplied?: boolean;
  replyPosted?: boolean;
  replyDismissed?: boolean;
}

export interface ThreadDetail {
  id: number;
  prKey: string;
  status: ThreadStatus;
  authorClass: "bot" | "human" | "ci";
  reviewId: number | null;
  threadKey: string;
  attemptCount: number;
  diff: string | null;
  error: string | null;
  verdict: Verdict | null;
  proposal: Proposal | null;
  items: FeedbackItem[];
  events: { kind: string; message: string; at: string }[];
}
