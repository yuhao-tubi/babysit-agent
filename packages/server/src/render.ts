import { chromium, type Browser } from "playwright";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * Render `.excalidraw` JSON → PNG, headless. A TypeScript port of the reference
 * skill's `render_excalidraw.py` (coleam00/excalidraw-diagram-skill), kept
 * in-package so the daemon owns its renderer.
 *
 * How it works (proven by the migration smoke test):
 *   1. Boot headless Chromium (Playwright).
 *   2. Serve a tiny HTML template + the VENDORED `@excalidraw/utils` bundle over
 *      loopback HTTP (Chromium blocks `file://` ESM imports, and the module needs
 *      a real `window`; esm.sh is deliberately NOT used — offline + version-pinned).
 *   3. In-page, call `exportToSvg(...)` and screenshot the resulting SVG element.
 *
 * The agent invokes this via the CLI shim (`cli.ts render <file>`), Reads the
 * PNG back, critiques it, and edits the JSON — the write→render→view→fix loop.
 */

const require = createRequire(import.meta.url);

/** Absolute path to the vendored `@excalidraw/utils` prod ESM bundle. */
function utilsBundlePath(): string {
  // Resolves to node_modules/@excalidraw/utils/dist/prod/index.js
  return require.resolve("@excalidraw/utils");
}

/**
 * Locate the vendored assets dir (`overview-assets/`). Under `tsx watch` this is
 * `src/overview-assets`; in a compiled build the postbuild copy places it at
 * `dist/overview-assets`. Both sit next to this module, so resolve from here.
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

/**
 * The shell command PREFIX the overview agent runs to render one `.excalidraw`
 * file (it appends the absolute file path). Must work from ANY cwd (the agent's
 * cwd is the target PR worktree, not this repo), so it uses absolute paths.
 * Branches on dev (`tsx` over `src`) vs. compiled (`node` over `dist`).
 */
export function renderCliCommand(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const isDist = here.split(sep).includes("dist");
  if (isDist) {
    // Compiled: node over the absolute cli.js — no cwd dependency.
    return `node ${join(here, "cli.js")} render`;
  }
  // Dev: run tsx over cli.ts. Wrap in a subshell that cd's into the babysit repo
  // root so `npx tsx` resolves our devDependency rather than the target repo's.
  const babysitRoot = resolve(here, "..", "..", "..");
  const cliPath = join(here, "cli.ts");
  return `(cd ${babysitRoot} && npx tsx ${cliPath} render)`;
}

export interface RenderResult {
  pngPath: string;
  width: number;
  height: number;
}

/** Structural validation mirroring the Python `validate_excalidraw`. */
function validate(data: any): string[] {
  const errors: string[] = [];
  if (data?.type !== "excalidraw") {
    errors.push(`Expected type 'excalidraw', got '${data?.type}'`);
  }
  if (!("elements" in (data ?? {}))) {
    errors.push("Missing 'elements' array");
  } else if (!Array.isArray(data.elements)) {
    errors.push("'elements' must be an array");
  } else if (data.elements.length === 0) {
    errors.push("'elements' array is empty — nothing to render");
  }
  return errors;
}

/** Compute the element bounding box to size the viewport (arrows/lines use points). */
function boundingBox(elements: any[]): [number, number, number, number] {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const el of elements) {
    if (el?.isDeleted) continue;
    const x = el.x ?? 0,
      y = el.y ?? 0,
      w = el.width ?? 0,
      h = el.height ?? 0;
    if ((el.type === "arrow" || el.type === "line") && Array.isArray(el.points)) {
      for (const [px, py] of el.points) {
        minX = Math.min(minX, x + px);
        minY = Math.min(minY, y + py);
        maxX = Math.max(maxX, x + px);
        maxY = Math.max(maxY, y + py);
      }
    } else {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + Math.abs(w));
      maxY = Math.max(maxY, y + Math.abs(h));
    }
  }
  if (!isFinite(minX)) return [0, 0, 800, 600];
  return [minX, minY, maxX, maxY];
}

/** Raised when Chromium is not installed — the operator must run `make setup-render`. */
export class ChromiumMissingError extends Error {
  constructor(detail: string) {
    super(
      `Chromium is not installed for Playwright — run \`make setup-render\`. (${detail})`
    );
    this.name = "ChromiumMissingError";
  }
}

async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("Executable doesn't exist") || msg.includes("playwright install")) {
      throw new ChromiumMissingError(msg.split("\n")[0]);
    }
    throw e;
  }
}

/** Probe whether Chromium is available without doing a full render. */
export async function chromiumAvailable(): Promise<boolean> {
  try {
    const b = await launchChromium();
    await b.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Render an `.excalidraw` file to a PNG (default: same path with `.png`).
 * Throws ChromiumMissingError if the browser is absent, or Error on invalid
 * JSON / render failure — the caller maps those to a failed generation.
 */
export async function renderExcalidraw(
  excalidrawPath: string,
  opts: { output?: string; scale?: number; maxWidth?: number } = {}
): Promise<RenderResult> {
  const scale = opts.scale ?? 2;
  const maxWidth = opts.maxWidth ?? 1920;
  const pngPath = opts.output ?? excalidrawPath.replace(/\.excalidraw$/, "") + ".png";

  const raw = readFileSync(excalidrawPath, "utf8");
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`Invalid JSON in ${excalidrawPath}: ${e.message}`);
  }
  const errors = validate(data);
  if (errors.length) {
    throw new Error(`Invalid Excalidraw file: ${errors.join("; ")}`);
  }

  const elements = data.elements.filter((e: any) => !e?.isDeleted);
  const [minX, minY, maxX, maxY] = boundingBox(elements);
  const padding = 80;
  const vpWidth = Math.min(Math.round(maxX - minX + padding * 2), maxWidth);
  const vpHeight = Math.max(Math.round(maxY - minY + padding * 2), 600);

  const dir = assetsDir();
  const templatePath = join(dir, "render_template.html");
  if (!existsSync(templatePath)) {
    throw new Error(`Render template not found at ${templatePath}`);
  }
  const templateHtml = readFileSync(templatePath, "utf8");
  const utilsJs = await readFile(utilsBundlePath(), "utf8");

  // Serve template + vendored utils bundle over loopback (see file header).
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url?.startsWith("/index")) {
      res.setHeader("Content-Type", "text/html");
      res.end(templateHtml);
    } else if (req.url?.startsWith("/utils.js")) {
      res.setHeader("Content-Type", "text/javascript");
      res.end(utilsJs);
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port as number;

  const browser = await launchChromium();
  try {
    const page = await browser.newPage({
      viewport: { width: vpWidth, height: vpHeight },
      deviceScaleFactor: scale,
    });
    let pageError = "";
    page.on("pageerror", (e) => {
      pageError = e.message;
    });

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
    await page.waitForFunction("window.__moduleReady === true", { timeout: 90_000 });

    const result = (await page.evaluate(
      // Runs in the browser page context; `window` is the page's, not Node's.
      (json: string) => (globalThis as any).renderDiagram(json),
      JSON.stringify(data)
    )) as { success: boolean; error?: string; width?: string; height?: string } | null;

    if (!result || !result.success) {
      throw new Error(
        `Render failed: ${result?.error || pageError || "renderDiagram returned null"}`
      );
    }
    await page.waitForFunction("window.__renderComplete === true", { timeout: 15_000 });

    const svg = await page.$("#root svg");
    if (!svg) throw new Error("No SVG element produced after render.");
    await svg.screenshot({ path: pngPath });

    return {
      pngPath,
      width: Number(result.width ?? vpWidth),
      height: Number(result.height ?? vpHeight),
    };
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}
