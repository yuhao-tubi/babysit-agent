import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate the vendored overview authoring assets dir (`overview-assets/`), which
 * holds the SVG authoring skill docs (svg-methodology.md / svg-templates.md /
 * color-palette.md) the overview agent Reads by absolute path.
 *
 * Under `tsx watch` this is `src/overview-assets`; in a compiled build the
 * postbuild copy places it at `dist/overview-assets`. Both sit next to this
 * module, so resolve from here.
 *
 * (Historically this module also housed a headless-Chromium Excalidraw renderer
 * for a write→render→view→fix loop. That loop was removed when overview diagrams
 * moved to one-shot SVG authoring — see issue #1 — so only the asset locator
 * remains, and the Playwright/Chromium dependency is gone.)
 */
export function assetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "overview-assets");
  if (existsSync(candidate)) return candidate;
  // Fallback: dev builds that run from dist but didn't copy — read from src.
  const srcFallback = resolve(here, "..", "src", "overview-assets");
  if (existsSync(srcFallback)) return srcFallback;
  return candidate; // let the caller surface a clear ENOENT
}
