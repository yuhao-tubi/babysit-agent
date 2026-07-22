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
import { generateBlindSpots } from "./risks.js";
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
      // Read-only PR-level overview + diagram-set generation. The PR must already
      // be in the DB (run poll-once first). Prints the overview + diagram set.
      const prKey = process.argv[3];
      if (!prKey) throw new Error("usage: cli.ts overview <owner/repo#number>");
      if (!getPrOverview(prKey)) throw new Error(`no PR ${prKey} in db — run poll-once first`);
      const r = await generateOverview(prKey);
      const sections = Object.keys(r.diagrams);
      console.log(
        `status: ${r.status}  head: ${r.headSha}  diagrams: ${sections.length} [${sections.join(", ")}]`
      );
      console.log("--- overview ---");
      console.log(r.overviewMd);
      for (const [section, doc] of Object.entries(r.diagrams)) {
        console.log(`\n[${section}] svg diagram — ${doc?.svg.length ?? 0} bytes`);
      }
      if (r.risksStatus != null) printRisks(r.risksStatus, r.risks ?? []);
      break;
    }
    case "analyze-risks": {
      // Reviewer-role Verified Risk Analysis. Runs the SAME generation chain
      // (overview → finder → confirmer) and prints the merged risk artifact.
      // Read-only w.r.t. GitHub. The PR must be in the DB with role=reviewer.
      const prKey = process.argv[3];
      if (!prKey) throw new Error("usage: cli.ts analyze-risks <owner/repo#number>");
      const pr = getPrOverview(prKey);
      if (!pr) throw new Error(`no PR ${prKey} in db — run poll-once first`);
      if (pr.role !== "reviewer") {
        console.warn(`note: ${prKey} role=${pr.role} — risk analysis only runs for reviewer PRs`);
      }
      const r = await generateOverview(prKey);
      console.log(`overview status: ${r.status}  head: ${r.headSha}`);
      printRisks(r.risksStatus ?? null, r.risks ?? []);
      break;
    }
    case "blindspots": {
      // Author-role Blind-spot analysis (CONTEXT.md). Runs the same on-demand
      // engine the dashboard's POST /blindspots uses: `generateBlindSpots`
      // provisions its own read-only skipDeps worktree, runs the finder→confirmer
      // in "author" mode with the PR body as an advisory lens, and PERSISTS the
      // artifact + head sha. Read-only w.r.t. GitHub. PR must be in the DB
      // (run poll-once). The CLI just prints what was persisted.
      const prKey = process.argv[3];
      if (!prKey) throw new Error("usage: cli.ts blindspots <owner/repo#number>");
      if (!getPrOverview(prKey)) throw new Error(`no PR ${prKey} in db — run poll-once first`);
      const r = await generateBlindSpots(prKey);
      console.log(`blind-spot status: ${r.status}  head: ${r.headSha}`);
      printRisks(r.status, r.risks);
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
      console.error("usage: cli.ts <list-prs|poll-once|threads|verdict <id>|overview <prKey>|analyze-risks <prKey>|process <id>|retry-errors|gate <repo>>");
      process.exit(1);
  }
}

/** Pretty-print the merged risk artifact for the CLI verbs. */
function printRisks(status: "generating" | "ready" | "failed" | null, risks: { title: string; level: string; state: string; layer?: string; inDescription?: boolean; location: { path: string; startLine: number }; verdict?: { rationale: string } }[]): void {
  console.log(`\n--- risks (${status ?? "n/a"}) — ${risks.length} item(s) ---`);
  for (const r of risks) {
    const layer = r.layer ? `{${r.layer}} ` : "";
    const notInDesc = r.inDescription === false ? " ⚠ not-in-description" : "";
    console.log(`  [${r.level.toUpperCase()}] (${r.state}) ${layer}${r.title}  @ ${r.location.path}:${r.location.startLine}${notInDesc}`);
    if (r.verdict?.rationale) console.log(`      ↳ ${r.verdict.rationale.slice(0, 160)}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
