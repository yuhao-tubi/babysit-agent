import { useCallback, useEffect, useState } from "react";
import type { ThreadDetail } from "./types";
import { fetchThread, sendInstruction } from "./api";

export function ThreadDetailView({ id, onChanged }: { id: number; onChanged: () => void }) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchThread(id).then(setDetail).catch(() => setDetail(null));
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  if (!detail) return <p>Loading #{id}…</p>;

  const submit = async () => {
    if (!instruction.trim()) return;
    setBusy(true);
    await sendInstruction(id, instruction);
    setInstruction("");
    setBusy(false);
    onChanged();
    load();
  };

  return (
    <div style={{ maxWidth: 880 }}>
      <h2 style={{ marginBottom: 2 }}>
        {detail.prKey}{" "}
        <span style={{ fontSize: 13, opacity: 0.6 }}>
          {detail.threadKey} · {detail.status} · {detail.authorClass}
        </span>
      </h2>

      {detail.verdict && (
        <section style={card}>
          <strong>Verdict: {detail.verdict.action}</strong> (risk {detail.verdict.risk})
          <p style={{ margin: "4px 0" }}>{detail.verdict.summary}</p>
          {detail.verdict.reply_draft && (
            <pre style={pre}>{detail.verdict.reply_draft}</pre>
          )}
        </section>
      )}

      <section style={card}>
        <strong>Feedback ({detail.items.length})</strong>
        {detail.items.map((it) => (
          <div key={it.ghId} style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {it.author} ({it.authorType}) · {it.kind}
              {it.path ? ` · ${it.path}${it.line ? `:${it.line}` : ""}` : ""}
              {it.htmlUrl && (
                <>
                  {" · "}
                  <a href={it.htmlUrl} target="_blank" rel="noreferrer">
                    open
                  </a>
                </>
              )}
            </div>
            <pre style={pre}>{it.body}</pre>
          </div>
        ))}
      </section>

      {detail.diff && (
        <section style={card}>
          <strong>Proposed diff</strong>
          <pre style={{ ...pre, maxHeight: 320 }}>{detail.diff}</pre>
        </section>
      )}

      <section style={card}>
        <strong>Your instruction</strong>
        <div style={{ fontSize: 12, opacity: 0.7, margin: "2px 0 6px" }}>
          Freeform — e.g. “add the null check, it’s valid”, “reply: out of scope, separate
          PR”, or “ignore”.
        </div>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={3}
          style={{ width: "100%", fontFamily: "inherit" }}
        />
        <button onClick={submit} disabled={busy} style={{ marginTop: 6 }}>
          {busy ? "Sending…" : "Send to agent"}
        </button>
      </section>

      <section style={card}>
        <strong>Activity</strong>
        {detail.events.map((e, i) => (
          <div key={i} style={{ fontSize: 12, opacity: 0.8 }}>
            <code>{e.kind}</code> — {e.message}
          </div>
        ))}
      </section>
    </div>
  );
}

const card: React.CSSProperties = {
  border: "1px solid #8884",
  borderRadius: 8,
  padding: 12,
  marginTop: 12,
};
const pre: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  background: "#8881",
  padding: 8,
  borderRadius: 6,
  fontSize: 12,
  overflowX: "auto",
};
