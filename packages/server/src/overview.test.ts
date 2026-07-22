import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFromWorktree } from "./overview.js";

/**
 * The secondary tested seam (issue #1 Testing Decisions): given a worktree dir of
 * per-section `.svg` files + the prose manifest, `collectFromWorktree` produces
 * the section-keyed DiagramSet, SANITIZES each SVG, and drops/flags the ones that
 * fail. Prior art: db.test.ts (temp-dir/file-based assertions).
 */

const OK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">' +
  '<rect x="10" y="10" width="80" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/>' +
  "</svg>";

function makeWorktree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "overview-collect-"));
  mkdirSync(join(dir, "overview"), { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    writeFileSync(join(dir, "overview", rel), contents);
  }
  return dir;
}

const manifest = (sections: string[]) =>
  JSON.stringify({ summary: "does a thing", overview_md: "## Why\nx\n## What\ny\n## How\nz", sections });

test("returns null when the manifest is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "overview-collect-"));
  try {
    assert.equal(collectFromWorktree(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null when overview_md is empty/whitespace", () => {
  const dir = makeWorktree({
    "overview.json": JSON.stringify({ summary: "s", overview_md: "   ", sections: [] }),
  });
  try {
    assert.equal(collectFromWorktree(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collects a valid section svg into the diagram set (sanitized)", () => {
  const dir = makeWorktree({ "overview.json": manifest(["why"]), "why.svg": OK_SVG });
  try {
    const r = collectFromWorktree(dir);
    assert.ok(r);
    assert.equal(r!.summary, "does a thing");
    assert.ok(r!.diagrams.why, "why diagram present");
    assert.match(r!.diagrams.why!.svg, /^<svg/);
    assert.deepEqual(r!.invalid, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("picks up a section svg present on disk even if the manifest omits it", () => {
  // Manifest declares only "why", but a valid how.svg is on disk — collect it.
  const dir = makeWorktree({
    "overview.json": manifest(["why"]),
    "why.svg": OK_SVG,
    "how.svg": OK_SVG,
  });
  try {
    const r = collectFromWorktree(dir);
    assert.ok(r!.diagrams.why);
    assert.ok(r!.diagrams.how, "how picked up despite manifest omission");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing section svg is simply absent (graceful degradation, no invalid entry)", () => {
  const dir = makeWorktree({ "overview.json": manifest(["why", "what"]), "why.svg": OK_SVG });
  try {
    const r = collectFromWorktree(dir);
    assert.ok(r!.diagrams.why);
    assert.equal(r!.diagrams.what, undefined);
    assert.deepEqual(r!.invalid, [], "a never-written section is not 'invalid', just absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unsafe/malformed section svg is dropped and reported in `invalid` (drives the repair retry)", () => {
  const dir = makeWorktree({
    "overview.json": manifest(["why", "what"]),
    "why.svg": OK_SVG,
    // Missing viewBox → rejected by sanitizeSvg.
    "what.svg": '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="4" height="4"/></svg>',
  });
  try {
    const r = collectFromWorktree(dir);
    assert.ok(r!.diagrams.why, "valid section kept");
    assert.equal(r!.diagrams.what, undefined, "invalid section dropped from diagrams");
    assert.equal(r!.invalid.length, 1);
    assert.equal(r!.invalid[0].section, "what");
    assert.ok(r!.invalid[0].errors.length > 0, "concrete errors carried for the repair prompt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a <script>-laced svg is sanitized and kept (script stripped), not reported invalid", () => {
  const dir = makeWorktree({
    "overview.json": manifest(["why"]),
    "why.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<script>alert(1)</script><rect x="1" y="1" width="4" height="4"/></svg>',
  });
  try {
    const r = collectFromWorktree(dir);
    assert.ok(r!.diagrams.why, "sanitizable svg is kept");
    assert.doesNotMatch(r!.diagrams.why!.svg, /<script/i);
    assert.deepEqual(r!.invalid, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
