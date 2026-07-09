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

/** Whether this author's feedback should be skipped entirely (your own). */
export function isOwnAuthor(login: string): boolean {
  const cfg = loadConfig();
  return login.toLowerCase() === cfg.githubLogin.toLowerCase();
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
