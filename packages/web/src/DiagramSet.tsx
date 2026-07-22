import { useMemo, useState } from "react";
import { Segmented } from "antd";
import type { DiagramSection, DiagramSet as DiagramSetT } from "./types";

/**
 * Renders the 4W1H PR-overview diagram set as inline SVG — one per section
 * (Why / What / How), shown one at a time via a section switcher. Diagrams are
 * READ-ONLY: the agent authored each `<svg>` in one pass and the server has
 * already validated + SANITIZED it (well-formed, no script/handler/foreignObject/
 * external-ref) before it ever reached the client (see server `sanitizeSvg`).
 * Regenerate is the way to change a diagram — there is no in-browser editing.
 */

const SECTION_LABEL: Record<DiagramSection, string> = { why: "Why", what: "What", how: "How" };
const SECTION_ORDER: DiagramSection[] = ["why", "what", "how"];

/** One read-only diagram. The svg string is server-sanitized; render it inline. */
function OneDiagram({ svg }: { svg: string }) {
  return (
    <div
      style={{
        border: "1px solid #f0f0f0",
        borderRadius: 8,
        background: "#fff",
        marginBottom: 12,
        padding: 12,
        overflow: "auto",
        // Let the SVG scale to the container width while keeping its aspect ratio.
        display: "flex",
        justifyContent: "center",
      }}
      // Server-sanitized SVG (see sanitizeSvg): safe to inline.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function DiagramSet({ diagrams }: { diagrams: DiagramSetT }) {
  const sections = useMemo(
    () => SECTION_ORDER.filter((s) => !!diagrams[s]),
    [diagrams]
  );
  const [active, setActive] = useState<DiagramSection | null>(sections[0] ?? null);

  if (!sections.length) return null;
  const current = active && sections.includes(active) ? active : sections[0];
  const doc = diagrams[current];

  return (
    <div style={{ marginBottom: 12 }}>
      {sections.length > 1 && (
        <Segmented
          size="small"
          value={current}
          onChange={(v) => setActive(v as DiagramSection)}
          options={sections.map((s) => ({ label: SECTION_LABEL[s], value: s }))}
          style={{ marginBottom: 10 }}
        />
      )}
      {doc && <OneDiagram key={`${current}`} svg={doc.svg} />}
    </div>
  );
}
