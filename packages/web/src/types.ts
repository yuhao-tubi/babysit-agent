export type ThreadStatus =
  | "pending"
  | "in_progress"
  | "resolved"
  | "blocked"
  | "error";

/** A thread-unit as summarized under its PR. */
export interface ThreadSummary {
  id: number;
  status: ThreadStatus;
  authorClass: "bot" | "human";
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
  status: ThreadStatus;
  counts: { blocked: number; ongoing: number; resolved: number };
  threads: ThreadSummary[];
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
}

export interface Verdict {
  action: string;
  summary: string;
  reply_draft: string;
  risk: string;
}

export interface ThreadDetail {
  id: number;
  prKey: string;
  status: ThreadStatus;
  authorClass: "bot" | "human";
  reviewId: number | null;
  threadKey: string;
  attemptCount: number;
  diff: string | null;
  error: string | null;
  verdict: Verdict | null;
  items: FeedbackItem[];
  events: { kind: string; message: string; at: string }[];
}
