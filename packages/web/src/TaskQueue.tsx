import { Badge, Dropdown, Empty, Space, Spin, Typography } from "antd";
import {
  LoadingOutlined,
  ClockCircleOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import type { PrGroup, ThreadSummary } from "./types";
import { RelativeTime } from "./RelativeTime";

const { Text } = Typography;

interface QueuedTask extends ThreadSummary {
  prKey: string;
}

/** Flatten threads into the work the agent is doing now / will do next. */
function queueFromPrs(prs: PrGroup[]): { running: QueuedTask[]; pending: QueuedTask[] } {
  const running: QueuedTask[] = [];
  const pending: QueuedTask[] = [];
  for (const pr of prs) {
    // Expired (merged/closed) PRs are read-only history; the pipeline no longer
    // acts on their threads, so they never count as queued work.
    if (pr.expiredAt) continue;
    for (const t of pr.threads) {
      const task = { ...t, prKey: pr.prKey };
      if (t.status === "in_progress") running.push(task);
      else if (t.status === "pending") pending.push(task);
    }
  }
  // Most-recently-touched first within each bucket.
  const byRecent = (a: QueuedTask, b: QueuedTask) =>
    b.updatedAt.localeCompare(a.updatedAt);
  return { running: running.sort(byRecent), pending: pending.sort(byRecent) };
}

function TaskRow({ task, running }: { task: QueuedTask; running: boolean }) {
  return (
    <div
      onClick={() => {
        location.hash = `#/thread/${task.id}`;
      }}
      style={{
        padding: "6px 8px",
        borderRadius: 6,
        cursor: "pointer",
        border: "1px solid #f0f0f0",
        background: running ? "#f0f3ff" : "#fafafa",
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
        <Space size={6} style={{ minWidth: 0 }}>
          {running ? (
            <Spin indicator={<LoadingOutlined spin style={{ fontSize: 12 }} />} />
          ) : (
            <ClockCircleOutlined style={{ color: "rgba(0,0,0,0.35)", fontSize: 12 }} />
          )}
          <Text style={{ fontSize: 12 }} ellipsis>
            {task.prKey}
          </Text>
        </Space>
        <RelativeTime at={task.updatedAt} />
      </div>
      <div style={{ marginTop: 2 }}>
        <Text type="secondary" style={{ fontSize: 12 }} ellipsis>
          {task.threadKey} · {task.action ?? "deciding…"}
        </Text>
      </div>
    </div>
  );
}

/** Top-bar trigger + hover dropdown showing the agent's task queue. */
export function TaskQueue({ prs }: { prs: PrGroup[] }) {
  const { running, pending } = queueFromPrs(prs);
  const active = running.length + pending.length;

  const panel = (
    <div
      style={{
        width: 340,
        maxHeight: 420,
        overflowY: "auto",
        background: "#fff",
        borderRadius: 8,
        boxShadow: "0 6px 16px rgba(0,0,0,0.12)",
        border: "1px solid #f0f0f0",
        padding: 12,
      }}
    >
      <Text strong>Task queue</Text>
      {active === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Idle — nothing queued."
          style={{ margin: "16px 0" }}
        />
      ) : (
        <Space direction="vertical" size={10} style={{ width: "100%", marginTop: 10 }}>
          {running.length > 0 && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Running ({running.length})
              </Text>
              <Space direction="vertical" size={6} style={{ width: "100%", marginTop: 6 }}>
                {running.map((t) => (
                  <TaskRow key={t.id} task={t} running />
                ))}
              </Space>
            </div>
          )}
          {pending.length > 0 && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Queued ({pending.length})
              </Text>
              <Space direction="vertical" size={6} style={{ width: "100%", marginTop: 6 }}>
                {pending.map((t) => (
                  <TaskRow key={t.id} task={t} running={false} />
                ))}
              </Space>
            </div>
          )}
        </Space>
      )}
    </div>
  );

  return (
    <Dropdown
      placement="bottomRight"
      trigger={["hover"]}
      popupRender={() => panel}
    >
      <Space size={6} style={{ cursor: "pointer" }}>
        <Badge count={active} size="small" offset={[2, -2]}>
          <UnorderedListOutlined style={{ fontSize: 18, color: "rgba(0,0,0,0.65)" }} />
        </Badge>
        <Text type="secondary">
          {running.length > 0 ? `${running.length} running` : "Task queue"}
          {pending.length > 0 ? ` · ${pending.length} queued` : ""}
        </Text>
      </Space>
    </Dropdown>
  );
}
