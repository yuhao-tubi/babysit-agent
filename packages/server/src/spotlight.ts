/**
 * Keep macOS Spotlight out of the daemon's disk state.
 *
 * Every poll cycle churns a lot of files under the data dir: base clones fetch,
 * worktrees are created and swept, and a `lightDeps` worktree materializes a
 * `node_modules` tree of tens of thousands of paths. Spotlight watches all of it
 * by default, so `fseventsd` + `mds_stores` spin up to index a tree whose entire
 * lifetime is a few minutes and which the owner can never usefully search. In the
 * observed pathology those two processes together sat at >110% CPU and pushed the
 * machine's load average past 60 while under 25% of the CPU was doing real work —
 * the daemon's own agent runs then starved on disk, and a PR brief that takes a
 * minute idle for the better part of an hour.
 *
 * `.metadata_never_index` at the root of a directory tells Spotlight to skip that
 * whole subtree. It is the documented, per-directory, no-privileges opt-out — no
 * `sudo mdutil`, nothing global, and nothing the owner has to remember to redo.
 *
 * Best-effort by design: a failure here costs performance, never correctness, so
 * it must never keep the daemon from starting.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MARKER = ".metadata_never_index";

/**
 * Write the marker into each distinct root, creating the directory if it does not
 * exist yet (startup runs before the first clone/worktree). Returns the roots
 * newly marked, for the startup log.
 */
export function excludeFromSpotlight(roots: string[]): string[] {
  const marked: string[] = [];
  for (const root of new Set(roots.filter(Boolean))) {
    try {
      const marker = join(root, MARKER);
      if (existsSync(marker)) continue;
      mkdirSync(root, { recursive: true });
      writeFileSync(marker, "");
      marked.push(root);
    } catch {
      // Unwritable path, race with another process — performance only. Skip it.
    }
  }
  return marked;
}

/**
 * The roots worth excluding: the clones, the worktrees, and the CI-log cache.
 * `dbPath` is a file, so its containing directory is what gets marked — which is
 * usually the data dir itself, covering the whole subtree in one marker.
 */
export function spotlightExcludeRoots(cfg: {
  reposRoot: string;
  worktreesRoot: string;
  ciLogsRoot: string;
  dbPath: string;
}): string[] {
  return [dirname(cfg.dbPath), cfg.reposRoot, cfg.worktreesRoot, cfg.ciLogsRoot];
}
