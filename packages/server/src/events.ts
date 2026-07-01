import { EventEmitter } from "node:events";

export type AppEvent =
  | { type: "poll"; prsChecked: number; newThreads: number[] }
  | { type: "thread_created"; threadId: number }
  | { type: "thread_updated"; threadId: number }
  // PR-level (Session) overview artifact progressed. Keyed by prKey — the first
  // event not keyed by a numeric threadId.
  | { type: "pr_overview_updated"; prKey: string }
  | { type: "notification"; prKey: string; threadId: number; message: string };

const bus = new EventEmitter();
bus.setMaxListeners(50);

export function emit(ev: AppEvent): void {
  bus.emit("event", ev);
}

export function onEvent(listener: (ev: AppEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
