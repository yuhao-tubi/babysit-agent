import { useEffect } from "react";

/** App events pushed over SSE (mirror of the server's AppEvent union). */
export type AppEvent =
  | { type: "poll" }
  | { type: "thread_created"; threadId: number }
  | { type: "thread_updated"; threadId: number }
  | { type: "pr_overview_updated"; prKey: string }
  | { type: "pr_quiz_updated"; prKey: string }
  | { type: "pr_risks_updated"; prKey: string }
  | { type: "notification"; prKey: string; threadId: number; message: string };

/** Subscribe to the server SSE stream; calls onEvent for each app event. */
export function useEventStream(onEvent: (ev: AppEvent | null) => void): void {
  useEffect(() => {
    const es = new EventSource("/events");
    es.onmessage = (m) => {
      let ev: AppEvent | null = null;
      try {
        ev = JSON.parse(m.data);
      } catch {
        /* keepalive / comment line */
      }
      onEvent(ev);
    };
    es.onerror = () => {
      /* EventSource auto-reconnects */
    };
    return () => es.close();
  }, [onEvent]);
}
