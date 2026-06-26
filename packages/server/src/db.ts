import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import type {
  AuthorClass,
  FeedbackItem,
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

export function upsertPr(p: {
  prKey: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  headRef: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO prs (pr_key, owner, repo, number, title, url, head_ref, last_polled)
       VALUES (@prKey,@owner,@repo,@number,@title,@url,@headRef,@lastPolled)
       ON CONFLICT(pr_key) DO UPDATE SET
         title=@title, url=@url, head_ref=@headRef, last_polled=@lastPolled`
    )
    .run({ ...p, lastPolled: now() });
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
    diff: string;
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
}

/** PRs that currently have at least one thread-unit, newest activity first. */
export function listPrsWithThreads(): PrRow[] {
  const rows = getDb()
    .prepare(
      `SELECT p.pr_key, p.owner, p.repo, p.number, p.title, p.url
       FROM prs p
       WHERE EXISTS (SELECT 1 FROM threads t WHERE t.pr_key = p.pr_key)
       ORDER BY p.last_polled DESC`
    )
    .all();
  return rows.map((r: any) => ({
    prKey: r.pr_key,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    title: r.title,
    url: r.url,
  }));
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
