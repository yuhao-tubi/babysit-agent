import type { PrGroup, ThreadDetail, PrOverview, DiagramSection, ExcalidrawDoc } from "./types";

export async function fetchPrs(): Promise<PrGroup[]> {
  const r = await fetch("/api/prs");
  return r.json();
}

export async function fetchThread(id: number): Promise<ThreadDetail> {
  const r = await fetch(`/api/threads/${id}`);
  if (!r.ok) throw new Error("not found");
  return r.json();
}

export async function sendInstruction(id: number, instruction: string): Promise<void> {
  await fetch(`/api/threads/${id}/instruct`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction }),
  });
}

export async function replyToThread(id: number, body: string): Promise<void> {
  await fetch(`/api/threads/${id}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

export async function resolveThread(id: number): Promise<void> {
  await fetch(`/api/threads/${id}/resolve`, { method: "POST" });
}

/** POST that surfaces the server's error body (e.g. a 409 "no proposal") instead
 *  of silently succeeding — so the UI can tell the owner the action didn't start. */
async function postOrThrow(url: string): Promise<void> {
  const r = await fetch(url, { method: "POST" });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed (${r.status})`);
  }
}

export async function approveThread(id: number): Promise<void> {
  await postOrThrow(`/api/threads/${id}/approve`);
}

export async function approveReply(id: number): Promise<void> {
  await postOrThrow(`/api/threads/${id}/approve-reply`);
}

export async function dismissReply(id: number): Promise<void> {
  await fetch(`/api/threads/${id}/dismiss-reply`, { method: "POST" });
}

export async function retryThread(id: number): Promise<void> {
  await fetch(`/api/threads/${id}/retry`, { method: "POST" });
}

export async function rerunThread(id: number): Promise<void> {
  await fetch(`/api/threads/${id}/rerun`, { method: "POST" });
}

export async function refineInstruction(
  id: number,
  draft: string,
  note?: string
): Promise<string> {
  const r = await fetch(`/api/threads/${id}/refine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft, note }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "refine failed");
  return (await r.json()).refined as string;
}

export async function triggerPoll(): Promise<void> {
  await fetch("/api/poll", { method: "POST" });
}

export async function fetchPrOverview(prKey: string): Promise<PrOverview> {
  const r = await fetch(`/api/prs/${encodeURIComponent(prKey)}/overview`);
  if (!r.ok) throw new Error("not found");
  return r.json();
}

export async function generatePrOverview(prKey: string): Promise<void> {
  const r = await fetch(`/api/prs/${encodeURIComponent(prKey)}/overview`, {
    method: "POST",
  });
  if (!r.ok && r.status !== 409) {
    throw new Error((await r.json().catch(() => ({})))?.error ?? "generate failed");
  }
}

export async function savePrDiagram(
  prKey: string,
  section: DiagramSection,
  doc: ExcalidrawDoc
): Promise<void> {
  const r = await fetch(`/api/prs/${encodeURIComponent(prKey)}/diagrams`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ section, doc }),
  });
  if (!r.ok) {
    throw new Error((await r.json().catch(() => ({})))?.error ?? "save failed");
  }
}

export async function generatePrQuiz(prKey: string): Promise<void> {
  const r = await fetch(`/api/prs/${encodeURIComponent(prKey)}/quiz`, {
    method: "POST",
  });
  if (!r.ok && r.status !== 409) {
    throw new Error((await r.json().catch(() => ({})))?.error ?? "quiz failed");
  }
}

export async function askPrQuestion(prKey: string, question: string): Promise<void> {
  const r = await fetch(`/api/prs/${encodeURIComponent(prKey)}/question`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!r.ok && r.status !== 409) {
    throw new Error((await r.json().catch(() => ({})))?.error ?? "question failed");
  }
}

export async function fetchConfig(): Promise<{
  dryRun: boolean;
  githubLogin: string;
  pollIntervalMs: number;
  lastPolledAt: string | null;
}> {
  const r = await fetch("/api/config");
  return r.json();
}
