import { loadConfig } from "./config.js";
import type { AuthorClass } from "./types.js";

/**
 * Deterministic author classification (plan decision #5):
 *   isBot = user.type == "Bot" || login ∈ config.botLogins
 * No LLM guessing — the bot/human branch drives the whole reply policy.
 */
export function classifyAuthor(login: string, userType: string): AuthorClass {
  const cfg = loadConfig();
  if (userType === "Bot") return "bot";
  const lower = login.toLowerCase();
  if (cfg.botLogins.some((b) => b.toLowerCase() === lower)) return "bot";
  // Heuristic backstop: GitHub App logins end with "[bot]".
  if (lower.endsWith("[bot]")) return "bot";
  return "human";
}

/** Whether this login is the owner's (the agent posts under it too). */
export function isOwnAuthor(login: string): boolean {
  const cfg = loadConfig();
  return login.toLowerCase() === cfg.githubLogin.toLowerCase();
}

/**
 * Invisible marker appended to every comment the AGENT posts. There is no
 * separate bot identity — the agent writes through the owner's `gh` login — so
 * `isOwnAuthor` cannot tell an agent ack ("Fixed in abc123") from a note the
 * owner typed by hand. Since a self-rooted thread is now triaged like any other,
 * that distinction is load-bearing: an owner note is INPUT (triage it), while an
 * agent ack is OUTPUT (never re-triage it, or the agent answers itself forever —
 * a top-level ack posts as a NEW comment id, hence a new thread_key, so neither
 * the new-activity check nor the per-threadKey attempt guard would catch it).
 * Rendered as an HTML comment so GitHub hides it from the rendered body.
 */
export const AGENT_MARKER = "<!-- babysit-agent -->";

/** Append the agent marker to a comment body about to be posted. */
export function markAgentAuthored(body: string): string {
  return isAgentAuthored(body) ? body : `${body}\n\n${AGENT_MARKER}`;
}

/** Whether a comment body was posted by the agent (carries the marker). */
export function isAgentAuthored(body: string | null | undefined): boolean {
  return !!body?.includes(AGENT_MARKER);
}

/**
 * Acks the agent posted BEFORE `AGENT_MARKER` existed carry no marker, so they
 * are indistinguishable from an owner-typed note by content alone. Treat any
 * self-authored comment written before this instant as agent output: on the
 * marker's release date the agent had posted many acks and the owner had posted
 * relatively few hand notes, so mis-filing a legacy note as agent output (it just
 * doesn't re-open a thread) is far cheaper than the reverse (the agent answering
 * its own ack forever — see the ratchet in poller.ts).
 *
 * Only a BACKSTOP for legacy rows: every comment posted from now on is marked, so
 * this predicate stops mattering as history rolls forward. Do not extend it.
 */
const MARKER_RELEASED_AT = Date.parse("2026-08-05T00:00:00Z");

/** Whether a self-authored comment predates the agent marker (so can't be judged by it). */
export function predatesAgentMarker(createdAt: string | null | undefined): boolean {
  if (!createdAt) return false; // no timestamp (e.g. synthetic CI item) → not legacy
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && t < MARKER_RELEASED_AT;
}

/**
 * Whether an author's feedback is ignored entirely (`ignoreAuthors` config):
 * never triaged, no Verdict — the Thread is marked resolved directly. Matches
 * case-insensitively on the login with or without a trailing "[bot]" suffix, so
 * a bare `github-actions` entry catches the `github-actions[bot]` login.
 */
export function isIgnoredAuthor(login: string): boolean {
  const cfg = loadConfig();
  const bare = (s: string) => s.toLowerCase().replace(/\[bot\]$/, "");
  const target = bare(login);
  return cfg.ignoreAuthors.some((a) => bare(a) === target);
}

function repoMatches(owner: string, repo: string, entries: string[]): boolean {
  const full = `${owner}/${repo}`.toLowerCase();
  const name = repo.toLowerCase();
  return entries.some((e) => {
    const entry = e.toLowerCase();
    return entry.includes("/") ? entry === full : entry === name;
  });
}

/**
 * Whether a repo is skipped. A repo is skipped if it is on the ignore list, or
 * if an allow-list is configured and the repo is not on it. List entries with
 * "/" match owner/repo exactly; bare entries match the repo name (any owner).
 */
export function isIgnoredRepo(owner: string, repo: string): boolean {
  const cfg = loadConfig();
  if (cfg.allowRepos.length && !repoMatches(owner, repo, cfg.allowRepos)) return true;
  return repoMatches(owner, repo, cfg.ignoreRepos);
}

/** Whether CI babysitting is enabled for this repo (decision Q24). */
export function isCiEnabledRepo(owner: string, repo: string): boolean {
  const cfg = loadConfig();
  return repoMatches(owner, repo, cfg.ci.enabledRepos);
}
