import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import type {
  AuthorClass,
  BranchAdvance,
  DiagramSet,
  FeedbackItem,
  Proposal,
  QuizQuestion,
  RiskItem,
  ThreadRow,
  ThreadStatus,
  Verdict,
} from "./types.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const cfg = loadConfig();
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  db = new Database(cfg.dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  // Clean-cut migration: the old `sessions`/`session_items` tables were grained
  // one-row-per-review-event. The unit is now the thread (`threads`), so the old
  // tables are dropped and rebuilt from live GitHub state on the next poll.
  const hasOldSessions = d
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
    .get();
  if (hasOldSessions) {
    // events.session_id referenced the old grain; drop so it recreates as thread_id.
    d.exec(
      `DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS session_items; DROP TABLE IF EXISTS events;`
    );
  }

  d.exec(`
    CREATE TABLE IF NOT EXISTS prs (
      pr_key       TEXT PRIMARY KEY,        -- owner/repo#number
      owner        TEXT NOT NULL,
      repo         TEXT NOT NULL,
      number       INTEGER NOT NULL,
      title        TEXT NOT NULL,
      url          TEXT NOT NULL,
      head_ref     TEXT NOT NULL,
      head_sha     TEXT,
      last_polled  TEXT
    );

    -- Every feedback comment we've ever seen, for dedupe across polls.
    CREATE TABLE IF NOT EXISTS feedback (
      gh_id        INTEGER PRIMARY KEY,
      pr_key       TEXT NOT NULL,
      kind         TEXT NOT NULL,
      author       TEXT NOT NULL,
      author_type  TEXT NOT NULL,
      body         TEXT NOT NULL,
      path         TEXT,
      line         INTEGER,
      html_url     TEXT,
      thread_key   TEXT NOT NULL,
      review_id    INTEGER,                 -- review event this belongs to, if any
      created_at   TEXT NOT NULL,
      seen_at      TEXT NOT NULL
    );

    -- Thread-unit: the decision unit. One row per (pr_key, thread_key).
    CREATE TABLE IF NOT EXISTS threads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_key        TEXT NOT NULL,
      owner         TEXT NOT NULL,
      repo          TEXT NOT NULL,
      number        INTEGER NOT NULL,
      review_id     INTEGER,                -- provenance for review-summary threads
      thread_key    TEXT NOT NULL,
      author_class  TEXT NOT NULL,
      status        TEXT NOT NULL,
      verdict_json  TEXT,
      reply_draft   TEXT,
      diff          TEXT,
      proposal_json TEXT,                    -- frozen Proposal backing awaiting_approval
      attempt_count INTEGER NOT NULL DEFAULT 0,
      error         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      UNIQUE (pr_key, thread_key)
    );

    -- Feedback items belonging to a thread (its inline comments / summary / replies).
    CREATE TABLE IF NOT EXISTS thread_items (
      thread_id    INTEGER NOT NULL,
      gh_id        INTEGER NOT NULL,
      PRIMARY KEY (thread_id, gh_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id   INTEGER,
      kind        TEXT NOT NULL,
      message     TEXT NOT NULL,
      at          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
    CREATE INDEX IF NOT EXISTS idx_threads_prkey ON threads(pr_key);
    CREATE INDEX IF NOT EXISTS idx_feedback_prkey ON feedback(pr_key);
  `);

  // Additive column migration for DBs created before proposal_json existed.
  const cols = d.prepare("PRAGMA table_info(threads)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "proposal_json")) {
    d.exec("ALTER TABLE threads ADD COLUMN proposal_json TEXT");
  }
  // Commits that landed on the branch while the Thread was waiting (BranchAdvance).
  if (!cols.some((c) => c.name === "new_commits_json")) {
    d.exec("ALTER TABLE threads ADD COLUMN new_commits_json TEXT");
  }

  // Additive columns on `prs` for the PR-level overview + diagram artifact
  // (a Session-level artifact that lives OUTSIDE the Thread/Verdict lifecycle).
  // `overview_md` is the 4-part prose; `diagram_path` is the on-disk SVG path;
  // `overview_head_sha` is the head the artifact was built against (staleness);
  // `overview_status` ∈ idle|generating|ready|failed.
  const prCols = d.prepare("PRAGMA table_info(prs)").all() as { name: string }[];
  const addPrCol = (name: string, decl: string) => {
    if (!prCols.some((c) => c.name === name)) {
      d.exec(`ALTER TABLE prs ADD COLUMN ${name} ${decl}`);
    }
  };
  addPrCol("overview_md", "TEXT");
  addPrCol("diagram_path", "TEXT");
  // `diagrams_json` holds the 4W1H diagram set: a MAP of read-only SVG diagrams
  // keyed by section ({why?,what?,how?}), each `{ svg }` authored by the agent in
  // one pass and rendered inline (see issue #1). (The column has been reused
  // across shapes — React-Flow DiagramSpec[], then Excalidraw docs, now SVG — so
  // `parseDiagrams` drops any legacy payload that isn't the current shape.)
  addPrCol("diagrams_json", "TEXT");
  addPrCol("overview_head_sha", "TEXT");
  addPrCol("overview_status", "TEXT");
  addPrCol("overview_generated_at", "TEXT");
  // LEGACY: was set when the owner hand-edited a diagram canvas. Diagrams are now
  // read-only (issue #1), so nothing reads or writes this; the column add is kept
  // (additive migrations never drop columns) but is dead. Do not reuse.
  addPrCol("diagrams_edited_at", "TEXT");
  // Discovery role: "author" (you wrote it — full pipeline) or "reviewer"
  // (you're a requested reviewer — OVERVIEW-ONLY, never enters verdict/gate/push).
  addPrCol("role", "TEXT NOT NULL DEFAULT 'author'");
  // Verified Risk Analysis (reviewer-role PRs only) — produced by the SAME
  // Generate run as the overview (finder→confirmer passes in the shared
  // worktree), but persisted as its OWN artifact. `risks_json` is the merged,
  // display-ready RiskItem[]; `risks_status` ∈ ready|failed (independent of the
  // overview's status — a failed risk stage never blanks a ready overview). It
  // shares the overview's head-sha / generated-at / generating machinery.
  addPrCol("risks_json", "TEXT");
  addPrCol("risks_status", "TEXT");
  // `risks_head_sha` is the head the risk analysis was built against. Reviewer
  // risks piggyback the overview's Generate run and leave this NULL (their PR is
  // static). AUTHOR Blind spots (PR-resources spec) DECOUPLE from the overview
  // and set this per run, so the panel can detect staleness on a moving author
  // branch and prompt a Regenerate rather than show findings against a stale sha.
  addPrCol("risks_head_sha", "TEXT");
  // PR-comprehension QUIZ (a Session-level artifact like the overview/risks). Its
  // own on-demand agent run; `quiz_json` is the QuizQuestion[], `quiz_status` ∈
  // generating|ready|failed, and `quiz_head_sha` is the head it was built against
  // (auto-invalidated when it differs from the live head — see the API's stale
  // gating). Answers are ephemeral (browser-only), so nothing else is persisted.
  addPrCol("quiz_json", "TEXT");
  addPrCol("quiz_status", "TEXT");
  addPrCol("quiz_head_sha", "TEXT");
  // Set when a PR falls out of the live open set (merged/closed since last poll).
  // Expired PRs (and their threads) are RETAINED, not deleted — surfaced in a
  // separate "Expired" section of the dashboard and skipped by the pipeline.
  // Cleared (set NULL) again if the PR ever comes back into the open set.
  addPrCol("expired_at", "TEXT");
}

function now(): string {
  return new Date().toISOString();
}

// ---- feedback dedupe ----

export function hasSeenFeedback(ghId: number): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM feedback WHERE gh_id = ?")
    .get(ghId);
  return !!row;
}

export function recordFeedback(prKey: string, item: FeedbackItem, reviewId: number | null): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO feedback
       (gh_id, pr_key, kind, author, author_type, body, path, line, html_url, thread_key, review_id, created_at, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      item.ghId,
      prKey,
      item.kind,
      item.author,
      item.authorType,
      item.body,
      item.path ?? null,
      item.line ?? null,
      item.htmlUrl ?? null,
      item.threadKey,
      reviewId,
      item.createdAt,
      now()
    );
}

// ---- prs ----

export type PrRole = "author" | "reviewer";

export function upsertPr(p: {
  prKey: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  headRef: string;
  headSha?: string;
  role?: PrRole;
}): void {
  getDb()
    .prepare(
      `INSERT INTO prs (pr_key, owner, repo, number, title, url, head_ref, head_sha, role, last_polled, expired_at)
       VALUES (@prKey,@owner,@repo,@number,@title,@url,@headRef,@headSha,@role,@lastPolled,NULL)
       ON CONFLICT(pr_key) DO UPDATE SET
         title=@title, url=@url, head_ref=@headRef, head_sha=@headSha, role=@role,
         last_polled=@lastPolled, expired_at=NULL`
    )
    .run({ headSha: null, role: "author", ...p, lastPolled: now() });
}

/**
 * Mark every stored PR that is no longer in the live open-PR set as EXPIRED —
 * i.e. it merged or closed since we last saw it. We only ever observe open PRs
 * (decision: the watch list tracks open PRs only), so a PR that falls out of the
 * authored-open search has ended. Rather than delete it wholesale, we RETAIN the
 * PR (and its threads/feedback/events) with an `expired_at` stamp so the owner
 * can still see its history in the dashboard's "Expired" section; the pipeline
 * skips expired PRs. Idempotent — a PR already expired keeps its original stamp.
 * Returns the pr_keys newly expired. No-op when `openPrKeys` is empty (treated as
 * "unknown" to avoid wiping the list on a failed/empty poll).
 */
export function pruneClosedPrs(openPrKeys: string[]): string[] {
  if (openPrKeys.length === 0) return [];
  const db = getDb();
  const placeholders = openPrKeys.map(() => "?").join(",");
  const stale = db
    .prepare(
      `SELECT pr_key FROM prs WHERE expired_at IS NULL AND pr_key NOT IN (${placeholders})`
    )
    .all(...openPrKeys) as { pr_key: string }[];
  if (stale.length === 0) return [];

  const keys = stale.map((r) => r.pr_key);
  const ts = now();
  const expire = db.transaction((prKeys: string[]) => {
    for (const prKey of prKeys) {
      db.prepare("UPDATE prs SET expired_at=? WHERE pr_key=?").run(ts, prKey);
    }
  });
  expire(keys);
  return keys;
}

/** True when a PR has fallen out of the live open set (merged/closed). */
export function isPrExpired(prKey: string): boolean {
  const row = getDb()
    .prepare("SELECT expired_at FROM prs WHERE pr_key=?")
    .get(prKey) as { expired_at: string | null } | undefined;
  return !!row?.expired_at;
}

// ---- threads ----

export interface NewThread {
  prKey: string;
  owner: string;
  repo: string;
  number: number;
  reviewId: number | null;
  threadKey: string;
  authorClass: AuthorClass;
  itemGhIds: number[];
}

/** Existing thread-unit for (prKey, threadKey), if any. */
export function getThreadByKey(prKey: string, threadKey: string): ThreadRow | undefined {
  const r = getDb()
    .prepare("SELECT * FROM threads WHERE pr_key=? AND thread_key=?")
    .get(prKey, threadKey);
  return r ? rowToThread(r) : undefined;
}

export function createThread(s: NewThread): number {
  const d = getDb();
  const ts = now();
  const info = d
    .prepare(
      `INSERT INTO threads
       (pr_key, owner, repo, number, review_id, thread_key, author_class, status, attempt_count, created_at, updated_at)
       VALUES (@prKey,@owner,@repo,@number,@reviewId,@threadKey,@authorClass,'pending',0,@ts,@ts)`
    )
    .run({ ...s, ts });
  const id = Number(info.lastInsertRowid);
  setThreadItems(id, s.itemGhIds);
  return id;
}

/** Replace the set of feedback items attached to a thread. */
export function setThreadItems(threadId: number, ghIds: number[]): void {
  const d = getDb();
  const stmt = d.prepare(
    "INSERT OR IGNORE INTO thread_items (thread_id, gh_id) VALUES (?,?)"
  );
  for (const gid of ghIds) stmt.run(threadId, gid);
}

export function updateThread(
  id: number,
  fields: Partial<{
    status: ThreadStatus;
    verdict: Verdict;
    replyDraft: string;
    diff: string | null;
    proposal: Proposal | null;
    error: string | null;
    attemptCount: number;
    newCommits: BranchAdvance | null;
  }>
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updated_at: now() };
  if (fields.status !== undefined) {
    sets.push("status=@status");
    params.status = fields.status;
    // Re-worked or resolved → the "branch advanced" marker is stale; drop it.
    // (A Thread that lands back in a waiting state gets a fresh base snapshotted
    // by the poller.) Skipped when the caller sets newCommits explicitly below.
    if (
      fields.newCommits === undefined &&
      (fields.status === "pending" ||
        fields.status === "in_progress" ||
        fields.status === "resolved")
    ) {
      sets.push("new_commits_json=@new_commits_json");
      params.new_commits_json = null;
    }
  }
  if (fields.verdict !== undefined) {
    sets.push("verdict_json=@verdict_json");
    params.verdict_json = JSON.stringify(fields.verdict);
  }
  if (fields.replyDraft !== undefined) {
    sets.push("reply_draft=@reply_draft");
    params.reply_draft = fields.replyDraft;
  }
  if (fields.diff !== undefined) {
    sets.push("diff=@diff");
    params.diff = fields.diff;
  }
  if (fields.proposal !== undefined) {
    sets.push("proposal_json=@proposal_json");
    params.proposal_json = fields.proposal === null ? null : JSON.stringify(fields.proposal);
  }
  if (fields.error !== undefined) {
    sets.push("error=@error");
    params.error = fields.error;
  }
  if (fields.attemptCount !== undefined) {
    sets.push("attempt_count=@attempt_count");
    params.attempt_count = fields.attemptCount;
  }
  if (fields.newCommits !== undefined) {
    sets.push("new_commits_json=@new_commits_json");
    params.new_commits_json =
      fields.newCommits === null ? null : JSON.stringify(fields.newCommits);
  }
  sets.push("updated_at=@updated_at");
  getDb()
    .prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id=@id`)
    .run(params);
}

function rowToThread(r: any): ThreadRow {
  return {
    id: r.id,
    prKey: r.pr_key,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    reviewId: r.review_id,
    threadKey: r.thread_key,
    authorClass: r.author_class,
    status: r.status,
    verdictJson: r.verdict_json,
    replyDraft: r.reply_draft,
    diff: r.diff,
    proposalJson: r.proposal_json ?? null,
    newCommitsJson: r.new_commits_json ?? null,
    attemptCount: r.attempt_count,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getThread(id: number): ThreadRow | undefined {
  const r = getDb().prepare("SELECT * FROM threads WHERE id=?").get(id);
  return r ? rowToThread(r) : undefined;
}

export function listThreads(status?: ThreadStatus): ThreadRow[] {
  const rows = status
    ? getDb()
        .prepare("SELECT * FROM threads WHERE status=? ORDER BY updated_at DESC")
        .all(status)
    : getDb()
        .prepare("SELECT * FROM threads ORDER BY updated_at DESC")
        .all();
  return rows.map(rowToThread);
}

/**
 * Threads for a PR that sit in a WAITING state (`blocked` / `awaiting_approval`
 * / `error`) — the ones a branch push can't re-open, so the poller annotates
 * them with any new commits instead.
 */
export function listWaitingThreads(prKey: string): ThreadRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM threads
       WHERE pr_key=? AND status IN ('blocked','awaiting_approval','error')`
    )
    .all(prKey)
    .map(rowToThread);
}

export function getThreadItems(id: number): FeedbackItem[] {
  const rows = getDb()
    .prepare(
      `SELECT f.* FROM feedback f
       JOIN thread_items ti ON ti.gh_id = f.gh_id
       WHERE ti.thread_id = ? ORDER BY f.created_at`
    )
    .all(id);
  return rows.map((r: any) => ({
    ghId: r.gh_id,
    kind: r.kind,
    author: r.author,
    authorType: r.author_type,
    body: r.body,
    path: r.path,
    line: r.line,
    htmlUrl: r.html_url,
    createdAt: r.created_at,
    threadKey: r.thread_key,
  }));
}

/** Count of auto-fix attempts on a thread, for loop-guard. */
export function threadAttemptCount(prKey: string, threadKey: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(attempt_count),0) AS n FROM threads
       WHERE pr_key=? AND thread_key=?`
    )
    .get(prKey, threadKey) as { n: number };
  return row.n;
}

// ---- PR grouping (the "Session" view) ----

export interface PrRow {
  prKey: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  role: PrRole;
  lastPolled: string | null;
  /** Set when the PR left the live open set (merged/closed); null while open. */
  expiredAt: string | null;
}

function rowToPrRow(r: any): PrRow {
  return {
    prKey: r.pr_key,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    title: r.title,
    url: r.url,
    role: (r.role as PrRole) ?? "author",
    lastPolled: r.last_polled,
    expiredAt: r.expired_at ?? null,
  };
}

/**
 * Still-open PRs that currently have at least one thread-unit, newest activity
 * first. Expired PRs are excluded here — see `listExpiredPrsPage`.
 */
export function listPrsWithThreads(): PrRow[] {
  const rows = getDb()
    .prepare(
      `SELECT p.pr_key, p.owner, p.repo, p.number, p.title, p.url, p.role, p.last_polled, p.expired_at
       FROM prs p
       WHERE p.expired_at IS NULL
         AND EXISTS (SELECT 1 FROM threads t WHERE t.pr_key = p.pr_key)
       ORDER BY p.last_polled DESC`
    )
    .all();
  return rows.map(rowToPrRow);
}

/**
 * Reviewer-role PRs (you're a requested reviewer). These are OVERVIEW-ONLY and
 * have no Threads, so they are listed by role rather than by thread existence.
 * Expired PRs are excluded — see `listExpiredPrsPage`.
 */
export function listReviewerPrs(): PrRow[] {
  const rows = getDb()
    .prepare(
      `SELECT pr_key, owner, repo, number, title, url, role, last_polled, expired_at
       FROM prs WHERE role='reviewer' AND expired_at IS NULL ORDER BY last_polled DESC`
    )
    .all();
  return rows.map(rowToPrRow);
}

/**
 * One page of expired PRs (merged/closed since last seen), most-recently expired
 * first. Retained so the owner can still inspect their history in the dashboard's
 * dedicated "Expired" view; both authored and reviewer roles are included. Offset
 * pagination (`page` is 1-indexed) — the Expired view is dead history loaded
 * lazily/incrementally, never on the live SSE refresh path, so an unbounded fetch
 * isn't wanted. A short page (< pageSize) tells the caller there's no more.
 */
export function listExpiredPrsPage(page: number, pageSize: number): PrRow[] {
  const rows = getDb()
    .prepare(
      `SELECT pr_key, owner, repo, number, title, url, role, last_polled, expired_at
       FROM prs WHERE expired_at IS NOT NULL ORDER BY expired_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(pageSize, (page - 1) * pageSize);
  return rows.map(rowToPrRow);
}

// ---- PR-level overview + diagram artifact (a Session-level artifact) ----

export type OverviewStatus = "idle" | "generating" | "ready" | "failed";
// Reviewer risks only ever land `ready`/`failed` (produced synchronously inside
// the overview run). AUTHOR Blind spots are an on-demand artifact like the quiz,
// so they also use `generating` (in-flight) — hence the shared shape.
export type RiskStatus = "generating" | "ready" | "failed";
export type QuizStatus = "generating" | "ready" | "failed";

/** Parse the stored quiz JSON into a QuizQuestion[], dropping malformed entries. */
function parseQuiz(json: unknown): QuizQuestion[] {
  if (typeof json !== "string" || !json.trim()) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: QuizQuestion[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const o = e as any;
    if (
      typeof o.question !== "string" || !o.question.trim() ||
      !Array.isArray(o.options) || o.options.length < 2 ||
      !o.options.every((x: unknown) => typeof x === "string") ||
      typeof o.correctIndex !== "number" ||
      o.correctIndex < 0 || o.correctIndex >= o.options.length ||
      typeof o.explanation !== "string"
    ) {
      continue;
    }
    out.push({
      question: o.question,
      options: o.options,
      correctIndex: o.correctIndex,
      explanation: o.explanation,
    });
  }
  return out;
}

/** Parse the stored risks JSON into a RiskItem[], tolerating null/corrupt values. */
function parseRisks(json: unknown): RiskItem[] {
  if (typeof json !== "string" || !json.trim()) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as RiskItem[]) : [];
  } catch {
    return [];
  }
}

export interface PrOverview {
  prKey: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  headRef: string;
  role: PrRole;
  /** Current head sha from the last poll (staleness = differs from overviewHeadSha). */
  headSha: string | null;
  /** The 4W1H overview markdown, or null if never generated. */
  overviewMd: string | null;
  /** The 4W1H diagram set — read-only SVG diagrams keyed by section ({} if none). */
  diagrams: DiagramSet;
  /** Head sha the artifact was built against (staleness signal). */
  overviewHeadSha: string | null;
  overviewStatus: OverviewStatus;
  overviewGeneratedAt: string | null;
  /**
   * Risk analysis: Verified risks (reviewer PRs) or author Blind spots — the same
   * merged RiskItem[] storage ([] if none/failed). Role drives which was produced.
   */
  risks: RiskItem[];
  /** `generating` | `ready` | `failed` | null (never run). Independent of overviewStatus. */
  risksStatus: RiskStatus | null;
  /**
   * Head the risk analysis was built against — set for AUTHOR Blind spots (their
   * own on-demand run) so staleness can be detected on a moving branch; NULL for
   * reviewer risks, which piggyback the overview's sha. See `blindSpotsStale`.
   */
  risksHeadSha: string | null;
  /** PR-comprehension quiz — QuizQuestion[] ([] if never generated/failed). */
  quiz: QuizQuestion[];
  /** `generating` | `ready` | `failed` | null (never run). Independent of overview. */
  quizStatus: QuizStatus | null;
  /** Head sha the quiz was built against (staleness = differs from headSha). */
  quizHeadSha: string | null;
}

/**
 * Parse the stored diagram JSON into a section→DiagramDoc map, tolerating
 * null/corrupt values and legacy payloads. Each entry must be an object with a
 * string `svg` (the current shape); anything else — an array (legacy React-Flow
 * `DiagramSpec[]`), or a legacy Excalidraw `{type,elements}` doc — is dropped, so
 * an old row simply reads back with no diagrams until it is regenerated.
 */
function parseDiagrams(json: unknown): DiagramSet {
  if (typeof json !== "string" || !json.trim()) return {};
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: DiagramSet = {};
    for (const [section, doc] of Object.entries(obj as Record<string, unknown>)) {
      if (section !== "why" && section !== "what" && section !== "how") continue;
      if (doc && typeof doc === "object" && typeof (doc as any).svg === "string") {
        out[section] = { svg: (doc as any).svg };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function rowToOverview(r: any): PrOverview {
  return {
    prKey: r.pr_key,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    title: r.title,
    url: r.url,
    headRef: r.head_ref,
    role: (r.role as PrRole) ?? "author",
    headSha: r.head_sha ?? null,
    overviewMd: r.overview_md ?? null,
    diagrams: parseDiagrams(r.diagrams_json),
    overviewHeadSha: r.overview_head_sha ?? null,
    overviewStatus: (r.overview_status as OverviewStatus) ?? "idle",
    overviewGeneratedAt: r.overview_generated_at ?? null,
    risks: parseRisks(r.risks_json),
    risksStatus: (r.risks_status as RiskStatus) ?? null,
    risksHeadSha: r.risks_head_sha ?? null,
    quiz: parseQuiz(r.quiz_json),
    quizStatus: (r.quiz_status as QuizStatus) ?? null,
    quizHeadSha: r.quiz_head_sha ?? null,
  };
}

/** Full PR row incl. the overview artifact columns (by prKey). */
export function getPrOverview(prKey: string): PrOverview | undefined {
  const r = getDb().prepare("SELECT * FROM prs WHERE pr_key=?").get(prKey);
  return r ? rowToOverview(r) : undefined;
}

/** Patch the overview artifact columns on a PR row. */
export function updatePrOverview(
  prKey: string,
  fields: Partial<{
    overviewMd: string | null;
    diagrams: DiagramSet | null;
    overviewHeadSha: string | null;
    overviewStatus: OverviewStatus;
    overviewGeneratedAt: string | null;
    risks: RiskItem[] | null;
    risksStatus: RiskStatus | null;
    risksHeadSha: string | null;
    quiz: QuizQuestion[] | null;
    quizStatus: QuizStatus | null;
    quizHeadSha: string | null;
  }>
): void {
  const map: Record<string, string> = {
    overviewMd: "overview_md",
    diagrams: "diagrams_json",
    overviewHeadSha: "overview_head_sha",
    overviewStatus: "overview_status",
    overviewGeneratedAt: "overview_generated_at",
    risks: "risks_json",
    risksStatus: "risks_status",
    risksHeadSha: "risks_head_sha",
    quiz: "quiz_json",
    quizStatus: "quiz_status",
    quizHeadSha: "quiz_head_sha",
  };
  // Columns whose value is a JSON-serialized structure (everything else scalar).
  const jsonCols = new Set(["diagrams", "risks", "quiz"]);
  const sets: string[] = [];
  const params: Record<string, unknown> = { pr_key: prKey };
  for (const [k, col] of Object.entries(map)) {
    if ((fields as any)[k] !== undefined) {
      sets.push(`${col}=@${col}`);
      params[col] = jsonCols.has(k)
        ? (fields as any)[k] == null
          ? null
          : JSON.stringify((fields as any)[k])
        : (fields as any)[k];
    }
  }
  if (!sets.length) return;
  getDb()
    .prepare(`UPDATE prs SET ${sets.join(", ")} WHERE pr_key=@pr_key`)
    .run(params);
}

/**
 * Startup sweep: an overview left `generating` by a crash owes GitHub nothing
 * (unlike an interrupted Thread), so it is NOT auto-resumed — just reset to
 * `failed` so the owner can re-click Generate. Returns the pr_keys reset.
 */
export function failStuckOverviews(): string[] {
  const db = getDb();
  const stuck = db
    .prepare("SELECT pr_key FROM prs WHERE overview_status='generating'")
    .all() as { pr_key: string }[];
  if (!stuck.length) return [];
  db.prepare("UPDATE prs SET overview_status='failed' WHERE overview_status='generating'").run();
  return stuck.map((r) => r.pr_key);
}

/**
 * Startup sweep for the quiz artifact — same reasoning as `failStuckOverviews`:
 * a quiz left `generating` by a crash owes GitHub nothing, so it is reset to
 * `failed` (re-clickable) rather than resumed. Returns the pr_keys reset.
 */
export function failStuckQuizzes(): string[] {
  const db = getDb();
  const stuck = db
    .prepare("SELECT pr_key FROM prs WHERE quiz_status='generating'")
    .all() as { pr_key: string }[];
  if (!stuck.length) return [];
  db.prepare("UPDATE prs SET quiz_status='failed' WHERE quiz_status='generating'").run();
  return stuck.map((r) => r.pr_key);
}

/**
 * Startup sweep for author Blind spots — same reasoning as `failStuckOverviews`:
 * a risk analysis left `generating` by a crash owes GitHub nothing, so it is
 * reset to `failed` (re-clickable) rather than resumed. Reviewer risks never sit
 * in `generating` (they finish inside the overview run), so this only ever
 * catches an interrupted author run. Returns the pr_keys reset.
 */
export function failStuckRisks(): string[] {
  const db = getDb();
  const stuck = db
    .prepare("SELECT pr_key FROM prs WHERE risks_status='generating'")
    .all() as { pr_key: string }[];
  if (!stuck.length) return [];
  db.prepare("UPDATE prs SET risks_status='failed' WHERE risks_status='generating'").run();
  return stuck.map((r) => r.pr_key);
}

/** Most recent poll time across all PRs (the daemon's last poll cycle). */
export function lastPollTime(): string | null {
  const row = getDb()
    .prepare("SELECT MAX(last_polled) AS t FROM prs")
    .get() as { t: string | null };
  return row?.t ?? null;
}

export function logEvent(threadId: number | null, kind: string, message: string): void {
  getDb()
    .prepare(
      "INSERT INTO events (thread_id, kind, message, at) VALUES (?,?,?,?)"
    )
    .run(threadId, kind, message, now());
}

export function getEvents(threadId: number): { kind: string; message: string; at: string }[] {
  return getDb()
    .prepare("SELECT kind, message, at FROM events WHERE thread_id=? ORDER BY at")
    .all(threadId) as any[];
}

/**
 * The instruction a thread was acting on when it was interrupted, if any.
 *
 * `applyInstruction` logs an `instruction` event, then on completion logs
 * `finalized`. So an `instruction` with no later `finalized` is an in-flight
 * directive that died with the process — the message to re-drive on recovery.
 * Returns null when the thread's latest activity was not such an instruction.
 */
export function interruptedInstruction(threadId: number): string | null {
  const ins = getDb()
    .prepare(
      "SELECT message, at FROM events WHERE thread_id=? AND kind='instruction' ORDER BY at DESC LIMIT 1"
    )
    .get(threadId) as { message: string; at: string } | undefined;
  if (!ins) return null;
  const fin = getDb()
    .prepare(
      "SELECT at FROM events WHERE thread_id=? AND kind='finalized' ORDER BY at DESC LIMIT 1"
    )
    .get(threadId) as { at: string } | undefined;
  if (fin && fin.at >= ins.at) return null; // instruction already ran to completion
  return ins.message;
}

/**
 * True if the thread was interrupted mid-Approve: an `approve` event with no
 * later `finalized`. On recovery this means the deterministic apply+push of the
 * frozen proposal should be re-attempted (never a verdict replay).
 */
export function wasInterruptedApproving(threadId: number): boolean {
  const ap = getDb()
    .prepare(
      "SELECT at FROM events WHERE thread_id=? AND kind='approve' ORDER BY at DESC LIMIT 1"
    )
    .get(threadId) as { at: string } | undefined;
  if (!ap) return false;
  const fin = getDb()
    .prepare(
      "SELECT at FROM events WHERE thread_id=? AND kind='finalized' ORDER BY at DESC LIMIT 1"
    )
    .get(threadId) as { at: string } | undefined;
  return !(fin && fin.at >= ap.at);
}
