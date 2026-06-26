import notifier from "node-notifier";
import { loadConfig } from "./config.js";
import { emit } from "./events.js";
import { logEvent, listThreads } from "./db.js";

// De-dupe banners per PR: one PR may escalate several threads in a cycle.
const notifiedPrs = new Set<string>();

/**
 * Fire a clickable macOS notification for an escalated thread, coalesced per PR.
 * The banner reflects how many threads on the PR currently need you and
 * deep-links to the PR node in the dashboard.
 */
export function notifyEscalation(threadId: number, prKey: string, message: string): void {
  emit({ type: "notification", prKey, threadId, message });
  logEvent(threadId, "notification", message);
  if (notifiedPrs.has(prKey)) return;
  notifiedPrs.add(prKey);

  const cfg = loadConfig();
  const url = `http://localhost:${cfg.port}/#/pr/${encodeURIComponent(prKey)}`;

  const needsYou = listThreads("blocked").filter((t) => t.prKey === prKey).length;
  const summary =
    needsYou > 1 ? `${needsYou} threads need you on ${prKey}` : message;

  notifier.notify(
    {
      title: `PR Babysitter: ${prKey}`,
      message: summary,
      open: url, // clicking the banner opens the PR in the dashboard
      sound: true,
      wait: false,
    },
    (err) => {
      if (err) console.error("[notify] failed:", err.message);
    }
  );
}

/** Allow a PR to notify again (e.g. after you clear its blocked threads). */
export function clearNotified(prKey: string): void {
  notifiedPrs.delete(prKey);
}
