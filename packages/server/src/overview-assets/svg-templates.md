# SVG Element Templates

Copy-paste primitives for authoring a PR-overview diagram as raw SVG. You write
the SVG in ONE pass — there is no render/preview — so use these known-good
snippets and follow the spacing rules in `svg-methodology.md` exactly. Colors
come from `color-palette.md` (the single source of truth); the values below are
illustrative.

All coordinates are in the `viewBox` user space. The document root is always:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" font-family="ui-sans-serif, system-ui, sans-serif">
  <!-- ...content... -->
</svg>
```

Pick a `viewBox` big enough for every shape PLUS a margin and any legend. Height
grows as you stack rows (see the spacing rules).

---

## Component box (a file / concept / state / actor)

A rounded rect with a centered label and optional sublabel. Box is 60px tall for
a simple node; give it 80–120px if it holds a sublabel + detail.

```svg
<g>
  <rect x="80" y="80" width="180" height="60" rx="6"
        fill="#eff6ff" stroke="#2563eb" stroke-width="1.5"/>
  <text x="170" y="106" text-anchor="middle" font-size="13" font-weight="600" fill="#1e3a8a">resolveQueue</text>
  <text x="170" y="124" text-anchor="middle" font-size="10" fill="#64748b">queue.ts</text>
</g>
```

- `text-anchor="middle"` + an x at the box's horizontal center keeps text
  centered. Compute center = `x + width/2`.
- Keep a label under ~18 chars per line at font-size 13, or it will overflow a
  180px box. Widen the box or drop to font-size 11 for longer names.

## Decision (branch / conditional) — a diamond

```svg
<g>
  <polygon points="480,60 560,110 480,160 400,110"
           fill="#fef3c7" stroke="#b45309" stroke-width="1.5"/>
  <text x="480" y="115" text-anchor="middle" font-size="12" fill="#b45309">role?</text>
</g>
```

## Arrow (a connection between two boxes)

Define the arrowhead marker ONCE in `<defs>`, then reference it from every line.
Draw arrows BEFORE the boxes in document order so boxes paint over the arrow tail
(SVG paints in document order).

```svg
<defs>
  <marker id="arrow" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto-start-reverse">
    <polygon points="0 0, 10 3.5, 0 7" fill="#64748b"/>
  </marker>
</defs>

<!-- straight arrow from the right edge of box A to the left edge of box B -->
<line x1="260" y1="110" x2="400" y2="110" stroke="#64748b" stroke-width="1.5" marker-end="url(#arrow)"/>

<!-- elbow arrow (route around things) as a polyline -->
<polyline points="170,140 170,240 400,240" fill="none" stroke="#64748b" stroke-width="1.5" marker-end="url(#arrow)"/>
```

- Anchor arrows to box EDGES (center of a side), not box centers, so the line
  doesn't disappear under the box.
- A labelled arrow: add a `<text>` at the line's midpoint with a small white
  halo (draw a `<text>` twice — once with `stroke="#ffffff" stroke-width="3"`
  behind, once filled — or just place it in a gap).

## Group boundary (a cluster / phase / "before" vs "after" region)

A dashed container that visually groups several boxes. Draw it FIRST (behind its
children). Leave ≥16px padding between the boundary and the boxes inside.

```svg
<g>
  <rect x="60" y="50" width="360" height="200" rx="12"
        fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="8,4"/>
  <text x="76" y="44" font-size="12" font-weight="600" fill="#64748b">Before</text>
</g>
```

## Section title

```svg
<text x="40" y="36" font-size="18" font-weight="700" fill="#1e3a8a">Why: the stale-read race</text>
```

## Legend (optional)

Place it OUTSIDE every boundary box, below the lowest content, and extend the
viewBox height to fit it (see the spacing rules).

```svg
<g>
  <rect x="40" y="470" width="14" height="14" rx="3" fill="#eff6ff" stroke="#2563eb"/>
  <text x="62" y="482" font-size="11" fill="#64748b">changed by this PR</text>
  <rect x="220" y="470" width="14" height="14" rx="3" fill="#fffbeb" stroke="#d97706"/>
  <text x="242" y="482" font-size="11" fill="#64748b">affected downstream</text>
</g>
```

## Code / evidence snippet (a real symbol or payload)

```svg
<g>
  <rect x="80" y="300" width="260" height="54" rx="6" fill="#1e293b"/>
  <text x="94" y="322" font-family="ui-monospace, monospace" font-size="11" fill="#e2e8f0">if (cache.stale) refetch();</text>
  <text x="94" y="340" font-family="ui-monospace, monospace" font-size="11" fill="#22c55e">// runs AFTER the read</text>
</g>
```

---

## Forbidden (the server rejects the whole diagram)

Do NOT emit any of these — the validator strips/rejects them:

- `<script>` … `</script>`
- `<foreignObject>` (no HTML-in-SVG)
- any `on*` attribute (`onload`, `onclick`, …)
- external or `javascript:` URLs in `href` / `xlink:href` (in-document `#id`
  refs for markers/gradients are fine)
- `<style>`, `<animate>`, `<set>` (keep it static)
