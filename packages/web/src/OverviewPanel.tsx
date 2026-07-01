import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Input, Space, Spin, Tag, Typography, message } from "antd";
import {
  FileTextOutlined,
  GithubOutlined,
  ReloadOutlined,
  QuestionCircleOutlined,
  SendOutlined,
} from "@ant-design/icons";
import type { PrOverview } from "./types";
import { askPrQuestion, fetchPrOverview, generatePrOverview, prDiagramUrl } from "./api";
import { Markdown } from "./Markdown";

const { Title, Text } = Typography;

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
      {/* PR header — title, key, role, GitHub link. */}
      <div style={{ marginBottom: 12 }}>
        <Space size={8} align="center" wrap>
          <Text strong style={{ fontSize: 15 }}>
            {ov?.prKey ?? prKey}
          </Text>
          {ov && (
            <a href={ov.url} target="_blank" rel="noreferrer" title="Open PR on GitHub">
              <GithubOutlined />
            </a>
          )}
          {ov?.role === "reviewer" && <Tag color="purple">REVIEW</Tag>}
        </Space>
        {ov?.title && (
          <Title level={5} style={{ margin: "4px 0 0", fontWeight: 500 }}>
            {ov.title}
          </Title>
        )}
      </div>

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
          {ov.hasDiagram && (
            <div
              style={{
                marginBottom: 12,
                border: "1px solid #f0f0f0",
                borderRadius: 8,
                overflow: "auto",
                background: "#ffffff",
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
          <Markdown>{ov.overviewMd}</Markdown>

          {/* Ask a grounded question — the agent investigates the checkout and
              appends the Q&A to the overview above. */}
          <QuestionBox prKey={prKey} busy={!!generating} onAsked={load} />
        </>
      )}
    </div>
  );
}

function QuestionBox({
  prKey,
  busy,
  onAsked,
}: {
  prKey: string;
  busy: boolean;
  onAsked: () => void;
}) {
  const [q, setQ] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const ask = async () => {
    const text = q.trim();
    if (!text) return;
    setSubmitting(true);
    try {
      await askPrQuestion(prKey, text);
      setQ("");
      onAsked();
    } catch (e: any) {
      message.error(e?.message ?? "Question failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ marginTop: 16, borderTop: "1px solid #f0f0f0", paddingTop: 12, paddingBottom: 24 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        <QuestionCircleOutlined /> Ask about this PR — the agent investigates the code and
        appends the answer above.
      </Text>
      <Space.Compact style={{ width: "100%", marginTop: 6 }}>
        <Input.TextArea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. Does this handle the empty-contentIds case on mount?"
          autoSize={{ minRows: 1, maxRows: 4 }}
          disabled={busy || submitting}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={submitting || busy}
          disabled={!q.trim()}
          onClick={ask}
        >
          Ask
        </Button>
      </Space.Compact>
      {busy && (
        <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 6 }}>
          Investigating…
        </Text>
      )}
    </div>
  );
}
