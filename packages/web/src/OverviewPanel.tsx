import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Input, Modal, Space, Spin, Tag, Typography, message } from "antd";
import {
  FileTextOutlined,
  GithubOutlined,
  ReloadOutlined,
  QuestionCircleOutlined,
  SendOutlined,
} from "@ant-design/icons";
import type { PrOverview } from "./types";
import {
  askPrQuestion,
  fetchPrOverview,
  generatePrBlindSpots,
  generatePrOverview,
  generatePrQuiz,
} from "./api";
import { Markdown } from "./Markdown";
import { DiagramSet } from "./DiagramSet";
import { RisksPanel } from "./RisksPanel";
import { QuizPanel } from "./QuizPanel";
import { VscodeLink } from "./prLinks";

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
  const [quizBusy, setQuizBusy] = useState(false);
  const [blindSpotsBusy, setBlindSpotsBusy] = useState(false);

  const load = useCallback(() => {
    fetchPrOverview(prKey)
      .then((next) => {
        // Guard against a stale fetch resolving after the owner switched PRs —
        // only accept the response that matches the PR we're now showing.
        if (next?.prKey === prKey) setOv(next);
      })
      .catch(() => setOv(null));
  }, [prKey]);

  // Clear the previous PR's artifact the instant prKey changes — otherwise the
  // header updates but the stale diagram (and prose) keep rendering until the
  // new fetch resolves, showing PR B's canvas under PR A's title.
  useEffect(() => {
    setOv(null);
  }, [prKey]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const runGenerate = async () => {
    setLoading(true);
    try {
      await generatePrOverview(prKey);
      load();
    } finally {
      setLoading(false);
    }
  };

  const generate = () => {
    // Regenerate throws away the whole artifact — warn if the owner hand-edited
    // a diagram, since those edits are the durable truth until they Regenerate.
    if (ov?.diagramsEditedAt) {
      Modal.confirm({
        title: "Discard your manual diagram edits?",
        content:
          "You've edited and saved a diagram. Regenerating runs the agent from scratch and replaces all canvases — your manual edits will be lost.",
        okText: "Regenerate (discard edits)",
        okButtonProps: { danger: true },
        cancelText: "Keep my edits",
        onOk: runGenerate,
      });
      return;
    }
    void runGenerate();
  };

  const runQuiz = async () => {
    setQuizBusy(true);
    try {
      await generatePrQuiz(prKey);
      load();
    } finally {
      setQuizBusy(false);
    }
  };

  const runBlindSpots = async () => {
    setBlindSpotsBusy(true);
    try {
      await generatePrBlindSpots(prKey);
      load();
    } finally {
      setBlindSpotsBusy(false);
    }
  };

  const generating = ov?.status === "generating";
  const hasArtifact = ov?.status === "ready" || (ov?.overviewMd && ov.status !== "generating");
  const hasDiagrams = !!ov && Object.keys(ov.diagrams ?? {}).length > 0;

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
          {ov && <VscodeLink githubUrl={ov.url} />}
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
          description="No usable output, or the diagram renderer is unavailable (run `make setup-render` to install Chromium). Try Regenerate."
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
          {hasDiagrams && <DiagramSet prKey={prKey} diagrams={ov.diagrams} />}
          <Markdown>{ov.overviewMd}</Markdown>

          {/* Risk analysis. Reviewer PRs: Verified risks produced by the same
              Generate run (no button). Author PRs: on-demand Blind spots with
              their own Generate control, grounded on the overview above. */}
          {ov.role === "reviewer" ? (
            <RisksPanel risks={ov.risks ?? []} status={ov.risksStatus} />
          ) : (
            <RisksPanel
              risks={ov.risks ?? []}
              status={ov.risksStatus}
              mode="author"
              stale={!!ov.risksStale}
              hasOverview={!!ov.overviewMd}
              busy={blindSpotsBusy}
              onGenerate={runBlindSpots}
            />
          )}

          {/* PR-comprehension quiz — its own on-demand agent run, grounded on the
              overview above. Multiple-choice, graded client-side. */}
          <QuizPanel
            prKey={prKey}
            quiz={ov.quiz ?? []}
            status={ov.quizStatus}
            stale={!!ov.quizStale}
            hasOverview={!!ov.overviewMd}
            busy={quizBusy}
            onGenerate={runQuiz}
          />

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
