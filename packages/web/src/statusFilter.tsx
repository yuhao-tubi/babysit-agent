/**
 * STATUS FILTER — narrow the sidebar to the Threads in a chosen set of statuses.
 *
 * Display-only, client-side, never persisted: it reshapes the rows already
 * fetched and reaches nothing on the server. Both sidebar views (Current and
 * Expired) share the one control, which is why it lives below their toggle.
 *
 * Scoped to AUTHORED PRs on purpose. A review-only PR is overview-only and never
 * has Threads (see CONTEXT.md), so a Thread-status filter has nothing to say
 * about one — it passes through untouched rather than that whole section
 * silently vanishing the moment you pick a status.
 */
import { Checkbox, Typography } from "antd";
import type { PrGroup, ThreadStatus } from "./types";
import { STATUS_LABEL } from "./status";

/**
 * Filter options in the sidebar's own urgency order (needs-you first), matching
 * the server's `statusRank`, so the dropdown reads top-to-bottom like the tree.
 */
export const STATUS_FILTER_ORDER: ThreadStatus[] = [
  "blocked",
  "error",
  "awaiting_approval",
  "pending",
  "in_progress",
  "resolved",
];

/** How many Threads sit in each status, across the authored PRs of one view. */
export function statusCounts(prs: PrGroup[]): Record<ThreadStatus, number> {
  const out = Object.fromEntries(
    STATUS_FILTER_ORDER.map((s) => [s, 0])
  ) as Record<ThreadStatus, number>;
  for (const pr of prs) {
    if (pr.role !== "author") continue;
    for (const t of pr.threads) out[t.status] = (out[t.status] ?? 0) + 1;
  }
  return out;
}

/**
 * Keep only the Threads in `statuses`, and drop an authored PR left with none.
 *
 * An empty selection means "no filter" and returns the input untouched. The PR
 * row's own rollup tag and count badges are deliberately NOT recomputed: they
 * state the PR's real state, which is still true while you look at a slice of it.
 */
export function applyStatusFilter(prs: PrGroup[], statuses: ThreadStatus[]): PrGroup[] {
  if (!statuses.length) return prs;
  const want = new Set(statuses);
  const out: PrGroup[] = [];
  for (const pr of prs) {
    if (pr.role !== "author") {
      out.push(pr);
      continue;
    }
    const threads = pr.threads.filter((t) => want.has(t.status));
    if (!threads.length) continue;
    out.push({ ...pr, threads });
  }
  return out;
}

/**
 * A fingerprint of the active filter, used as part of each PR card's React key
 * so the cards remount when it changes — that is what lets a filtered PR come
 * back open (antd's `defaultActiveKey` is only read on mount).
 */
export function statusFilterKey(statuses: ThreadStatus[]): string {
  return statuses.length ? [...statuses].sort().join(",") : "all";
}

/**
 * The statuses, always on screen as checkboxes — every option and its count is
 * readable without opening anything, which is the point of the control: you
 * decide whether there is anything worth filtering to before you click.
 *
 * Two columns, in urgency order down the list, so it fits the sidebar's width
 * without truncating "Awaiting approval".
 */
export function ThreadStatusFilter({
  value,
  onChange,
  counts,
}: {
  value: ThreadStatus[];
  onChange: (v: ThreadStatus[]) => void;
  /** Omitted where a total would be a lie (the Expired view pages in lazily). */
  counts?: Record<ThreadStatus, number>;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <Typography.Text
          type="secondary"
          strong
          style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}
        >
          Thread status
        </Typography.Text>
        {value.length > 0 && (
          <Typography.Link style={{ fontSize: 11 }} onClick={() => onChange([])}>
            Clear
          </Typography.Link>
        )}
      </div>
      <Checkbox.Group
        value={value}
        onChange={(v) => onChange(v as ThreadStatus[])}
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", rowGap: 2 }}
      >
        {STATUS_FILTER_ORDER.map((s) => (
          <Checkbox key={s} value={s} style={{ fontSize: 12, marginInlineEnd: 0 }}>
            {STATUS_LABEL[s]}
            {counts && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {" "}
                ({counts[s] ?? 0})
              </Typography.Text>
            )}
          </Checkbox>
        ))}
      </Checkbox.Group>
    </div>
  );
}
