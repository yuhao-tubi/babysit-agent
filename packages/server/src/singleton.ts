import { openSync, closeSync, writeSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Single-instance guard for the daemon.
 *
 * The base clones' git operations are serialized by `withBaseLock`, but that is an
 * IN-PROCESS mutex — it cannot coordinate two daemons started against the same
 * data dir (e.g. the launchd agent plus a leftover `npm run dev:server`). Two
 * daemons run `sweepWorktrees` / `ensureBase` on the SAME base clone at once and
 * collide on git's own ref locks, which surfaces on a Thread as
 * `cannot lock ref 'HEAD': Unable to create '.../.git/HEAD.lock': File exists`
 * and parks it at `error`. Worse, a duplicate daemon is a second writer to
 * `state.db` and a second actor on GitHub — it could push or post twice.
 *
 * A duplicate is easy to create by accident and hard to notice: `tsx watch`
 * survives its child's exit, so a losing daemon whose `startServer` dies on
 * EADDRINUSE leaves a watcher that keeps respawning children — each one running
 * the startup git sweep before it dies on the port.
 *
 * So we take an exclusive pidfile lock BEFORE touching the db or any clone. A
 * pidfile left by a killed daemon is not a lock: if its pid is gone we reclaim
 * it, so a crash never wedges startup.
 */
export interface InstanceLock {
  path: string;
  release(): void;
}

/** True if a process with this pid exists (signal 0 probes without delivering). */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still a live process.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Block the thread briefly. Startup is strictly sequential here, so this is fine. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Claim the daemon lock at `path`, or throw if another live daemon holds it.
 * Registers release on normal exit and on SIGINT/SIGTERM.
 */
export function acquireInstanceLock(path: string, opts: { waitMs?: number } = {}): InstanceLock {
  mkdirSync(dirname(path), { recursive: true });

  // A restart is a HANDOFF, not a duplicate: `tsx watch` (and launchd kickstart)
  // starts the replacement while the outgoing daemon is still shutting down —
  // which can take seconds if it is mid-agent-run. Failing instantly there would
  // turn every reload into a dead daemon, so wait briefly for the holder to go.
  const deadline = Date.now() + (opts.waitMs ?? 20_000);

  let fd: number | undefined;
  for (;;) {
    try {
      fd = openSync(path, "wx"); // exclusive create — fails if the file exists
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const holder = Number(readFileSync(path, "utf8").trim().split("\n")[0]);
    if (!alive(holder) || holder === process.pid) {
      rmSync(path, { force: true }); // stale pidfile from a killed daemon
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `another babysit daemon is already running (pid ${holder}) on this data dir.\n` +
          `  Stop it first (\`make stop\`, or \`kill ${holder}\`), or remove ${path} if you\n` +
          `  are sure that pid is not a daemon. Two daemons corrupt each other's git clones and\n` +
          `  can act twice on GitHub.`
      );
    }
    sleepSync(250);
  }

  writeSync(fd, `${process.pid}\n`);
  closeSync(fd);

  let released = false;
  const lock: InstanceLock = {
    path,
    release() {
      if (released) return;
      released = true;
      // Only drop the file if it is still OURS (a reclaim by a later daemon
      // must not be deleted by this one's late exit handler).
      try {
        if (Number(readFileSync(path, "utf8").trim()) !== process.pid) return;
      } catch {
        return; // already gone
      }
      rmSync(path, { force: true });
    },
  };

  process.on("exit", () => lock.release());
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      lock.release();
      process.exit(0);
    });
  }
  return lock;
}
