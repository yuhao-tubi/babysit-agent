import { test } from "node:test";
import assert from "node:assert/strict";

const { SerialQueue, withBaseLock, repoQueue, overviewQueue } = await import("./queue.js");

/** A deferred promise + a recorder to observe interleaving. */
function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("repoQueue and overviewQueue are distinct instances", () => {
  assert.notEqual(repoQueue, overviewQueue);
});

test("SerialQueue runs jobs for the same key strictly one at a time", async () => {
  const q = new SerialQueue();
  const order: string[] = [];
  const a = defer();

  const p1 = q.run("k", async () => {
    order.push("a-start");
    await a.promise;
    order.push("a-end");
  });
  const p2 = q.run("k", async () => {
    order.push("b-start");
  });

  // b must not start until a finishes.
  await Promise.resolve();
  assert.deepEqual(order, ["a-start"]);
  a.resolve();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
});

test("SerialQueue lets different keys run concurrently", async () => {
  const q = new SerialQueue();
  const order: string[] = [];
  const a = defer();

  const p1 = q.run("k1", async () => {
    order.push("k1-start");
    await a.promise;
  });
  const p2 = q.run("k2", async () => {
    order.push("k2-start");
  });

  await Promise.resolve();
  // k2 starts even though k1 is still blocked — independent keys don't serialize.
  assert.ok(order.includes("k2-start"), `k2 should have started; got ${order}`);
  a.resolve();
  await Promise.all([p1, p2]);
});

test("SerialQueue survives a throwing job and still runs the next", async () => {
  const q = new SerialQueue();
  const ran: string[] = [];
  const p1 = q.run("k", async () => {
    throw new Error("boom");
  });
  const p2 = q.run("k", async () => {
    ran.push("second");
  });
  await assert.rejects(p1, /boom/);
  await p2;
  assert.deepEqual(ran, ["second"]);
});

test("withBaseLock serializes critical sections for the same repo", async () => {
  const order: string[] = [];
  const a = defer();

  const p1 = withBaseLock("owner/repo", async () => {
    order.push("1-in");
    await a.promise;
    order.push("1-out");
  });
  const p2 = withBaseLock("owner/repo", async () => {
    order.push("2-in");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["1-in"]); // 2 waits for 1 to release
  a.resolve();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["1-in", "1-out", "2-in"]);
});

test("withBaseLock lets different repos proceed concurrently", async () => {
  const order: string[] = [];
  const a = defer();

  const p1 = withBaseLock("owner/repoA", async () => {
    order.push("A-in");
    await a.promise;
  });
  const p2 = withBaseLock("owner/repoB", async () => {
    order.push("B-in");
  });

  await Promise.resolve();
  assert.ok(order.includes("B-in"), `repoB should proceed; got ${order}`);
  a.resolve();
  await Promise.all([p1, p2]);
});

test("withBaseLock releases the lock after a throwing critical section", async () => {
  await assert.rejects(
    withBaseLock("owner/repo2", async () => {
      throw new Error("nope");
    }),
    /nope/
  );
  // A subsequent acquisition must still run (lock not left held).
  let ran = false;
  await withBaseLock("owner/repo2", async () => {
    ran = true;
  });
  assert.ok(ran);
});

// --- bounded concurrency -----------------------------------------------------
// `limit` was added because a repo with 24 queued Threads ran them strictly
// end-to-end: measured wall clock per Thread was 63-78% pure queue waiting (one
// Thread: 2721s of its 3478s) while the machine sat idle. The tests above pin the
// limit-1 contract that anything guarding shared mutable state still relies on;
// these pin the widened behaviour.

test("SerialQueue defaults to limit 1 and rejects a nonsense limit", () => {
  assert.equal(new SerialQueue().activeCount("k"), 0);
  assert.throws(() => new SerialQueue(0), /positive integer/);
  assert.throws(() => new SerialQueue(-1), /positive integer/);
  assert.throws(() => new SerialQueue(1.5), /positive integer/);
});

test("SerialQueue with a limit runs that many at once and holds the rest back", async () => {
  const q = new SerialQueue(3);
  let active = 0;
  let peak = 0;
  const gate = defer();
  const jobs = [1, 2, 3, 4, 5].map(() =>
    q.run("k", async () => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
    })
  );
  // Let every job that can start, start.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(peak, 3, `must not exceed the limit; peaked at ${peak}`);
  gate.resolve();
  await Promise.all(jobs);
  assert.equal(q.activeCount("k"), 0, "every slot must be released");
});

test("SerialQueue hands a freed slot to the next waiter without exceeding the limit", async () => {
  const q = new SerialQueue(2);
  let active = 0;
  let peak = 0;
  const gates = [defer(), defer(), defer()];
  const jobs = gates.map((g) =>
    q.run("k", async () => {
      active++;
      peak = Math.max(peak, active);
      await g.promise;
      active--;
    })
  );
  await Promise.resolve();
  gates[0].resolve(); // frees a slot; the third job takes it
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(peak <= 2, `handover must not transiently exceed the limit; peaked at ${peak}`);
  gates[1].resolve();
  gates[2].resolve();
  await Promise.all(jobs);
  assert.equal(q.activeCount("k"), 0);
});

test("run() returns the job's value to its own caller", async () => {
  const q = new SerialQueue(2);
  assert.equal(await q.run("k", async () => 42), 42);
});
