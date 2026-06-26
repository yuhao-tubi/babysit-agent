import { loadConfig } from "./config.js";
import { getDb } from "./db.js";
import { startPoller } from "./poller.js";
import { startProcessor } from "./processor.js";
import { startServer } from "./api.js";

async function main() {
  const cfg = loadConfig();
  getDb(); // init + migrate
  console.log(
    `[babysit] starting — login=${cfg.githubLogin} dryRun=${cfg.dryRun} poll=${cfg.pollIntervalMs}ms`
  );

  await startServer(cfg.port);
  console.log(`[babysit] dashboard API on http://localhost:${cfg.port}`);

  startProcessor(); // drains pending threads through verdict→action
  startPoller();

  console.log("[babysit] running. Ctrl-C to stop.");
}

main().catch((err) => {
  console.error("[babysit] fatal:", err);
  process.exit(1);
});
