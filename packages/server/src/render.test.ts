import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderExcalidraw, chromiumAvailable } from "./render.js";

/**
 * Rung 1–2 of the migration acceptance ladder (render-layer verification).
 * These do a REAL headless Chromium render — the renderer is the load-bearing
 * primitive of the Excalidraw pipeline, and it cannot be judged without actually
 * rasterizing. If Chromium isn't installed (`make setup-render`), they skip
 * rather than fail, so CI without a browser stays green.
 */

const PALETTE_CORE = { fill: "#eff6ff", stroke: "#2563eb" };
const PALETTE_AFFECTED = { fill: "#fffbeb", stroke: "#d97706" };

/** A minimal but representative two-box + bound-arrow document. */
function fixtureDoc() {
  return {
    type: "excalidraw",
    version: 2,
    source: "babysit-agent-test",
    elements: [
      {
        type: "rectangle", id: "r1", x: 100, y: 100, width: 200, height: 90,
        strokeColor: PALETTE_CORE.stroke, backgroundColor: PALETTE_CORE.fill,
        fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 0,
        opacity: 100, angle: 0, seed: 101, version: 1, versionNonce: 1,
        isDeleted: false, groupIds: [], boundElements: [{ id: "t1", type: "text" }],
        link: null, locked: false, roundness: { type: 3 },
      },
      {
        type: "text", id: "t1", x: 130, y: 132, width: 140, height: 25,
        text: "resolveQueue", originalText: "resolveQueue", fontSize: 16,
        fontFamily: 3, textAlign: "center", verticalAlign: "middle",
        strokeColor: "#1e3a8a", backgroundColor: "transparent", fillStyle: "solid",
        strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, angle: 0,
        seed: 2, version: 1, versionNonce: 2, isDeleted: false, groupIds: [],
        boundElements: null, link: null, locked: false, containerId: "r1", lineHeight: 1.25,
      },
      {
        type: "rectangle", id: "r2", x: 450, y: 100, width: 200, height: 90,
        strokeColor: PALETTE_AFFECTED.stroke, backgroundColor: PALETTE_AFFECTED.fill,
        fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 0,
        opacity: 100, angle: 0, seed: 102, version: 1, versionNonce: 3,
        isDeleted: false, groupIds: [], boundElements: [{ id: "t2", type: "text" }],
        link: null, locked: false, roundness: { type: 3 },
      },
      {
        type: "text", id: "t2", x: 480, y: 132, width: 140, height: 25,
        text: "mixtapeStore", originalText: "mixtapeStore", fontSize: 16,
        fontFamily: 3, textAlign: "center", verticalAlign: "middle",
        strokeColor: "#92400e", backgroundColor: "transparent", fillStyle: "solid",
        strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, angle: 0,
        seed: 4, version: 1, versionNonce: 4, isDeleted: false, groupIds: [],
        boundElements: null, link: null, locked: false, containerId: "r2", lineHeight: 1.25,
      },
      {
        type: "arrow", id: "a1", x: 305, y: 145, width: 140, height: 0,
        strokeColor: PALETTE_CORE.stroke, backgroundColor: "transparent",
        fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 0,
        opacity: 100, angle: 0, seed: 103, version: 1, versionNonce: 5,
        isDeleted: false, groupIds: [], boundElements: null, link: null, locked: false,
        points: [[0, 0], [140, 0]],
        startBinding: { elementId: "r1", focus: 0, gap: 5 },
        endBinding: { elementId: "r2", focus: 0, gap: 5 },
        startArrowhead: null, endArrowhead: "arrow",
      },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

let dir: string;
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), "render-test-"));
});
test.after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("Rung 1: renders a valid .excalidraw to a non-empty PNG", async (t) => {
  if (!(await chromiumAvailable())) return t.skip("Chromium not installed (run `make setup-render`)");
  const file = join(dir, "ok.excalidraw");
  writeFileSync(file, JSON.stringify(fixtureDoc()));
  const r = await renderExcalidraw(file);
  assert.ok(existsSync(r.pngPath), "PNG written");
  assert.ok(statSync(r.pngPath).size > 1000, "PNG is non-trivial");
  assert.ok(r.width > 0 && r.height > 0, "reported dimensions");
});

test("Rung 2: round-trips the same doc the frontend would load", async (t) => {
  if (!(await chromiumAvailable())) return t.skip("Chromium not installed");
  // The doc our Save route stores / the Excalidraw component loads is exactly a
  // {type,elements,appState,files} object — render it as-is and confirm success.
  const file = join(dir, "roundtrip.excalidraw");
  writeFileSync(file, JSON.stringify(fixtureDoc()));
  const r = await renderExcalidraw(file);
  assert.ok(statSync(r.pngPath).size > 1000);
});

test("rejects invalid JSON", async (t) => {
  if (!(await chromiumAvailable())) return t.skip("Chromium not installed");
  const file = join(dir, "bad.excalidraw");
  writeFileSync(file, "{ not valid json ");
  await assert.rejects(() => renderExcalidraw(file), /Invalid JSON/);
});

test("rejects a non-excalidraw / empty-elements document", async (t) => {
  if (!(await chromiumAvailable())) return t.skip("Chromium not installed");
  const file = join(dir, "empty.excalidraw");
  writeFileSync(file, JSON.stringify({ type: "excalidraw", elements: [] }));
  await assert.rejects(() => renderExcalidraw(file), /empty|Invalid Excalidraw/);
});
