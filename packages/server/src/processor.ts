import { loadConfig } from "./config.js";
import {
  getThread,
  getThreadItems,
  listThreads,
  logEvent,
  threadAttemptCount,
  updateThread,
} from "./db.js";
import { getResolvedThreadKeys } from "./gh.js";
import { runVerdict } from "./verdict.js";
import { execute } from "./executor.js";
import { notifyEscalation } from "./notify.js";
import { onEvent, emit } from "./events.js";
import { SerialQueue } from "./queue.js";
import type { ThreadRow } from "./types.js";

const queue = new SerialQueue();

/** Process one pending thread: re-check resolution → verdict → loop-guard → execute. */
export async function processThread(id: number): Promise<void> {
  const s = getThread(id);
  if (!s || s.status !== "pending") return;
  const cfg = loadConfig();

  await queue.run(`${s.owner}/${s.repo}`, async () => {
    const fresh = getThread(id);
    if (!fresh || fresh.status !== "pending") return;

    // Q5: never act on a thread that turned resolved since it was queued.
    try {
      const resolved = await getResolvedThreadKeys(fresh.owner, fresh.repo, fresh.number);
      if (resolved.has(fresh.threadKey)) {
        logEvent(id, "skipped_resolved", `${fresh.threadKey} resolved before action`);
        finalize(id, "resolved");
        return;
      }
    } catch {
      // If the resolution check fails, proceed — the verdict step is read-only.
    }

    updateThread(id, { status: "in_progress" });
    emit({ type: "thread_updated", threadId: id });
    try {
      const items = getThreadItems(id);
      const verdict = await runVerdict(fresh, items);
      updateThread(id, { verdict, replyDraft: verdict.reply_draft });
      logEvent(id, "verdict", `${verdict.action} (risk=${verdict.risk}) ${verdict.summary}`);

      // Loop-guard: if this thread already had >= maxThreadAttempts auto-fixes,
      // escalate instead of fixing again.
      if (
        verdict.action === "auto_fix" &&
        threadAttemptCount(fresh.prKey, fresh.threadKey) >= cfg.maxThreadAttempts
      ) {
        logEvent(id, "loop_guard", `>= ${cfg.maxThreadAttempts} attempts on thread; escalating`);
        notifyEscalation(id, fresh.prKey, "bot still objecting after repeated fixes");
        finalize(id, "blocked");
        return;
      }

      const status = await execute(fresh, verdict);
      finalize(id, status);
    } catch (err: any) {
      logEvent(id, "error", err?.message ?? String(err));
      updateThread(id, { status: "error", error: err?.message ?? String(err) });
      emit({ type: "thread_updated", threadId: id });
    }
  });
}

/** Apply a user instruction to a blocked thread and re-run the executor. */
export async function applyInstruction(id: number, instruction: string): Promise<void> {
  const s = getThread(id);
  if (!s) throw new Error(`no thread #${id}`);
  await queue.run(`${s.owner}/${s.repo}`, async () => {
    const fresh = getThread(id);
    if (!fresh) return;
    updateThread(id, { status: "in_progress", error: null });
    emit({ type: "thread_updated", threadId: id });
    try {
      const verdict = fresh.verdictJson
        ? JSON.parse(fresh.verdictJson)
        : { action: "auto_fix", summary: "", reply_draft: "", risk: "medium" };
      logEvent(id, "instruction", instruction.slice(0, 300));
      const status = await execute(fresh, verdict, { instruction });
      finalize(id, status);
    } catch (err: any) {
      logEvent(id, "error", err?.message ?? String(err));
      updateThread(id, { status: "error", error: err?.message ?? String(err) });
      emit({ type: "thread_updated", threadId: id });
    }
  });
}

function finalize(id: number, status: ThreadRow["status"]): void {
  updateThread(id, { status });
  logEvent(id, "finalized", status);
  emit({ type: "thread_updated", threadId: id });
}

/** Subscribe to new threads and drain any pending ones on startup. */
export function startProcessor(): void {
  // Resume anything left pending across a restart.
  for (const s of listThreads("pending")) void processThread(s.id);

  onEvent((ev) => {
    // thread_created → new unit; thread_updated → possibly a reopened (pending)
    // unit. processThread no-ops unless the thread is actually pending, so
    // reacting to both is safe and never double-processes in-progress work.
    if (ev.type === "thread_created" || ev.type === "thread_updated") {
      void processThread(ev.threadId);
    }
  });
}
