/**
 * Read-only verification CLI for Phase 2/3.
 *   tsx src/cli.ts list-prs    — list authored open PRs
 *   tsx src/cli.ts poll-once   — run one poll cycle, upsert threads, print summary
 *   tsx src/cli.ts threads     — dump threads table
 *   tsx src/cli.ts verdict <id> — run the verdict engine on one thread (no actions)
 */
import "./env.js"; // load .env before anything reads process.env
import { listAuthoredPrs } from "./gh.js";
import { pollOnce } from "./poller.js";
import { getThread, getThreadItems, listThreads, updateThread } from "./db.js";
import { runVerdict } from "./verdict.js";
import { generateOverview } from "./overview.js";
import { getPrOverview } from "./db.js";
import { runGate } from "./gate.js";
import { clonePath } from "./worktrees.js";
import { processThread } from "./processor.js";
import { getEvents } from "./db.js";

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "list-prs": {
      const prs = await listAuthoredPrs();
      for (const p of prs) console.log(`${p.owner}/${p.repo}#${p.number}  ${p.title}`);
      console.log(`\n${prs.length} open PR(s).`);
      break;
    }
    case "poll-once": {
      const r = await pollOnce();
      console.log(`Checked ${r.prsChecked} PRs; ${r.newThreads.length} new/reopened thread(s): ${r.newThreads.join(", ")}`);
      break;
    }
    case "threads": {
      for (const s of listThreads()) {
        console.log(
          `#${s.id} [${s.status}] ${s.prKey} ${s.authorClass} thread=${s.threadKey} attempts=${s.attemptCount}` +
            (s.verdictJson ? ` verdict=${JSON.parse(s.verdictJson).action}` : "")
        );
      }
      break;
    }
    case "verdict": {
      const id = Number(process.argv[3]);
      const s = getThread(id);
      if (!s) throw new Error(`no thread #${id}`);
      const items = getThreadItems(id);
      const v = await runVerdict(s, items);
      console.log(JSON.stringify(v, null, 2));
      updateThread(id, { verdict: v });
      break;
    }
    case "retry-errors": {
      // Reset errored + stuck in_progress threads to pending so the processor reruns them.
      // (in_progress with no live daemon is stale — it will never finalize on its own.)
      const stuck = [...listThreads("error"), ...listThreads("in_progress")];
      for (const s of stuck) {
        updateThread(s.id, { status: "pending", error: null });
        console.log(`reset #${s.id} [${s.status}] ${s.prKey} ${s.threadKey} -> pending`);
      }
      console.log(`\n${stuck.length} thread(s) reset to pending.`);
      break;
    }
    case "process": {
      // Run ONE thread through the full verdict→gate→executor chain and exit.
      // Honors dryRun (no push when true). Resets the thread to pending first so
      // a stale error/in_progress row is re-runnable.
      const id = Number(process.argv[3]);
      const s = getThread(id);
      if (!s) throw new Error(`no thread #${id}`);
      if (s.status !== "pending") {
        updateThread(id, { status: "pending", error: null });
        console.log(`reset #${id} [${s.status}] -> pending`);
      }
      await processThread(id);
      const final = getThread(id);
      console.log(`\n#${id} final status: ${final?.status}`);
      console.log("--- events ---");
      for (const e of getEvents(id)) console.log(`  ${e.at}  ${e.kind}: ${e.message.slice(0, 200)}`);
      break;
    }
    case "overview": {
      // Read-only PR-level overview + diagram generation. The PR must already
      // be in the DB (run poll-once first). Writes the SVG + prints the overview.
      const prKey = process.argv[3];
      if (!prKey) throw new Error("usage: cli.ts overview <owner/repo#number>");
      if (!getPrOverview(prKey)) throw new Error(`no PR ${prKey} in db — run poll-once first`);
      const r = await generateOverview(prKey);
      console.log(`status: ${r.status}  head: ${r.headSha}  svg: ${r.svg ? "yes" : "none"}`);
      console.log("--- overview ---");
      console.log(r.overviewMd);
      const saved = getPrOverview(prKey);
      if (saved?.diagramPath) console.log(`\ndiagram: ${saved.diagramPath}`);
      break;
    }
    case "gate": {
      const owner = "adRise";
      const repo = process.argv[3];
      const r = await runGate(clonePath(owner, repo), repo);
      console.log(`ran=${r.ran} passed=${r.passed}`);
      console.log(r.detail.slice(0, 800));
      break;
    }
    default:
      console.error("usage: cli.ts <list-prs|poll-once|threads|verdict <id>|overview <prKey>|process <id>|retry-errors|gate <repo>>");
      process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
