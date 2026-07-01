import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import type {
  AuthorClass,
  FeedbackItem,
  Proposal,
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
  addPrCol("overview_head_sha", "TEXT");
  addPrCol("overview_status", "TEXT");
  addPrCol("overview_generated_at", "TEXT");
  // Discovery role: "author" (you wrote it — full pipeline) or "reviewer"
  // (you're a requested reviewer — OVERVIEW-ONLY, never enters verdict/gate/push).
  addPrCol("role", "TEXT NOT NULL DEFAULT 'author'");
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
      `INSERT INTO prs (pr_key, owner, repo, number, title, url, head_ref, head_sha, role, last_polled)
       VALUES (@prKey,@owner,@repo,@number,@title,@url,@headRef,@headSha,@role,@lastPolled)
       ON CONFLICT(pr_key) DO UPDATE SET
         title=@title, url=@url, head_ref=@headRef, head_sha=@headSha, role=@role, last_polled=@lastPolled`
    )
    .run({ headSha: null, role: "author", ...p, lastPolled: now() });
}

/**
 * Drop every stored PR (and its threads/items/feedback/events) that is no longer
 * in the live open-PR set — i.e. it merged or closed since we last saw it. We
 * only ever observe open PRs (decision: the watch list tracks open PRs only), so
 * a PR that falls out of the authored-open search is removed wholesale. Returns
 * the pr_keys pruned. No-op when `openPrKeys` is empty (treated as "unknown" to
 * avoid wiping the list on a failed/empty poll).
 */
export function pruneClosedPrs(openPrKeys: string[]): string[] {
  if (openPrKeys.length === 0) return [];
  const db = getDb();
  const placeholders = openPrKeys.map(() => "?").join(",");
  const stale = db
    .prepare(`SELECT pr_key FROM prs WHERE pr_key NOT IN (${placeholders})`)
    .all(...openPrKeys) as { pr_key: string }[];
  if (stale.length === 0) return [];

  const keys = stale.map((r) => r.pr_key);
  const prune = db.transaction((prKeys: string[]) => {
    for (const prKey of prKeys) {
      const threadIds = (
        db.prepare("SELECT id FROM threads WHERE pr_key=?").all(prKey) as { id: number }[]
      ).map((r) => r.id);
      for (const tid of threadIds) {
        db.prepare("DELETE FROM thread_items WHERE thread_id=?").run(tid);
        db.prepare("DELETE FROM events WHERE thread_id=?").run(tid);
      }
      db.prepare("DELETE FROM threads WHERE pr_key=?").run(prKey);
      db.prepare("DELETE FROM feedback WHERE pr_key=?").run(prKey);
      db.prepare("DELETE FROM prs WHERE pr_key=?").run(prKey);
    }
  });
  prune(keys);
  return keys;
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
  }>
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updated_at: now() };
  if (fields.status !== undefined) {
    sets.push("status=@status");
    params.status = fields.status;
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
  };
}

/** PRs that currently have at least one thread-unit, newest activity first. */
export function listPrsWithThreads(): PrRow[] {
  const rows = getDb()
    .prepare(
      `SELECT p.pr_key, p.owner, p.repo, p.number, p.title, p.url, p.role, p.last_polled
       FROM prs p
       WHERE EXISTS (SELECT 1 FROM threads t WHERE t.pr_key = p.pr_key)
       ORDER BY p.last_polled DESC`
    )
    .all();
  return rows.map(rowToPrRow);
}

/**
 * Reviewer-role PRs (you're a requested reviewer). These are OVERVIEW-ONLY and
 * have no Threads, so they are listed by role rather than by thread existence.
 */
export function listReviewerPrs(): PrRow[] {
  const rows = getDb()
    .prepare(
      `SELECT pr_key, owner, repo, number, title, url, role, last_polled
       FROM prs WHERE role='reviewer' ORDER BY last_polled DESC`
    )
    .all();
  return rows.map(rowToPrRow);
}

// ---- PR-level overview + diagram artifact (a Session-level artifact) ----

export type OverviewStatus = "idle" | "generating" | "ready" | "failed";

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
  /** The 4-part overview markdown, or null if never generated. */
  overviewMd: string | null;
  /** Absolute path to the saved SVG diagram, or null if none/failed. */
  diagramPath: string | null;
  /** Head sha the artifact was built against (staleness signal). */
  overviewHeadSha: string | null;
  overviewStatus: OverviewStatus;
  overviewGeneratedAt: string | null;
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
    diagramPath: r.diagram_path ?? null,
    overviewHeadSha: r.overview_head_sha ?? null,
    overviewStatus: (r.overview_status as OverviewStatus) ?? "idle",
    overviewGeneratedAt: r.overview_generated_at ?? null,
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
    diagramPath: string | null;
    overviewHeadSha: string | null;
    overviewStatus: OverviewStatus;
    overviewGeneratedAt: string | null;
  }>
): void {
  const map: Record<string, string> = {
    overviewMd: "overview_md",
    diagramPath: "diagram_path",
    overviewHeadSha: "overview_head_sha",
    overviewStatus: "overview_status",
    overviewGeneratedAt: "overview_generated_at",
  };
  const sets: string[] = [];
  const params: Record<string, unknown> = { pr_key: prKey };
  for (const [k, col] of Object.entries(map)) {
    if ((fields as any)[k] !== undefined) {
      sets.push(`${col}=@${col}`);
      params[col] = (fields as any)[k];
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
