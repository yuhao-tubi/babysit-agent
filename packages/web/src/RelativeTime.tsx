import { useEffect, useState } from "react";
import { Tooltip, Typography } from "antd";

const { Text } = Typography;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Human-friendly "3m ago" style label for a past ISO timestamp. */
function relativeLabel(iso: string, nowMs: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = nowMs - then;
  if (diff < 0) return "just now";
  if (diff < 45_000) return "just now";
  if (diff < HOUR) return `${Math.round(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.round(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.round(diff / DAY)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Exact local timestamp for the hover tooltip. */
function exactLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Renders a past timestamp as a relative label ("3m ago") that auto-refreshes,
 * with the exact local time shown on hover.
 */
export function RelativeTime({
  at,
  prefix,
  style,
}: {
  at: string | null | undefined;
  prefix?: string;
  style?: React.CSSProperties;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!at) return null;

  return (
    <Tooltip title={exactLabel(at)}>
      <Text type="secondary" style={{ fontSize: 12, ...style }}>
        {prefix ? `${prefix} ` : ""}
        {relativeLabel(at, nowMs)}
      </Text>
    </Tooltip>
  );
}
