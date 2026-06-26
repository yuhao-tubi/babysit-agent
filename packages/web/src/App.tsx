import { useCallback, useEffect, useState } from "react";
import type { PrGroup, ThreadSummary, ThreadStatus } from "./types";
import { fetchConfig, fetchPrs, triggerPoll } from "./api";
import { useEventStream } from "./useEventStream";
import { ThreadDetailView } from "./ThreadDetail";

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
  const [cfg, setCfg] = useState<{ dryRun: boolean; githubLogin: string } | null>(null);

  const reload = useCallback(() => {
    fetchPrs().then(setPrs);
  }, []);

  useEffect(() => {
    reload();
    fetchConfig().then(setCfg);
  }, [reload]);

  useEffect(() => {
    const onHash = () => setSelected(currentHashId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEventStream(reload);

  const select = (id: number) => {
    location.hash = `#/thread/${id}`;
    setSelected(id);
  };

  // Deep-linked PR (from a notification): default-select its first thread.
  const linkedPr = currentHashPr();
  useEffect(() => {
    if (!linkedPr || selected != null) return;
    const pr = prs.find((p) => p.prKey === linkedPr);
    if (pr && pr.threads.length) select(pr.threads[0].id);
  }, [linkedPr, prs, selected]);

  return (
    <div style={{ display: "flex", height: "100vh", fontSize: 14 }}>
      <aside style={{ width: 360, borderRight: "1px solid #8884", overflowY: "auto", padding: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: "4px 0" }}>PR Babysitter</h2>
          <button onClick={() => triggerPoll().then(reload)}>Poll now</button>
        </div>
        {cfg && (
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
            {cfg.githubLogin} ·{" "}
            <span style={{ color: cfg.dryRun ? "#c80" : "#0a0" }}>
              {cfg.dryRun ? "DRY RUN" : "LIVE"}
            </span>
          </div>
        )}
        {prs.length === 0 && (
          <p style={{ opacity: 0.6 }}>No PRs with feedback yet.</p>
        )}
        {prs.map((pr) => (
          <PrNode
            key={pr.prKey}
            pr={pr}
            selected={selected}
            onSelect={select}
            defaultOpen={pr.status !== "resolved" || pr.prKey === linkedPr}
          />
        ))}
      </aside>
      <main style={{ flex: 1, overflowY: "auto", padding: 20 }}>
        {selected != null ? (
          <ThreadDetailView id={selected} onChanged={reload} />
        ) : (
          <p style={{ opacity: 0.6 }}>Select a thread.</p>
        )}
      </main>
    </div>
  );
}

const STATUS_COLOR: Record<ThreadStatus, string> = {
  blocked: "#e55",
  error: "#e55",
  pending: "#08f",
  in_progress: "#08f",
  resolved: "#0a0",
};

function PrNode({
  pr,
  selected,
  onSelect,
  defaultOpen,
}: {
  pr: PrGroup;
  selected: number | null;
  onSelect: (id: number) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const badge = [
    pr.counts.blocked ? `${pr.counts.blocked} blocked` : "",
    pr.counts.ongoing ? `${pr.counts.ongoing} ongoing` : "",
    pr.counts.resolved ? `${pr.counts.resolved} resolved` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div style={{ marginBottom: 10 }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}
      >
        <span style={{ fontWeight: 600 }}>
          <span style={{ opacity: 0.5, marginRight: 4 }}>{open ? "▾" : "▸"}</span>
          {pr.prKey}
        </span>
        <span style={{ color: STATUS_COLOR[pr.status], fontSize: 11 }}>{pr.status}</span>
      </div>
      <div style={{ fontSize: 11, opacity: 0.6, margin: "1px 0 4px 16px" }}>
        {pr.title}
        {badge && <> · {badge}</>}
      </div>
      {open &&
        pr.threads.map((t) => (
          <ThreadRow key={t.id} t={t} active={t.id === selected} onClick={() => onSelect(t.id)} />
        ))}
    </div>
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
        padding: "5px 8px",
        marginLeft: 16,
        borderRadius: 6,
        cursor: "pointer",
        background: active ? "#88f3" : "transparent",
        marginBottom: 2,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 12, opacity: 0.85 }}>{t.threadKey}</span>
        <span style={{ color: STATUS_COLOR[t.status], fontSize: 11 }}>{t.status}</span>
      </div>
      <div style={{ fontSize: 12, opacity: 0.7 }}>
        {t.authorClass} · {t.action ?? "—"}
      </div>
      {t.summary && (
        <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>{t.summary}</div>
      )}
    </div>
  );
}
