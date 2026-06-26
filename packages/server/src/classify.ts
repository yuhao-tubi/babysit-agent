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
 * Whether a repo is on the ignore list. An entry containing "/" matches
 * owner/repo exactly; a bare entry matches the repo name under any owner.
 */
export function isIgnoredRepo(owner: string, repo: string): boolean {
  const cfg = loadConfig();
  const full = `${owner}/${repo}`.toLowerCase();
  const name = repo.toLowerCase();
  return cfg.ignoreRepos.some((e) => {
    const entry = e.toLowerCase();
    return entry.includes("/") ? entry === full : entry === name;
  });
}
