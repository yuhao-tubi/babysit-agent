/**
 * Read-only verification CLI for Phase 2/3.
 *   tsx src/cli.ts list-prs    — list authored open PRs
 *   tsx src/cli.ts poll-once   — run one poll cycle, upsert threads, print summary
 *   tsx src/cli.ts threads     — dump threads table
 *   tsx src/cli.ts verdict <id> — run the verdict engine on one thread (no actions)
 */
import { listAuthoredPrs } from "./gh.js";
import { pollOnce } from "./poller.js";
import { getThread, getThreadItems, listThreads, updateThread } from "./db.js";
import { runVerdict } from "./verdict.js";
import { runGate } from "./gate.js";
import { clonePath } from "./worktrees.js";

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
    case "gate": {
      const owner = "adRise";
      const repo = process.argv[3];
      const r = await runGate(clonePath(owner, repo), repo);
      console.log(`ran=${r.ran} passed=${r.passed}`);
      console.log(r.detail.slice(0, 800));
      break;
    }
    default:
      console.error("usage: cli.ts <list-prs|poll-once|threads|verdict <id>|gate <repo>>");
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
