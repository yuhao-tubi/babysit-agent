import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });

let idSeq = 0;

/**
 * Render a mermaid diagram source to inline SVG. The finder authors this text
 * WITHOUT seeing it rendered (unlike Excalidraw), so broken syntax is expected
 * occasionally: on a parse/render error we fall back to showing the raw source
 * in a code block rather than crashing the Risks panel.
 */
export function Mermaid({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`mmd-${idSeq++}`);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    mermaid
      .render(idRef.current, chart)
      .then(({ svg }) => {
        if (!cancelled) setSvg(svg);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (failed) {
    return (
      <pre
        style={{
          background: "#fff7e6",
          border: "1px solid #ffe7ba",
          borderRadius: 6,
          padding: 8,
          fontSize: 12,
          overflow: "auto",
        }}
      >
        <code>{chart}</code>
      </pre>
    );
  }
  if (svg == null) return null;
  return (
    <div
      style={{ display: "flex", justifyContent: "center", margin: "8px 0" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
