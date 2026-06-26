import type { PrGroup, ThreadDetail } from "./types";

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

export async function triggerPoll(): Promise<void> {
  await fetch("/api/poll", { method: "POST" });
}

export async function fetchConfig(): Promise<{ dryRun: boolean; githubLogin: string }> {
  const r = await fetch("/api/config");
  return r.json();
}
