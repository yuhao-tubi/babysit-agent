# SVG Diagram Methodology

How to make a PR-overview diagram that ARGUES a point — and, because you author
it in ONE pass with no render/preview, how to get the layout right the FIRST
time. The spacing rules here are LOAD-BEARING: a diagram that violates them ships
with overlapping boxes and unreadable text, because nothing will catch it.

---

## 1. A diagram must make an argument

A good diagram answers a question the prose can't show at a glance. Before you
draw, name the ONE idea the diagram teaches, then pick the shape that teaches it:

| The idea | Shape |
|----------|-------|
| "It used to do X, now it does Y" | **before / after** — two regions side by side |
| "One thing triggers many" | **fan-out** — one node, arrows to N |
| "These run as parallel tracks" | **two pipelines** — two horizontal lanes |
| "It happens in this order" | **timeline / sequence** — left-to-right steps |
| "This is a tree of things" | **tree** — root at top, children below |
| "State moves between modes" | **state machine** — nodes + labelled arrows |
| "A change here breaks a thing over there" | **blast radius** — changed node + arrows to affected |

Use REAL names — file names, symbols, states, actor names — never "Component A".
Only draw a diagram for a section when the idea genuinely has ≥3 things worth
relating; a trivial change earns no diagram.

## 2. The spacing rules (CRITICAL — you cannot see the result)

You are placing coordinates blind. Follow these exactly.

**Box sizing**
- Simple node: 60px tall. Node with a sublabel: 80px. Node with detail lines:
  100–120px.
- Text fits the box: at font-size 13, budget ~9px per character. A 180px box
  holds ~18 chars. If the name is longer, widen the box or drop to font-size 11.
  NEVER let a label exceed its box.

**Gaps (minimum, measured between the nearest edges)**
- Between two boxes (any direction): **≥ 40px**.
- Between a box and a boundary/cluster it sits inside: **≥ 16px padding** on all
  sides.
- Between the outermost content and the `viewBox` edge: **≥ 40px margin**.

**Stacking vertically** — compute each row's y from the previous row's bottom:
```
Row A: y=80,  height=60  → bottom = 140
gap:   40px               → next y = 180
Row B: y=180, height=60  → bottom = 240
```
Never start a row before the previous row's bottom + 40. Overlap is the #1
one-shot failure.

**Arrows**
- Anchor to box EDGES (midpoint of a side), not centers. A vertical arrow from
  box A (x=80..260, bottom y=140) to box B below leaves at `x=170,y=140` and
  enters at `x=170,y=180`.
- If an arrow would cross a box, route it as a `<polyline>` elbow through the
  gap, not a straight line through the shape.
- Draw arrows/markers BEFORE boxes in document order (boxes then paint over the
  arrow tails).

**Legend & viewBox**
- If you add a legend, place it BELOW the lowest content (and outside every
  dashed boundary), then make the `viewBox` height ≥ legend bottom + 40.
- Compute the final `viewBox` LAST: `W` = rightmost content + margin, `H` =
  bottommost content (incl. legend) + margin. Everything must fit inside it.

## 3. Composition

- Left-to-right for flow/sequence; top-to-bottom for hierarchy/dependency.
- Align boxes on a shared axis (same y for a row, same x for a column) — ragged
  placement reads as sloppy.
- Balance the canvas: don't cram everything in the top-left and leave the
  bottom-right empty. Distribute across the viewBox.
- 5–9 nodes is the sweet spot. More than ~10 means the idea should be split or
  simplified — a cluttered diagram teaches nothing.

## 4. Color = meaning

Follow `color-palette.md`. The core habit: **changed-by-this-PR** boxes in the
blue "changed/core" role, **affected-downstream** boxes in the amber role. That
single contrast is often the whole argument of a "blast radius" or "before/after"
diagram. Reach for the decision/error roles only when the node truly is one.

## 5. Self-check before you write the file

Mentally walk the coordinates once:
- Does any box's x-range and y-range overlap another box's? (must be no)
- Is every label's width < its box's width?
- Does every arrow start and end on a box edge, not inside a box?
- Is there ≥40px margin to the viewBox edge on all sides?
- Is the legend (if any) below everything and inside the viewBox?

If yes to all, write the file. Getting this right in one pass is the whole job —
there is no second look.
