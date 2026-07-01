import { Tag } from "antd";
import type { ThreadStatus } from "./types";

/** antd preset colors per thread status. */
const STATUS_PRESET: Record<ThreadStatus, string> = {
  blocked: "error",
  error: "error",
  awaiting_approval: "gold",
  pending: "processing",
  in_progress: "processing",
  resolved: "success",
};

const STATUS_LABEL: Record<ThreadStatus, string> = {
  blocked: "Blocked",
  error: "Error",
  awaiting_approval: "Awaiting approval",
  pending: "Pending",
  in_progress: "In progress",
  resolved: "Resolved",
};

export function StatusTag({ status }: { status: ThreadStatus }) {
  return (
    <Tag color={STATUS_PRESET[status]} style={{ marginInlineEnd: 0 }}>
      {STATUS_LABEL[status]}
    </Tag>
  );
}
