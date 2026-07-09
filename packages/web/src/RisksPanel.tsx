import { Alert, Collapse, Space, Tag, Typography } from "antd";
import {
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  ExclamationCircleOutlined,
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
 * Verified Risk Analysis panel (reviewer PRs). Confirmed/unverified risks render
 * as severity-tagged collapsible cards, sorted high→low by the server. Dismissed
 * risks (false positives the confirmer rejected, with cited rationale) collapse
 * into a "Considered & dismissed" group at the bottom.
 */
export function RisksPanel({
  risks,
  status,
}: {
  risks: RiskItem[];
  status: RiskStatus | null;
}) {
  if (status == null) return null;

  if (status === "failed") {
    return (
      <div style={{ marginTop: 16 }}>
        <SectionHeader />
        <Alert
          type="error"
          showIcon
          message="Risk analysis failed"
          description="The finder pass produced no usable output. Try Regenerate."
          style={{ marginTop: 6 }}
        />
      </div>
    );
  }

  const shown = risks.filter((r) => r.state !== "dismissed");
  const dismissed = risks.filter((r) => r.state === "dismissed");

  return (
    <div style={{ marginTop: 16 }}>
      <SectionHeader count={shown.length} />
      {shown.length === 0 ? (
        <Alert
          type="success"
          showIcon
          message="No significant risks identified"
          description="The agent reviewed the change and found nothing a reviewer must scrutinize."
          style={{ marginTop: 6 }}
        />
      ) : (
        <Collapse
          style={{ marginTop: 6 }}
          items={shown.map((r) => ({
            key: r.id,
            label: <RiskLabel risk={r} />,
            children: <RiskBody risk={r} />,
          }))}
        />
      )}

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
    </div>
  );
}

function SectionHeader({ count }: { count?: number }) {
  return (
    <Text type="secondary" style={{ fontSize: 12 }}>
      <WarningOutlined /> Verified risk analysis{count != null ? ` (${count})` : ""}
    </Text>
  );
}

function RiskLabel({ risk }: { risk: RiskItem }) {
  return (
    <Space size={6} wrap>
      <Tag color={LEVEL_COLOR[risk.level]}>{risk.level.toUpperCase()}</Tag>
      <Text strong style={{ fontSize: 13 }}>
        {risk.title}
      </Text>
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
