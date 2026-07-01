import "./env.js"; // load .env before anything reads process.env
import { loadConfig } from "./config.js";
import { getDb, failStuckOverviews } from "./db.js";
import { startPoller } from "./poller.js";
import { recoverInterrupted, startProcessor } from "./processor.js";
import { startServer } from "./api.js";
import { sweepWorktrees } from "./worktrees.js";

async function main() {
  const cfg = loadConfig();
  getDb(); // init + migrate
  console.log(
    `[babysit] starting — login=${cfg.githubLogin} dryRun=${cfg.dryRun} poll=${cfg.pollIntervalMs}ms`
  );

  // Recover orphaned worktrees from a prior crash/kill. Nothing is executing
  // immediately after a restart, so every worktree is residue — sweep them all.
  // recoverInterrupted() re-creates a fresh worktree for any thread it re-drives.
  await sweepWorktrees(new Set()).catch((err) =>
    console.warn("[babysit] worktree sweep failed:", err?.message ?? err)
  );

  // An overview left `generating` by a crash owes GitHub nothing, so it is not
  // auto-resumed — just reset to `failed` for the owner to re-trigger.
  const reset = failStuckOverviews();
  if (reset.length) console.log(`[babysit] reset ${reset.length} stuck overview(s) to failed`);

  await startServer(cfg.port);
  console.log(`[babysit] dashboard API on http://localhost:${cfg.port}`);

  startProcessor(); // drains pending threads through verdict→action
  recoverInterrupted(); // re-drives threads left in_progress by a prior crash/restart
  startPoller();

  console.log("[babysit] running. Ctrl-C to stop.");
}

main().catch((err) => {
  console.error("[babysit] fatal:", err);
  process.exit(1);
});
