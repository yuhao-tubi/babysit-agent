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
  /** Set when the PR merged/closed since last poll; null while open. Expired PRs
   *  are retained (read-only history) and shown in their own dashboard section. */
  expiredAt: string | null;
}

export type OverviewStatus = "idle" | "generating" | "ready" | "failed";

/** The 4W1H sections a diagram canvas can belong to. */
export type DiagramSection = "why" | "what" | "how";

/** A raw Excalidraw document (the `.excalidraw` file shape). Loosely typed —
 *  the durable truth is whatever @excalidraw/excalidraw reads/writes. */
export interface ExcalidrawDoc {
  type: "excalidraw";
  version?: number;
  source?: string;
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

/** The diagram set: up to one editable Excalidraw canvas per 4W1H section. */
export type DiagramSet = Partial<Record<DiagramSection, ExcalidrawDoc>>;

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
  /** When the owner last hand-edited+saved a canvas (null = never). */
  diagramsEditedAt: string | null;
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
  status: ThreadStatus;
  authorClass: "bot" | "human" | "ci";
  reviewId: number | null;
  threadKey: string;
  attemptCount: number;
  diff: string | null;
  error: string | null;
  verdict: Verdict | null;
  proposal: Proposal | null;
  newCommits: BranchAdvance | null;
  items: FeedbackItem[];
  events: { kind: string; message: string; at: string }[];
}
