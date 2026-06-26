import { useEffect } from "react";

/** Subscribe to the server SSE stream; calls onEvent for each app event. */
export function useEventStream(onEvent: () => void): void {
  useEffect(() => {
    const es = new EventSource("/events");
    es.onmessage = () => onEvent();
    es.onerror = () => {
      /* EventSource auto-reconnects */
    };
    return () => es.close();
  }, [onEvent]);
}
