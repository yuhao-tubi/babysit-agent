import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Space, Spin, Typography } from "antd";
import { FileTextOutlined, ReloadOutlined } from "@ant-design/icons";
import type { PrOverview } from "./types";
import { fetchPrOverview, generatePrOverview, prDiagramUrl } from "./api";
import { Markdown } from "./Markdown";

const { Text } = Typography;

/**
 * PR-level Overview + diagram panel (a Session artifact — see CONTEXT.md).
 * On-demand: nothing generates until the owner clicks. Progress arrives via the
 * `pr_overview_updated` SSE event, which App.tsx surfaces through `refreshKey`.
 */
export function OverviewPanel({
  prKey,
  refreshKey,
}: {
  prKey: string;
  refreshKey: number;
}) {
  const [ov, setOv] = useState<PrOverview | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    fetchPrOverview(prKey)
      .then(setOv)
      .catch(() => setOv(null));
  }, [prKey]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const generate = async () => {
    setLoading(true);
    try {
      await generatePrOverview(prKey);
      load();
    } finally {
      setLoading(false);
    }
  };

  const generating = ov?.status === "generating";
  const hasArtifact = ov?.status === "ready" || (ov?.overviewMd && ov.status !== "generating");

  return (
    <div style={{ padding: "4px 2px 8px" }}>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          <FileTextOutlined /> PR overview &amp; diagram
        </Text>
        <Button
          size="small"
          icon={generating ? <Spin size="small" /> : <ReloadOutlined />}
          loading={loading}
          disabled={generating}
          onClick={generate}
        >
          {ov?.overviewMd ? "Regenerate" : "Generate"}
        </Button>
      </Space>

      {generating && (
        <Alert
          type="info"
          showIcon
          message="Generating overview…"
          description="Investigating the PR diff and codebase. This runs one agent pass and may take a minute."
          style={{ marginBottom: 8 }}
        />
      )}

      {ov?.status === "failed" && (
        <Alert
          type="error"
          showIcon
          message="Overview generation failed"
          description="No usable output was produced. Try Regenerate."
          style={{ marginBottom: 8 }}
        />
      )}

      {ov?.stale && hasArtifact && !generating && (
        <Alert
          type="warning"
          showIcon
          message="This overview is stale"
          description="The PR head has moved since it was generated. Regenerate to refresh."
          style={{ marginBottom: 8 }}
        />
      )}

      {!ov?.overviewMd && !generating && ov?.status !== "failed" && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          No overview yet. Click Generate to produce a summary and architecture diagram.
        </Text>
      )}

      {ov?.overviewMd && (
        <>
          <Markdown maxHeight={360}>{ov.overviewMd}</Markdown>
          {ov.hasDiagram && (
            <div
              style={{
                marginTop: 10,
                border: "1px solid #f0f0f0",
                borderRadius: 8,
                overflow: "auto",
                background: "#020617",
              }}
            >
              {/* Cache-bust by generatedAt so a regenerate reloads the SVG. */}
              <object
                type="image/svg+xml"
                data={`${prDiagramUrl(prKey)}?t=${encodeURIComponent(ov.generatedAt ?? "")}`}
                style={{ width: "100%", minHeight: 320, display: "block" }}
                aria-label="PR architecture diagram"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
