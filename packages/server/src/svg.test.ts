import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSvg } from "./svg.js";

/**
 * The load-bearing safety + correctness gate for one-shot SVG overview diagrams
 * (issue #1). The authored SVG is rendered inline in the dashboard via
 * `dangerouslySetInnerHTML`, so an unsanitized string is a live XSS surface —
 * these tests pin the contract that malformed markup is REJECTED and dangerous
 * markup is STRIPPED. Same tolerant-parse spirit as `parseRisksFile` in
 * risks.test.ts: bad input in, safe/empty output out — never a throw.
 */

const OK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">' +
  '<rect x="10" y="10" width="80" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/>' +
  '<text x="50" y="35" font-size="12" text-anchor="middle">core</text>' +
  "</svg>";

// ---- well-formedness ----

test("a well-formed svg with a viewBox passes and is returned", () => {
  const r = sanitizeSvg(OK_SVG);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.match(r.svg, /^<svg/);
  assert.match(r.svg, /<rect/);
  assert.match(r.svg, /core<\/text>/);
});

test("rejects a string whose root element is not <svg>", () => {
  const r = sanitizeSvg('<div xmlns="http://www.w3.org/2000/svg"><svg viewBox="0 0 1 1"/></div>');
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test("rejects non-markup / plain prose", () => {
  const r = sanitizeSvg("Here is your diagram: it shows two pipelines.");
  assert.equal(r.ok, false);
});

test("rejects a truncated / unclosed svg", () => {
  const r = sanitizeSvg('<svg viewBox="0 0 10 10"><rect x="1" y="1"');
  assert.equal(r.ok, false);
});

test("rejects an empty svg (no child elements)", () => {
  const r = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>');
  assert.equal(r.ok, false);
});

test("rejects an svg with no viewBox (cannot scale inline)", () => {
  const r = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="4" height="4"/></svg>');
  assert.equal(r.ok, false);
});

test("empty / whitespace input is rejected, never throws", () => {
  for (const raw of ["", "   ", "\n"]) {
    const r = sanitizeSvg(raw);
    assert.equal(r.ok, false);
  }
});

// ---- sanitization (the XSS surface) ----

test("strips a <script> element but keeps the rest of the diagram", () => {
  const r = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<script>alert(1)</script><rect x="1" y="1" width="4" height="4"/></svg>'
  );
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.svg, /<script/i);
  assert.doesNotMatch(r.svg, /alert\(1\)/);
  assert.match(r.svg, /<rect/);
});

test("strips on* event-handler attributes (onload/onclick/onmouseover)", () => {
  const r = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="steal()">' +
      '<rect x="1" y="1" width="4" height="4" onclick="x()" onmouseover="y()"/></svg>'
  );
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.svg, /onload/i);
  assert.doesNotMatch(r.svg, /onclick/i);
  assert.doesNotMatch(r.svg, /onmouseover/i);
  assert.match(r.svg, /<rect/);
});

test("strips <foreignObject> (html-injection vector) subtree", () => {
  const r = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>bad()</script></body></foreignObject>' +
      '<rect x="1" y="1" width="4" height="4"/></svg>'
  );
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.svg, /foreignObject/i);
  assert.doesNotMatch(r.svg, /bad\(\)/);
  assert.match(r.svg, /<rect/);
});

test("strips javascript: hrefs while allowing a benign shape to remain", () => {
  const r = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
      '<a href="javascript:evil()"><rect x="1" y="1" width="4" height="4"/></a>' +
      '<use xlink:href="javascript:evil()"/></svg>'
  );
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.svg, /javascript:/i);
});

test("strips external href (data exfiltration / remote fetch) but keeps in-document #anchor refs", () => {
  const r = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<image href="https://evil.example/x.png" x="0" y="0" width="4" height="4"/>' +
      '<rect x="1" y="1" width="4" height="4" fill="url(#grad)"/>' +
      '<use href="#grad"/></svg>'
  );
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.svg, /evil\.example/);
  // In-document references (fill="url(#id)", href="#id") are safe and preserved.
  assert.match(r.svg, /url\(#grad\)/);
  assert.match(r.svg, /href="#grad"/);
});

test("strips a style attribute carrying an external url() (exfil/fetch beacon)", () => {
  const r = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<rect x="1" y="1" width="4" height="4" style="fill:#eee;background:url(https://evil.example/beacon)"/></svg>'
  );
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.svg, /evil\.example/);
  assert.doesNotMatch(r.svg, /style=/i, "the style attribute is removed entirely");
  assert.match(r.svg, /<rect/);
});

test("strips a presentation attribute pointing at an external url() (fill/filter/mask)", () => {
  const r = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<rect x="1" y="1" width="4" height="4" fill="url(https://evil.example/p.svg#x)" filter="url(http://evil.example/f)"/>' +
      '<rect x="2" y="2" width="2" height="2" fill="url(#grad)"/></svg>'
  );
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.svg, /evil\.example/);
  // In-document url(#id) refs are safe and preserved.
  assert.match(r.svg, /url\(#grad\)/);
});

test("strips an external <image> src (not just href)", () => {
  const r = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<image src="https://evil.example/x.png" x="0" y="0" width="4" height="4"/>' +
      '<rect x="1" y="1" width="2" height="2"/></svg>'
  );
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.svg, /evil\.example/);
  assert.match(r.svg, /<rect/);
});

test("a benign svg with markers, groups, paths and text survives unchanged in structure", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200">' +
    '<defs><marker id="arrow" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">' +
    '<polygon points="0 0, 10 3.5, 0 7" fill="#64748b"/></marker></defs>' +
    '<g><rect x="10" y="10" width="80" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/>' +
    '<text x="50" y="35" font-size="12">A</text></g>' +
    '<path d="M90 30 L200 30" stroke="#64748b" marker-end="url(#arrow)"/>' +
    "</svg>";
  const r = sanitizeSvg(svg);
  assert.equal(r.ok, true);
  assert.match(r.svg, /<marker/);
  assert.match(r.svg, /<polygon/);
  assert.match(r.svg, /marker-end="url\(#arrow\)"/);
  assert.match(r.svg, /<path/);
});
