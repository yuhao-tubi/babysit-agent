/**
 * GITHUB-SIDE PR state badges: review approvals and check results.
 *
 * Kept visually distinct from the babysitter's own state (the status tag and the
 * per-thread count badges): these say what GitHub thinks, as of the last poll.
 * Both are quiet by default — a healthy PR grows no badge, so a badge always
 * means "look at me".
 */
import { Space, Tag, Tooltip } from "antd";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
} from "@ant-design/icons";
import type { ChecksSummary, ReviewDecision } from "./types";

/**
 * Every badge is only as fresh as the poll that produced it — say so. Plain text
 * rather than `RelativeTime`, which nests its own tooltip (unusable inside one).
 */
function AsOf({ at }: { at: string | null }) {
  if (!at) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return <div style={{ fontSize: 11, opacity: 0.75 }}>as of {d.toLocaleTimeString()}</div>;
}

/**
 * Review approvals. We report GitHub's decision plus how many PEOPLE have
 * approved — never "1 of 2", because the required-approval count lives in branch
 * protection, which our `gh` token cannot read (see CONTEXT.md).
 */
export function ApprovalTag({
  decision,
  approvals,
  lastPolled,
}: {
  decision: ReviewDecision | null;
  approvals: number;
  lastPolled: string | null;
}) {
  if (decision === "APPROVED") {
    return (
      <Tooltip title={<AsOf at={lastPolled} />}>
        <Tag color="success" icon={<CheckCircleOutlined />} style={{ marginInlineEnd: 0 }}>
          {approvals} approved
        </Tag>
      </Tooltip>
    );
  }
  if (decision === "CHANGES_REQUESTED") {
    return (
      <Tooltip title={<AsOf at={lastPolled} />}>
        <Tag color="error" icon={<CloseCircleOutlined />} style={{ marginInlineEnd: 0 }}>
          changes requested
        </Tag>
      </Tooltip>
    );
  }
  // REVIEW_REQUIRED, or no decision at all: state the count and stop. Zero
  // approvals on a PR nobody has to review is not news, so nothing is shown.
  if (decision !== "REVIEW_REQUIRED" && approvals === 0) return null;
  return (
    <Tooltip
      title={
        <>
          {decision === "REVIEW_REQUIRED" ? "Review still required" : "No review required"}
          <AsOf at={lastPolled} />
        </>
      }
    >
      <Tag style={{ marginInlineEnd: 0 }}>
        {approvals > 0 ? `${approvals} approved` : "no reviews"}
      </Tag>
    </Tooltip>
  );
}

/**
 * Check results — red when something failed, yellow while checks are in flight,
 * NOTHING when everything is green. Counts every check on the head, not just the
 * babysat allowlist: the question this answers is "is my PR red".
 */
export function ChecksTag({
  checks,
  prUrl,
  lastPolled,
}: {
  checks: ChecksSummary | null;
  prUrl: string;
  lastPolled: string | null;
}) {
  if (!checks) return null;
  const url = `${prUrl}/checks`;
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  if (checks.failing.length > 0) {
    return (
      <Tooltip
        title={
          <>
            {checks.failing.map((n) => (
              <div key={n}>{n}</div>
            ))}
            <AsOf at={lastPolled} />
          </>
        }
      >
        <a href={url} target="_blank" rel="noreferrer" onClick={stop}>
          <Tag color="error" icon={<CloseCircleOutlined />} style={{ marginInlineEnd: 0 }}>
            {checks.failing.length} failing
          </Tag>
        </a>
      </Tooltip>
    );
  }
  if (checks.pending > 0) {
    return (
      <Tooltip title={<AsOf at={lastPolled} />}>
        <a href={url} target="_blank" rel="noreferrer" onClick={stop}>
          <Tag color="warning" icon={<LoadingOutlined />} style={{ marginInlineEnd: 0 }}>
            {checks.pending} running
          </Tag>
        </a>
      </Tooltip>
    );
  }
  return null; // all green — no badge
}

/** The pair, as rendered on a PR row. Hidden for expired PRs (see below). */
export function PrGithubState({
  decision,
  approvals,
  checks,
  prUrl,
  lastPolled,
  expiredAt,
}: {
  decision: ReviewDecision | null;
  approvals: number;
  checks: ChecksSummary | null;
  prUrl: string;
  lastPolled: string | null;
  expiredAt: string | null;
}) {
  // An expired PR's last-seen check state froze just before it merged, so a red
  // "2 failing" there would be a lie about a PR that is already gone.
  if (expiredAt) return null;
  return (
    <Space size={4}>
      <ApprovalTag decision={decision} approvals={approvals} lastPolled={lastPolled} />
      <ChecksTag checks={checks} prUrl={prUrl} lastPolled={lastPolled} />
    </Space>
  );
}
