import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Collapse,
  Empty,
  Layout,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { ReloadOutlined, GithubOutlined, FileTextOutlined } from "@ant-design/icons";
import type { PrGroup, ThreadSummary } from "./types";
import { fetchConfig, fetchPrs, triggerPoll } from "./api";
import { useEventStream } from "./useEventStream";
import { ThreadDetailView } from "./ThreadDetail";
import { StatusTag } from "./status";
import { RelativeTime } from "./RelativeTime";
import { TaskQueue } from "./TaskQueue";
import { OverviewPanel } from "./OverviewPanel";

const { Sider, Header, Content } = Layout;
const { Title, Text, Paragraph } = Typography;

function currentHashId(): number | null {
  const m = location.hash.match(/#\/thread\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function currentHashPr(): string | null {
  const m = location.hash.match(/#\/pr\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function App() {
  const [prs, setPrs] = useState<PrGroup[]>([]);
  const [selected, setSelected] = useState<number | null>(currentHashId());
  // A PR selected to view its overview+diagram in the main pane (mutually
  // exclusive with a selected thread).
  const [selectedPr, setSelectedPr] = useState<string | null>(currentHashPr());
  const [cfg, setCfg] = useState<{
    dryRun: boolean;
    githubLogin: string;
    pollIntervalMs: number;
    lastPolledAt: string | null;
  } | null>(null);
  const [polling, setPolling] = useState(false);
  // Per-PR counter bumped on each `pr_overview_updated` SSE event; passed to the
  // OverviewPanel so it re-fetches live during generation.
  const [overviewTicks, setOverviewTicks] = useState<Record<string, number>>({});

  const reload = useCallback(() => {
    fetchPrs().then(setPrs);
    fetchConfig().then(setCfg);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const onHash = () => {
      setSelected(currentHashId());
      setSelectedPr(currentHashPr());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const onEvent = useCallback(
    (ev: Parameters<Parameters<typeof useEventStream>[0]>[0]) => {
      if (ev?.type === "pr_overview_updated") {
        setOverviewTicks((t) => ({ ...t, [ev.prKey]: (t[ev.prKey] ?? 0) + 1 }));
        return; // overview progress doesn't change the PR/thread tree
      }
      reload();
    },
    [reload]
  );

  useEventStream(onEvent);

  const select = (id: number) => {
    location.hash = `#/thread/${id}`;
    setSelected(id);
    setSelectedPr(null);
  };

  const selectPr = (prKey: string) => {
    location.hash = `#/pr/${encodeURIComponent(prKey)}`;
    setSelectedPr(prKey);
    setSelected(null);
  };

  const poll = async () => {
    setPolling(true);
    try {
      await triggerPoll();
      reload();
    } finally {
      setPolling(false);
    }
  };

  // Deep-linked PR (from a notification) opens its overview in the main pane
  // via `selectedPr` (set from the hash); no thread auto-select needed.
  const linkedPr = selectedPr;

  return (
    <Layout style={{ height: "100vh" }}>
      <Sider
        width={380}
        theme="light"
        style={{
          borderInlineEnd: "1px solid #f0f0f0",
          height: "100vh",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            height: "100%",
          }}
        >
        <div
          style={{
            padding: "16px 16px 12px",
            borderBottom: "1px solid #f0f0f0",
          }}
        >
          <Space style={{ width: "100%", justifyContent: "space-between" }}>
            <Title level={4} style={{ margin: 0 }}>
              PR Babysitter
            </Title>
            <Tooltip title="Poll for new feedback now">
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={polling}
                onClick={poll}
              >
                Poll
              </Button>
            </Tooltip>
          </Space>
          {cfg && (
            <>
              <Space size={6} style={{ marginTop: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  <GithubOutlined /> {cfg.githubLogin}
                </Text>
                <Tag
                  color={cfg.dryRun ? "warning" : "success"}
                  style={{ marginInlineEnd: 0 }}
                >
                  {cfg.dryRun ? "DRY RUN" : "LIVE"}
                </Tag>
              </Space>
              <div style={{ marginTop: 4 }}>
                <RelativeTime at={cfg.lastPolledAt} prefix="Last polled" />
              </div>
            </>
          )}
        </div>

        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: 12 }}>
          {prs.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No PRs with feedback yet."
              style={{ marginTop: 48 }}
            />
          ) : (
            <Space direction="vertical" size={10} style={{ width: "100%" }}>
              {prs.map((pr) => (
                <PrNode
                  key={pr.prKey}
                  pr={pr}
                  selected={selected}
                  selectedPr={selectedPr}
                  onSelect={select}
                  onSelectPr={selectPr}
                  defaultOpen={
                    (pr.role === "author" && pr.status !== "resolved") ||
                    pr.prKey === linkedPr
                  }
                />
              ))}
            </Space>
          )}
        </div>
        </div>
      </Sider>

      <Layout>
        <Header
          style={{
            background: "#fff",
            borderBottom: "1px solid #f0f0f0",
            paddingInline: 24,
            display: "flex",
            alignItems: "center",
            height: 56,
            lineHeight: "56px",
            justifyContent: "space-between",
          }}
        >
          <Text type="secondary">Review feedback triage & agent dispatch</Text>
          <TaskQueue prs={prs} />
        </Header>
        <Content
          style={{
            overflowY: "auto",
            padding: 24,
            display: "flex",
            justifyContent: "center",
          }}
        >
          {selected != null ? (
            <ThreadDetailView id={selected} onChanged={reload} />
          ) : selectedPr != null ? (
            <div style={{ width: "100%", maxWidth: 1100 }}>
              <OverviewPanel
                prKey={selectedPr}
                refreshKey={overviewTicks[selectedPr] ?? 0}
              />
            </div>
          ) : (
            <div
              style={{
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Empty description="Select a thread or PR to view details." />
            </div>
          )}
        </Content>
      </Layout>
    </Layout>
  );
}

function PrNode({
  pr,
  selected,
  selectedPr,
  onSelect,
  onSelectPr,
  defaultOpen,
}: {
  pr: PrGroup;
  selected: number | null;
  selectedPr: string | null;
  onSelect: (id: number) => void;
  onSelectPr: (prKey: string) => void;
  defaultOpen: boolean;
}) {
  const counts =
    pr.role === "reviewer" ? (
      <Text type="secondary" style={{ fontSize: 12 }}>
        Overview only
      </Text>
    ) : (
      <Space size={4}>
        {pr.counts.blocked > 0 && <Badge color="#ff4d4f" count={pr.counts.blocked} />}
        {pr.counts.awaiting > 0 && <Badge color="#faad14" count={pr.counts.awaiting} />}
        {pr.counts.ongoing > 0 && <Badge color="#1677ff" count={pr.counts.ongoing} />}
        {pr.counts.resolved > 0 && <Badge color="#52c41a" count={pr.counts.resolved} />}
      </Space>
    );

  return (
    <Collapse
      defaultActiveKey={defaultOpen ? [pr.prKey] : []}
      size="small"
      items={[
        {
          key: pr.prKey,
          label: (
            <div style={{ width: "100%", minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <Space size={6} style={{ minWidth: 0 }}>
                  <Text strong>{pr.prKey}</Text>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open PR on GitHub"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <GithubOutlined />
                  </a>
                </Space>
                {pr.role === "reviewer" ? (
                  <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                    REVIEW
                  </Tag>
                ) : (
                  <StatusTag status={pr.status} />
                )}
              </div>
              <div
                title={pr.title}
                style={{
                  fontSize: 12,
                  color: "rgba(0,0,0,0.45)",
                  margin: "2px 0",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {pr.title}
              </div>
              {counts}
            </div>
          ),
          children: (
            <Space direction="vertical" size={6} style={{ width: "100%" }}>
              {pr.threads.map((t) => (
                <ThreadRow
                  key={t.id}
                  t={t}
                  active={t.id === selected}
                  onClick={() => onSelect(t.id)}
                />
              ))}
              {/* Opens the overview + diagram in the wide main pane. */}
              <div
                onClick={() => onSelectPr(pr.prKey)}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  cursor: "pointer",
                  border:
                    selectedPr === pr.prKey ? "1px solid #2f54eb" : "1px solid #f0f0f0",
                  background: selectedPr === pr.prKey ? "#f0f3ff" : "#fafafa",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <FileTextOutlined style={{ color: "#2f54eb" }} />
                <Text style={{ fontSize: 12 }}>Overview &amp; diagram</Text>
              </div>
            </Space>
          ),
        },
      ]}
    />
  );
}

function ThreadRow({
  t,
  active,
  onClick,
}: {
  t: ThreadSummary;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "8px 10px",
        borderRadius: 8,
        cursor: "pointer",
        border: active ? "1px solid #2f54eb" : "1px solid #f0f0f0",
        background: active ? "#f0f3ff" : "#fafafa",
        transition: "background 0.15s, border-color 0.15s",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        <Text style={{ fontSize: 12, minWidth: 0 }} ellipsis>
          {t.threadKey}
        </Text>
        <StatusTag status={t.status} />
      </div>
      <div
        style={{
          marginTop: 2,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t.authorClass} · {t.action ?? "—"}
        </Text>
        <RelativeTime at={t.updatedAt} />
      </div>
      {t.summary && (
        <Paragraph
          type="secondary"
          style={{ fontSize: 12, margin: "4px 0 0" }}
          ellipsis={{ rows: 2, tooltip: t.summary }}
        >
          {t.summary}
        </Paragraph>
      )}
    </div>
  );
}
