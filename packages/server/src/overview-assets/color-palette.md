# Color Palette & Brand Style

**This is the single source of truth for all colors in a PR-overview diagram.** It
is rebranded to the babysit-agent dashboard palette so the diagram sits visually
inside the dashboard. Colors encode MEANING, not decoration.

The four core roles below mirror the dashboard's node legend — use them so a
reader can tell, at a glance, what each box *is* in the PR:

---

## Shape Colors (Semantic — the dashboard node roles)

| Semantic Purpose | Meaning in a PR diagram | Fill | Stroke |
|------------------|-------------------------|------|--------|
| **Changed / core** | A file this PR itself changed, the central concept, the "after" state | `#eff6ff` | `#2563eb` |
| **Affected / downstream** | Code impacted but NOT edited, a derived idea, the "before" state | `#fffbeb` | `#d97706` |
| **External** | An outside system, actor, input, or trigger | `#f8fafc` | `#94a3b8` |
| **Note / concept** | A plain concept, problem, or annotation box (no code implied) | `#f0fdf4` | `#16a34a` |
| **Decision** | A branch/conditional (use a `diamond`) | `#fef3c7` | `#b45309` |
| **Error / risk** | A bug, failure, or risk being highlighted | `#fee2e2` | `#dc2626` |

**Rule**: Always pair a darker stroke with a lighter fill for contrast. Prefer
the four core roles; reach for Decision/Error only when the idea truly is one.

---

## Text Colors (Hierarchy)

Use color on free-floating text to create hierarchy without containers.

| Level | Color | Use For |
|-------|-------|---------|
| Title | `#1e3a8a` | Section headings, major labels |
| Subtitle | `#2563eb` | Subheadings, secondary labels |
| Body/Detail | `#64748b` | Descriptions, annotations, metadata, sublabels |
| On light fills | `#1e3a8a` | Text inside the light-colored role shapes above |
| On dark fills | `#ffffff` | Text inside dark/evidence rectangles |

Text inside a role shape should match that role's stroke color (e.g. `#2563eb`
inside a changed/core box) — it reads as "labelled by role."

---

## Evidence Artifact Colors

For code snippets and data examples inside a diagram (real symbols/payloads, not
placeholders).

| Artifact | Background | Text Color |
|----------|-----------|------------|
| Code snippet | `#1e293b` | `#e2e8f0` (light) / syntax-appropriate |
| JSON/data example | `#1e293b` | `#22c55e` (green) |

---

## Default Stroke & Line Colors

| Element | Color |
|---------|-------|
| Arrows | The stroke color of the source element's role |
| Structural lines (dividers, trees, timelines) | Slate `#64748b` |
| Marker dots (fill + stroke) | Changed/core stroke `#2563eb` |

---

## Background

| Property | Value |
|----------|-------|
| Canvas background | `#ffffff` |
