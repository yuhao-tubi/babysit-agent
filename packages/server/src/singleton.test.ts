import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { acquireInstanceLock } from "./singleton.js";

function tmpLock(): string {
  return join(mkdtempSync(join(tmpdir(), "babysit-lock-")), "state.db.daemon.lock");
}

test("acquires a free lock and stamps our pid", () => {
  const path = tmpLock();
  const lock = acquireInstanceLock(path);
  assert.equal(readFileSync(path, "utf8").trim(), String(process.pid));
  lock.release();
  assert.equal(existsSync(path), false);
});

test("refuses to start when a LIVE daemon holds the lock", () => {
  const path = tmpLock();
  // A different live pid: our own parent is alive and is not us.
  writeFileSync(path, `${process.ppid}\n`);
  assert.throws(() => acquireInstanceLock(path, { waitMs: 0 }), /already running/);
  // The other daemon's pidfile must survive a rejected start.
  assert.equal(readFileSync(path, "utf8").trim(), String(process.ppid));
});

test("reclaims a stale pidfile left by a killed daemon", () => {
  const path = tmpLock();
  writeFileSync(path, "2147483646\n"); // pid that cannot exist
  const lock = acquireInstanceLock(path);
  assert.equal(readFileSync(path, "utf8").trim(), String(process.pid));
  lock.release();
});

test("release is a no-op once another daemon has reclaimed the file", () => {
  const path = tmpLock();
  const lock = acquireInstanceLock(path);
  writeFileSync(path, "12345\n"); // pretend a later daemon took over
  lock.release();
  assert.equal(readFileSync(path, "utf8").trim(), "12345");
});

test("waits out a handoff: acquires once the outgoing holder's pid is gone", () => {
  const path = tmpLock();
  // A real short-lived process stands in for the outgoing daemon: alive when we
  // start waiting, gone ~1s later. It must NOT be our own child — an unreaped
  // child stays a zombie while we block, and `kill(pid, 0)` still sees a zombie.
  // So double-fork it (the intermediate shell exits, reparenting sleep to init).
  const outgoing = Number(
    execFileSync("sh", ["-c", "nohup sleep 1 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim()
  );
  writeFileSync(path, `${outgoing}\n`);
  const t0 = Date.now();
  const lock = acquireInstanceLock(path, { waitMs: 5_000 });
  assert.ok(Date.now() - t0 >= 500, "should have waited for the handoff");
  assert.equal(readFileSync(path, "utf8").trim(), String(process.pid));
  lock.release();
});
