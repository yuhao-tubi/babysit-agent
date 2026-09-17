import { test } from "node:test";
import assert from "node:assert/strict";

const { buildStacks, stackContextFor } = await import("./stacks.js");
type Input = Parameters<typeof buildStacks>[0][number];

/** A PR in `adRise/www` with the given number, head and base. */
function pr(number: number, headRef: string, baseRef: string | null): Input {
  return { prKey: `adRise/www#${number}`, owner: "adRise", repo: "www", number, headRef, baseRef };
}

/** The same, with the title `stackContextFor` also needs. */
function layer(number: number, headRef: string, baseRef: string | null) {
  return { ...pr(number, headRef, baseRef), title: `PR ${number}` };
}

test("a plain 3-chain is one stack, labelled bottom-up", () => {
  const s = buildStacks([
    pr(3, "c", "b"),
    pr(1, "a", "master"),
    pr(2, "b", "a"),
  ]);
  assert.equal(s.size, 3);
  const a = s.get("adRise/www#1")!;
  const b = s.get("adRise/www#2")!;
  const c = s.get("adRise/www#3")!;
  assert.equal(a.rootKey, "adRise/www#1");
  assert.equal(a.rootBaseRef, "master");
  assert.deepEqual([a.depth, b.depth, c.depth], [1, 2, 3]);
  assert.deepEqual([a.order, b.order, c.order], [0, 1, 2]);
  assert.deepEqual(
    [a.parentPrKey, b.parentPrKey, c.parentPrKey],
    [null, "adRise/www#1", "adRise/www#2"]
  );
  // Every member reports the same group identity and base.
  assert.deepEqual([b.rootKey, c.rootKey], [a.rootKey, a.rootKey]);
});

test("PRs that merely share a base branch are not a stack", () => {
  const s = buildStacks([pr(1, "a", "master"), pr(2, "b", "master")]);
  assert.equal(s.size, 0);
});

test("a standalone PR is absent from the map", () => {
  const s = buildStacks([pr(1, "a", "master"), pr(2, "b", "a"), pr(9, "z", "master")]);
  assert.equal(s.has("adRise/www#9"), false);
  assert.equal(s.size, 2);
});

test("a fork keeps each branch contiguous and depth stays truthful", () => {
  // #1 -> #2 -> #3, and #1 -> #4 (two PRs both cut off branch "a").
  const s = buildStacks([
    pr(1, "a", "master"),
    pr(2, "b", "a"),
    pr(3, "c", "b"),
    pr(4, "d", "a"),
  ]);
  assert.equal(s.size, 4);
  const order = [...s.entries()]
    .sort((x, y) => x[1].order - y[1].order)
    .map(([k, v]) => [k, v.depth]);
  assert.deepEqual(order, [
    ["adRise/www#1", 1],
    ["adRise/www#2", 2],
    ["adRise/www#3", 3],
    ["adRise/www#4", 2],
  ]);
});

test("a merged middle PR splits the chain rather than breaking grouping", () => {
  // #2 merged, so it is expired and never passed in. #3's base "b" now resolves
  // to nothing, making it the root of its own (single) chain.
  const s = buildStacks([pr(1, "a", "master"), pr(3, "c", "b"), pr(4, "d", "c")]);
  assert.equal(s.has("adRise/www#1"), false); // orphaned bottom, now standalone
  assert.equal(s.get("adRise/www#3")!.rootKey, "adRise/www#3");
  assert.equal(s.get("adRise/www#3")!.rootBaseRef, "b");
  assert.equal(s.get("adRise/www#4")!.depth, 2);
});

test("branches in different repos never chain together", () => {
  const s = buildStacks([
    pr(1, "a", "master"),
    { prKey: "adRise/api#7", owner: "adRise", repo: "api", number: 7, headRef: "b", baseRef: "a" },
  ]);
  assert.equal(s.size, 0);
});

test("a cycle is dropped instead of walked forever", () => {
  // a <- b <- a: neither PR has a missing parent, so no walk ever starts.
  const s = buildStacks([pr(1, "a", "b"), pr(2, "b", "a")]);
  assert.equal(s.size, 0);
});

test("a PR based on its own head is treated as a root", () => {
  const s = buildStacks([pr(1, "a", "a"), pr(2, "b", "a")]);
  assert.equal(s.get("adRise/www#1")!.depth, 1);
  assert.equal(s.get("adRise/www#2")!.parentPrKey, "adRise/www#1");
});

test("a null baseRef (row polled before base_ref existed) is a root, never a link", () => {
  const s = buildStacks([pr(1, "a", null), pr(2, "b", null)]);
  assert.equal(s.size, 0);
});

// ---- stackContextFor (the Verdict's view) ----

test("the middle layer sees the one below it and the one above it", () => {
  const prs = [layer(1, "a", "master"), layer(2, "b", "a"), layer(3, "c", "b")];
  const ctx = stackContextFor("adRise/www#2", prs)!;
  assert.equal(ctx.layers.length, 3);
  assert.deepEqual(
    ctx.layers.map((l) => [l.number, l.position]),
    [[1, "below"], [2, "self"], [3, "above"]]
  );
  // Its own diff is measured against the layer below; the stack's against the trunk.
  assert.equal(ctx.parentRef, "a");
  assert.equal(ctx.rootBaseRef, "master");
});

test("the bottom layer measures its own diff against the trunk", () => {
  const ctx = stackContextFor("adRise/www#1", [layer(1, "a", "master"), layer(2, "b", "a")])!;
  assert.equal(ctx.parentRef, "master");
  assert.deepEqual(
    ctx.layers.map((l) => l.position),
    ["self", "above"]
  );
});

test("every layer above is 'above', not just the direct child", () => {
  const prs = [layer(1, "a", "master"), layer(2, "b", "a"), layer(3, "c", "b"), layer(4, "d", "c")];
  const ctx = stackContextFor("adRise/www#2", prs)!;
  assert.deepEqual(
    ctx.layers.map((l) => [l.number, l.position]),
    [[1, "below"], [2, "self"], [3, "above"], [4, "above"]]
  );
});

test("the other arm of a fork is 'aside' — neither in the checkout nor downstream", () => {
  // #1 -> #2, and #1 -> #3: #3 is a sibling of #2, not above it.
  const prs = [layer(1, "a", "master"), layer(2, "b", "a"), layer(3, "c", "a")];
  const ctx = stackContextFor("adRise/www#2", prs)!;
  assert.deepEqual(
    ctx.layers.map((l) => [l.number, l.position]),
    [[1, "below"], [2, "self"], [3, "aside"]]
  );
});

test("a standalone PR has no stack context at all", () => {
  const prs = [layer(1, "a", "master"), layer(9, "z", "master")];
  assert.equal(stackContextFor("adRise/www#9", prs), null);
});

test("a stack in another repo is never mixed in", () => {
  const other = {
    prKey: "adRise/api#7",
    owner: "adRise",
    repo: "api",
    number: 7,
    headRef: "b",
    baseRef: "a",
    title: "API PR",
  };
  const ctx = stackContextFor("adRise/www#2", [layer(1, "a", "master"), layer(2, "b", "a"), other])!;
  assert.deepEqual(ctx.layers.map((l) => l.prKey), ["adRise/www#1", "adRise/www#2"]);
});
