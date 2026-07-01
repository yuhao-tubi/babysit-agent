import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FeedbackItem, Pr } from "./types.js";
import {
  ACTIONABLE_CONCLUSIONS,
  ciFeedbackId,
  ciThreadKey,
  classifyCheck,
} from "./ci.js";

const exec = promisify(execFile);

async function gh(args: string[], opts: { input?: string } = {}): Promise<string> {
  const child = exec("gh", args, { maxBuffer: 32 * 1024 * 1024 });
  if (opts.input != null) {
    child.child.stdin?.end(opts.input);
  }
  const { stdout } = await child;
  return stdout;
}

async function ghJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await gh(args)) as T;
}

/** Open PRs authored by the configured user. */
export async function listAuthoredPrs(): Promise<Omit<Pr, "headRefName" | "headSha">[]> {
  const rows = await ghJson<
    { number: number; title: string; url: string; repository: { nameWithOwner: string } }[]
  >([
    "search",
    "prs",
    "--author=@me",
    "--state=open",
    "--json",
    "repository,number,title,url",
    "--limit",
    "100",
  ]);
  return rows.map((r) => {
    const [owner, repo] = r.repository.nameWithOwner.split("/");
    return { owner, repo, number: r.number, title: r.title, url: r.url };
  });
}

/**
 * Open PRs where the configured user is a requested reviewer (NOT authored by
 * them). These are OVERVIEW-ONLY on the dashboard — they never enter the
 * verdict/gate/push pipeline (that assumes it's your own branch).
 */
export async function listReviewRequestedPrs(): Promise<Omit<Pr, "headRefName" | "headSha">[]> {
  const rows = await ghJson<
    { number: number; title: string; url: string; repository: { nameWithOwner: string } }[]
  >([
    "search",
    "prs",
    "--review-requested=@me",
    "--state=open",
    "--json",
    "repository,number,title,url",
    "--limit",
    "100",
  ]);
  return rows.map((r) => {
    const [owner, repo] = r.repository.nameWithOwner.split("/");
    return { owner, repo, number: r.number, title: r.title, url: r.url };
  });
}

/** Head branch name + sha for a PR. */
export async function getPrHead(
  owner: string,
  repo: string,
  number: number
): Promise<{ headRefName: string; headSha: string }> {
  const r = await ghJson<{ headRefName: string; headRefOid: string }>([
    "pr",
    "view",
    String(number),
    "--repo",
    `${owner}/${repo}`,
    "--json",
    "headRefName,headRefOid",
  ]);
  return { headRefName: r.headRefName, headSha: r.headRefOid };
}

/** Current PR description (body markdown). */
export async function getPrBody(
  owner: string,
  repo: string,
  number: number
): Promise<string> {
  const r = await ghJson<{ body: string | null }>([
    "pr",
    "view",
    String(number),
    "--repo",
    `${owner}/${repo}`,
    "--json",
    "body",
  ]);
  return r.body ?? "";
}

/** Replace the PR description. Body is piped via stdin to handle long/markdown text. */
export async function updatePrBody(
  owner: string,
  repo: string,
  number: number,
  body: string
): Promise<void> {
  await gh(
    [
      "pr",
      "edit",
      String(number),
      "--repo",
      `${owner}/${repo}`,
      "--body-file",
      "-",
    ],
    { input: body }
  );
}

interface RawReview {
  id: number;
  body: string;
  state: string;
  user: { login: string; type: string };
}

interface RawComment {
  id: number;
  body: string;
  path: string | null;
  line: number | null;
  html_url: string;
  pull_request_review_id: number | null;
  in_reply_to_id: number | null;
  created_at: string;
  user: { login: string; type: string };
}

interface RawIssueComment {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  user: { login: string; type: string };
}

export async function getReviews(owner: string, repo: string, number: number): Promise<RawReview[]> {
  return ghJson<RawReview[]>([
    "api",
    `repos/${owner}/${repo}/pulls/${number}/reviews`,
    "--paginate",
  ]);
}

export async function getReviewComments(
  owner: string,
  repo: string,
  number: number
): Promise<RawComment[]> {
  return ghJson<RawComment[]>([
    "api",
    `repos/${owner}/${repo}/pulls/${number}/comments`,
    "--paginate",
  ]);
}

export async function getIssueComments(
  owner: string,
  repo: string,
  number: number
): Promise<RawIssueComment[]> {
  return ghJson<RawIssueComment[]>([
    "api",
    `repos/${owner}/${repo}/issues/${number}/comments`,
    "--paginate",
  ]);
}

/**
 * Resolution status of inline review threads. Only inline review-comment
 * threads can be "resolved" on GitHub — and that flag lives in GraphQL only,
 * not the REST comment objects. We key by the thread's ROOT comment databaseId.
 */
export async function getResolvedThreadKeys(
  owner: string,
  repo: string,
  number: number
): Promise<Set<string>> {
  const resolved = new Set<string>();
  let cursor: string | null = null;
  const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        reviewThreads(first:100, after:$cursor){
          nodes{ isResolved comments(first:1){ nodes{ databaseId } } }
          pageInfo{ hasNextPage endCursor }
        }
      }
    }
  }`;
  do {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `number=${number}`,
    ];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const res = await ghJson<{
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: { isResolved: boolean; comments: { nodes: { databaseId: number }[] } }[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        };
      };
    }>(args);
    const rt = res.data.repository.pullRequest.reviewThreads;
    for (const node of rt.nodes) {
      const rootId = node.comments.nodes[0]?.databaseId;
      if (node.isResolved && rootId != null) resolved.add(`thread:${rootId}`);
    }
    cursor = rt.pageInfo.hasNextPage ? rt.pageInfo.endCursor : null;
  } while (cursor);
  return resolved;
}

// ---- CI checks ----

/** A check-run on the PR's current head. */
export interface CheckRun {
  name: string;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | timed_out | … (only on completed) */
  conclusion: string | null;
  /** GitHub Actions workflow run id, when this is an Actions check. */
  runId: number | null;
  /** Link to the check/run. */
  htmlUrl: string;
  /** Commit the check ran against — used to filter strictly to current head. */
  headSha: string;
}

interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  details_url: string | null;
  head_sha: string;
  // The Actions run id is exposed nested under check_suite is NOT reliable; the
  // run id appears in details_url (…/runs/<runId>/job/…). We parse it from there.
}

/** Parse the Actions workflow run id out of a check-run's details/html url. */
function runIdFromUrl(url: string | null): number | null {
  if (!url) return null;
  const m = url.match(/\/runs\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Check-runs for the PR's CURRENT head sha only (decision Q20). Stale runs from
 * superseded commits are filtered out so they never re-open a Thread mid-flight.
 */
export async function getChecks(
  owner: string,
  repo: string,
  number: number
): Promise<CheckRun[]> {
  const head = await getPrHead(owner, repo, number);
  const res = await ghJson<{ check_runs: RawCheckRun[] }>([
    "api",
    `repos/${owner}/${repo}/commits/${head.headSha}/check-runs`,
    "--paginate",
  ]);
  const runs = res.check_runs ?? [];
  return runs
    .filter((c) => c.head_sha === head.headSha)
    .map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      runId: runIdFromUrl(c.details_url ?? c.html_url),
      htmlUrl: c.html_url ?? c.details_url ?? "",
      headSha: c.head_sha,
    }));
}

/**
 * Fetch the failed-step log for an Actions run. Returns the raw text (the caller
 * caps/writes it). Throws if the run id is unknown or the log can't be fetched —
 * the caller treats that as "can't self-verify" and escalates.
 */
export async function getFailedCheckLogs(
  owner: string,
  repo: string,
  runId: number
): Promise<string> {
  return gh(["run", "view", String(runId), "--repo", `${owner}/${repo}`, "--log-failed"]);
}

/** All PR feedback, flattened and grouped by threadKey (the decision unit). */
export interface ThreadGroup {
  threadKey: string;
  /** Author of the thread's root comment — defines the thread's author class. */
  rootAuthor: string;
  rootAuthorType: string;
  items: FeedbackItem[];
}

export interface PrFeedback {
  /** threadKey -> grouped items. */
  threads: Map<string, ThreadGroup>;
  /** threadKeys of inline threads marked resolved on GitHub. */
  resolvedThreadKeys: Set<string>;
}

function rootIdFromThreadKey(threadKey: string): number | null {
  const m = threadKey.match(/^(?:thread|review|issue):(\d+)$/);
  return m ? Number(m[1]) : null;
}

export async function collectFeedback(
  owner: string,
  repo: string,
  number: number,
  opts: { ci?: boolean } = {}
): Promise<PrFeedback> {
  const [reviews, comments, issueComments, resolvedThreadKeys, checks] = await Promise.all([
    getReviews(owner, repo, number),
    getReviewComments(owner, repo, number),
    getIssueComments(owner, repo, number),
    getResolvedThreadKeys(owner, repo, number),
    opts.ci ? getChecks(owner, repo, number) : Promise.resolve([] as CheckRun[]),
  ]);

  const items: FeedbackItem[] = [];

  // CI failures → one synthetic item per allowlisted, completed-failing check
  // (decision Q1/Q2/Q4). A passing allowlisted check folds into resolvedThreadKeys
  // so any stale failing Thread for it is treated as resolved (decision Q5).
  for (const c of checks) {
    const ciClass = classifyCheck(c.name);
    if (!ciClass) continue; // not babysat
    if (c.status !== "completed") continue; // not finished — never act mid-run
    const key = ciThreadKey(c.name);
    if (c.conclusion && ACTIONABLE_CONCLUSIONS.has(c.conclusion)) {
      items.push({
        ghId: ciFeedbackId(c.name, c.headSha),
        kind: "ci_failure",
        author: "ci",
        authorType: "ci",
        body: `CI check **${c.name}** failed (conclusion: ${c.conclusion}).\nRun: ${c.htmlUrl}`,
        htmlUrl: c.htmlUrl,
        createdAt: "",
        threadKey: key,
        checkName: c.name,
        ciClass,
      });
    } else {
      // Passing / neutral / skipped → resolved.
      resolvedThreadKeys.add(key);
    }
  }

  // Review summary bodies → one item each (their own thread).
  for (const rv of reviews) {
    if (rv.body && rv.body.trim()) {
      items.push({
        ghId: rv.id,
        kind: "review_summary",
        author: rv.user.login,
        authorType: rv.user.type,
        body: rv.body,
        createdAt: "",
        threadKey: `review:${rv.id}`,
      });
    }
  }

  // Inline review comments → grouped by their thread root.
  for (const c of comments) {
    items.push({
      ghId: c.id,
      kind: "review_comment",
      author: c.user.login,
      authorType: c.user.type,
      body: c.body,
      path: c.path,
      line: c.line,
      htmlUrl: c.html_url,
      createdAt: c.created_at,
      threadKey: `thread:${c.in_reply_to_id ?? c.id}`,
    });
  }

  // Loose issue-tab comments → one thread each.
  for (const c of issueComments) {
    items.push({
      ghId: c.id,
      kind: "issue_comment",
      author: c.user.login,
      authorType: c.user.type,
      body: c.body,
      htmlUrl: c.html_url,
      createdAt: c.created_at,
      threadKey: `issue:${c.id}`,
    });
  }

  // Group by threadKey; the root comment defines the thread's author.
  const threads = new Map<string, ThreadGroup>();
  for (const it of items) {
    let g = threads.get(it.threadKey);
    if (!g) {
      g = { threadKey: it.threadKey, rootAuthor: it.author, rootAuthorType: it.authorType, items: [] };
      threads.set(it.threadKey, g);
    }
    g.items.push(it);
  }
  // Resolve each group's root author: the item whose id matches the thread root.
  for (const g of threads.values()) {
    g.items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const rootId = rootIdFromThreadKey(g.threadKey);
    const root = g.items.find((i) => i.ghId === rootId) ?? g.items[0];
    g.rootAuthor = root.author;
    g.rootAuthorType = root.authorType;
  }

  return { threads, resolvedThreadKeys };
}

// ---- write actions (skipped when dryRun) ----

/** Reply to an inline review comment thread. */
export async function replyToReviewComment(
  owner: string,
  repo: string,
  number: number,
  commentId: number,
  body: string
): Promise<void> {
  await gh([
    "api",
    "--method",
    "POST",
    `repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
    "-f",
    `body=${body}`,
  ]);
}

/**
 * Resolve the inline review thread whose ROOT comment has `rootCommentId`
 * (the databaseId we key threads by). Inline-thread resolution lives in GraphQL
 * only: we first look up the thread's node id, then run the resolve mutation.
 * Returns true if a matching thread was found and resolved, false otherwise.
 */
export async function resolveReviewThread(
  owner: string,
  repo: string,
  number: number,
  rootCommentId: number
): Promise<boolean> {
  // Find the reviewThread node id whose root comment matches.
  let cursor: string | null = null;
  let threadId: string | null = null;
  const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        reviewThreads(first:100, after:$cursor){
          nodes{ id isResolved comments(first:1){ nodes{ databaseId } } }
          pageInfo{ hasNextPage endCursor }
        }
      }
    }
  }`;
  do {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `number=${number}`,
    ];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const res = await ghJson<{
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: { id: string; isResolved: boolean; comments: { nodes: { databaseId: number }[] } }[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        };
      };
    }>(args);
    const rt = res.data.repository.pullRequest.reviewThreads;
    const match = rt.nodes.find((n) => n.comments.nodes[0]?.databaseId === rootCommentId);
    if (match) {
      threadId = match.id;
      break;
    }
    cursor = rt.pageInfo.hasNextPage ? rt.pageInfo.endCursor : null;
  } while (cursor);

  if (!threadId) return false;
  const mutation = `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }`;
  await gh(["api", "graphql", "-f", `query=${mutation}`, "-F", `id=${threadId}`]);
  return true;
}

/** Post a top-level issue-tab comment (used for review summaries / issue comments). */
export async function postIssueComment(
  owner: string,
  repo: string,
  number: number,
  body: string
): Promise<void> {
  await gh([
    "api",
    "--method",
    "POST",
    `repos/${owner}/${repo}/issues/${number}/comments`,
    "-f",
    `body=${body}`,
  ]);
}
