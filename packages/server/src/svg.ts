import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

/**
 * Validate + sanitize a model-authored SVG string for the PR-overview diagrams
 * (issue #1). The overview agent authors a self-contained `<svg>` per 4W1H
 * section in ONE pass (no render loop); the dashboard renders it inline via
 * `dangerouslySetInnerHTML`, so this function is the load-bearing gate that
 * guarantees the string is BOTH well-formed AND safe before it can ever reach a
 * browser.
 *
 * The approach is a real parse → tree-walk → re-serialize, NOT regex on markup:
 * regex sanitizers are routinely defeated by mutation-XSS and malformed nesting.
 * Parsing also gives well-formedness for free (a truncated/garbled string fails
 * to parse) and lets us re-serialize a canonical, safe string.
 *
 * Contract (see svg.test.ts):
 *  - `ok:false` with `errors` when the input is not a well-formed `<svg>` root
 *    with a `viewBox` and at least one child element (so it can scale inline).
 *  - `ok:true` with a sanitized `svg` string otherwise, having stripped the XSS
 *    surface: `<script>`/`<foreignObject>` subtrees, all `on*` handlers, and any
 *    `javascript:`/external `href`/`xlink:href` (in-document `#anchor` refs are
 *    kept — they drive markers/gradients and are safe).
 * Never throws — bad input yields `ok:false`, mirroring the tolerant parsers in
 * `risks.ts`.
 */

export interface SanitizeResult {
  ok: boolean;
  /** The sanitized, re-serialized SVG (empty string when `ok:false`). */
  svg: string;
  errors: string[];
}

/** Elements removed wholesale (with their subtree). Lowercased for comparison. */
const FORBIDDEN_ELEMENTS = new Set(["script", "foreignobject", "style", "animate", "set", "handler"]);

/**
 * Attributes always removed. `style` can smuggle an external `url(...)` (a fetch/
 * exfil beacon) or other CSS vectors — since the `<style>` ELEMENT is forbidden,
 * the `style` ATTRIBUTE is too (a diagram never needs inline CSS; use SVG
 * presentation attributes like fill/stroke instead).
 */
const FORBIDDEN_ATTRS = new Set(["style"]);

/** Attributes carrying a bare URL that must be same-document (#id) or dropped. */
const URL_ATTRS = new Set(["href", "xlink:href", "src"]);

/** True for a value safe to keep in an href-like attribute: only in-document #anchors. */
function isSafeRef(value: string): boolean {
  return value.trim().startsWith("#");
}

/**
 * True when a value smuggles a reference OUT of this document — an external
 * `url(...)` (http/https/protocol-relative/other scheme) inside a presentation
 * attribute (fill/stroke/filter/mask/clip-path…). In-document `url(#id)` refs
 * (markers, gradients) are safe and must be kept.
 */
function hasExternalUrlRef(value: string): boolean {
  const m = value.match(/url\(\s*['"]?\s*([^'")]+)/i);
  if (!m) return false;
  return !m[1].trim().startsWith("#");
}

/**
 * Recursively strip dangerous nodes/attributes in place. Returns the child nodes
 * to remove from `parent` after iteration (removing during iteration corrupts the
 * live NodeList).
 */
function scrub(node: any): void {
  const toRemove: any[] = [];
  const children = node.childNodes ? Array.from(node.childNodes) : [];
  for (const child of children as any[]) {
    // ELEMENT_NODE === 1
    if (child.nodeType !== 1) continue;
    const tag = String(child.localName ?? child.nodeName ?? "").toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(tag)) {
      toRemove.push(child);
      continue;
    }
    scrubAttributes(child);
    scrub(child);
  }
  for (const child of toRemove) node.removeChild(child);
}

function scrubAttributes(el: any): void {
  if (!el.attributes) return;
  // Snapshot: mutating attributes while iterating the live map is unsafe.
  const attrs = Array.from(el.attributes) as any[];
  for (const attr of attrs) {
    const name = String(attr.name ?? "").toLowerCase();
    const value = String(attr.value ?? "");
    // Always-forbidden attributes (style — inline CSS is a url()/vector surface).
    if (FORBIDDEN_ATTRS.has(name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    // Event handlers: onload, onclick, onmouseover, …
    if (name.startsWith("on")) {
      el.removeAttribute(attr.name);
      continue;
    }
    // URL-bearing attributes (href/xlink:href/src): keep only same-document #anchors.
    if (URL_ATTRS.has(name) && !isSafeRef(value)) {
      el.removeAttribute(attr.name);
      continue;
    }
    // Any attribute whose value smuggles a javascript: URL.
    if (/javascript:/i.test(value)) {
      el.removeAttribute(attr.name);
      continue;
    }
    // Presentation attributes (fill/stroke/filter/mask/clip-path…) that point at
    // an EXTERNAL url(...) — an external fetch/exfil beacon. In-document url(#id)
    // refs (gradients, markers) are safe and kept.
    if (hasExternalUrlRef(value)) {
      el.removeAttribute(attr.name);
    }
  }
}

export function sanitizeSvg(raw: string): SanitizeResult {
  const fail = (msg: string): SanitizeResult => ({ ok: false, svg: "", errors: [msg] });

  if (!raw || !raw.trim()) return fail("empty input");

  // Collect parser errors rather than letting xmldom warn to the console. A
  // FATAL error (missing root, unclosed tags) is THROWN by xmldom, not just
  // reported — so the parse must be guarded; either path means "not well-formed".
  const parseErrors: string[] = [];
  let doc: any;
  try {
    doc = new DOMParser({
      onError: (_level: unknown, msg: unknown) => {
        parseErrors.push(String(msg));
      },
    }).parseFromString(raw, "image/svg+xml");
  } catch (e: any) {
    return fail(`malformed: ${String(e?.message ?? e)}`);
  }

  const root: any = doc?.documentElement;
  if (!root) return fail(`unparseable: ${parseErrors[0] ?? "no document element"}`);
  if (parseErrors.length) return fail(`malformed: ${parseErrors[0]}`);

  const rootTag = String(root.localName ?? root.nodeName ?? "").toLowerCase();
  if (rootTag !== "svg") return fail(`root element is <${rootTag}>, expected <svg>`);

  if (!root.getAttribute || !root.getAttribute("viewBox")) {
    return fail("missing viewBox (cannot scale inline)");
  }

  // Must carry at least one child ELEMENT (a diagram, not an empty canvas).
  const hasElementChild = Array.from(root.childNodes ?? []).some((n: any) => n.nodeType === 1);
  if (!hasElementChild) return fail("no child elements (empty svg)");

  // Sanitize the tree, then re-serialize the (now-safe) root.
  scrubAttributes(root);
  scrub(root);

  const svg = new XMLSerializer().serializeToString(root);
  return { ok: true, svg, errors: [] };
}
