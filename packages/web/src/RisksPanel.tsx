import { Alert, Button, Collapse, Space, Tag, Typography } from "antd";
import {
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  ExclamationCircleOutlined,
  ReloadOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { RiskItem, RiskLevel, RiskStatus } from "./types";
import { Markdown } from "./Markdown";
import { Mermaid } from "./Mermaid";

const { Text } = Typography;

const LEVEL_COLOR: Record<RiskLevel, string> = {
  high: "red",
  medium: "orange",
  low: "blue",
};

/**
 * Risk analysis panel. Two roles, one shape (see CONTEXT.md / PR-resources spec):
 *  - reviewer: **Verified risks** on someone else's PR (produced by the same
 *    Generate run as the overview — no separate button).
 *  - author: **Blind spots** on your own change — an on-demand artifact like the
 *    quiz, so it carries its own Generate button, generating/stale states, and
 *    layer / not-in-description tags.
 * Confirmed/unverified risks render as severity-tagged collapsible cards, sorted
 * high→low by the server; dismissed risks collapse into a group at the bottom.
 */
export function RisksPanel({
  risks,
  status,
  mode = "reviewer",
  stale = false,
  hasOverview = true,
  busy = false,
  onGenerate,
}: {
  risks: RiskItem[];
  status: RiskStatus | null;
  /** "author" enables Blind-spot framing + the on-demand Generate control. */
  mode?: "reviewer" | "author";
  /** Author only: the analyzed head has moved (findings withheld until Regenerate). */
  stale?: boolean;
  /** Author only: gate generation on an existing overview (the finder is grounded on it). */
  hasOverview?: boolean;
  /** Author only: a request is in flight. */
  busy?: boolean;
  /** Author only: trigger (re)generation. */
  onGenerate?: () => void;
}) {
  const author = mode === "author";
  const generating = status === "generating";

  // Author panel always renders (it owns its Generate button); the reviewer panel
  // stays invisible until its piggybacked run has produced a status.
  if (!author && status == null) return null;

  const shown = risks.filter((r) => r.state !== "dismissed");
  const dismissed = risks.filter((r) => r.state === "dismissed");

  return (
    <div style={{ marginTop: 16, ...(author ? { borderTop: "1px solid #f0f0f0", paddingTop: 12 } : {}) }}>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 6 }}>
        <SectionHeader mode={mode} count={status === "ready" && !stale ? shown.length : undefined} />
        {author && (
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={busy || generating}
            disabled={!hasOverview || generating}
            onClick={onGenerate}
          >
            {status === "ready" && !stale ? "Regenerate" : "Find blind spots"}
          </Button>
        )}
      </Space>

      {author && !hasOverview && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          Generate an overview first — the blind-spot finder is grounded on it.
        </Text>
      )}

      {generating && (
        <Alert
          type="info"
          showIcon
          message={author ? "Hunting for blind spots…" : "Analyzing risks…"}
          description="Investigating the PR checkout across its layers. This runs a finder→confirmer pass and may take a minute or two."
          style={{ marginTop: 6 }}
        />
      )}

      {status === "failed" && !generating && (
        <Alert
          type="error"
          showIcon
          message={author ? "Blind-spot analysis failed" : "Risk analysis failed"}
          description="The finder pass produced no usable output. Try Regenerate."
          style={{ marginTop: 6 }}
        />
      )}

      {author && stale && !generating && status === "ready" && (
        <Alert
          type="warning"
          showIcon
          message="These blind spots are out of date"
          description="Your branch has moved since they were found. Regenerate to hunt against the current code."
          style={{ marginTop: 6 }}
        />
      )}

      {author && !generating && status == null && hasOverview && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          No blind-spot analysis yet. Click “Find blind spots” to hunt for downstream
          harm your change might cause.
        </Text>
      )}

      {status === "ready" && !stale && !generating && (
      shown.length === 0 ? (
        <Alert
          type="success"
          showIcon
          message={author ? "No blind spots found" : "No significant risks identified"}
          description={
            author
              ? "The finder hunted each layer of your change and found no downstream harm to flag."
              : "The agent reviewed the change and found nothing a reviewer must scrutinize."
          }
          style={{ marginTop: 6 }}
        />
      ) : (
        <>
          <Collapse
            style={{ marginTop: 6 }}
            items={shown.map((r) => ({
              key: r.id,
              label: <RiskLabel risk={r} />,
              children: <RiskBody risk={r} />,
            }))}
          />

          {dismissed.length > 0 && (
            <Collapse
              ghost
              style={{ marginTop: 8 }}
              items={[
                {
                  key: "dismissed",
                  label: (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Considered &amp; dismissed ({dismissed.length})
                    </Text>
                  ),
                  children: (
                    <Space direction="vertical" style={{ width: "100%" }} size={8}>
                      {dismissed.map((r) => (
                        <div key={r.id} style={{ opacity: 0.7 }}>
                          <Text delete style={{ fontSize: 13 }}>
                            {r.title}
                          </Text>
                          {r.verdict?.rationale && (
                            <div style={{ fontSize: 12, marginTop: 2 }}>
                              <Text type="secondary">Dismissed: {r.verdict.rationale}</Text>
                            </div>
                          )}
                        </div>
                      ))}
                    </Space>
                  ),
                },
              ]}
            />
          )}
        </>
      ))}
    </div>
  );
}

function SectionHeader({ mode, count }: { mode: "reviewer" | "author"; count?: number }) {
  const label = mode === "author" ? "Blind spots in your change" : "Verified risk analysis";
  return (
    <Text type="secondary" style={{ fontSize: 12 }}>
      <WarningOutlined /> {label}
      {count != null ? ` (${count})` : ""}
    </Text>
  );
}

function RiskLabel({ risk }: { risk: RiskItem }) {
  return (
    <Space size={6} wrap>
      <Tag color={LEVEL_COLOR[risk.level]}>{risk.level.toUpperCase()}</Tag>
      {risk.layer && <Tag color="geekblue">{risk.layer}</Tag>}
      <Text strong style={{ fontSize: 13 }}>
        {risk.title}
      </Text>
      {risk.inDescription === false && (
        <Tag color="gold" style={{ fontSize: 11 }}>
          not in your description
        </Tag>
      )}
      <a
        href={risk.location.permalink}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ fontSize: 12 }}
      >
        {risk.location.path}:{risk.location.startLine}
      </a>
    </Space>
  );
}

function RiskBody({ risk }: { risk: RiskItem }) {
  return (
    <Space direction="vertical" style={{ width: "100%" }} size={8}>
      {risk.category && (
        <Tag style={{ fontSize: 11 }}>{risk.category}</Tag>
      )}
      <Markdown>{risk.explanation}</Markdown>
      <Markdown>{risk.codeSnippet}</Markdown>
      {risk.mermaid && <Mermaid chart={risk.mermaid} />}
      <VerdictLine risk={risk} />
    </Space>
  );
}

function VerdictLine({ risk }: { risk: RiskItem }) {
  if (risk.state === "confirmed") {
    return (
      <Text style={{ fontSize: 12 }}>
        <CheckCircleTwoTone twoToneColor="#52c41a" /> Confirmed
        {risk.verdict?.rationale ? ` — ${risk.verdict.rationale}` : ""}
      </Text>
    );
  }
  if (risk.state === "unverified") {
    return (
      <Text type="warning" style={{ fontSize: 12 }}>
        <ExclamationCircleOutlined /> Not verified — the confirmer did not return a
        judgment for this risk.
      </Text>
    );
  }
  // dismissed risks never render here (they live in the dismissed group)
  return (
    <Text type="secondary" style={{ fontSize: 12 }}>
      <CloseCircleTwoTone twoToneColor="#bfbfbf" /> Dismissed
      {risk.verdict?.rationale ? ` — ${risk.verdict.rationale}` : ""}
    </Text>
  );
}
