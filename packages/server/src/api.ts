import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getThread,
  getThreadItems,
  getEvents,
  listThreads,
  listPrsWithThreads,
} from "./db.js";
import { applyInstruction, processThread } from "./processor.js";
import { pollOnce } from "./poller.js";
import { onEvent } from "./events.js";
import { loadConfig } from "./config.js";
import type { ThreadStatus } from "./types.js";

function threadView(id: number) {
  const s = getThread(id);
  if (!s) return null;
  return {
    ...s,
    verdict: s.verdictJson ? JSON.parse(s.verdictJson) : null,
    items: getThreadItems(id),
    events: getEvents(id),
  };
}

/** Rollup status for a PR from its threads' statuses (blocked floats up). */
function rollupStatus(statuses: ThreadStatus[]): ThreadStatus {
  if (statuses.some((s) => s === "blocked" || s === "error")) return "blocked";
  if (statuses.some((s) => s === "pending" || s === "in_progress")) return "pending";
  return "resolved";
}

export async function startServer(port: number): Promise<void> {
  const app = Fastify({ logger: false });

  app.get("/api/config", async () => {
    const c = loadConfig();
    return { dryRun: c.dryRun, githubLogin: c.githubLogin, pollIntervalMs: c.pollIntervalMs };
  });

  // PRs (the "Session" view) each with their threads; blocked PRs float to top.
  app.get("/api/prs", async () => {
    const threads = listThreads();
    const prs = listPrsWithThreads();
    const out = prs.map((p) => {
      const ts = threads.filter((t) => t.prKey === p.prKey);
      const status = rollupStatus(ts.map((t) => t.status));
      const counts = {
        blocked: ts.filter((t) => t.status === "blocked" || t.status === "error").length,
        ongoing: ts.filter((t) => t.status === "pending" || t.status === "in_progress").length,
        resolved: ts.filter((t) => t.status === "resolved").length,
      };
      return {
        prKey: p.prKey,
        title: p.title,
        url: p.url,
        status,
        counts,
        threads: ts.map((t) => ({
          id: t.id,
          status: t.status,
          authorClass: t.authorClass,
          threadKey: t.threadKey,
          action: t.verdictJson ? JSON.parse(t.verdictJson).action : null,
          summary: t.verdictJson ? JSON.parse(t.verdictJson).summary : null,
          updatedAt: t.updatedAt,
        })),
      };
    });
    // blocked PRs first, then ongoing, then resolved.
    const rank = (s: ThreadStatus) => (s === "blocked" ? 0 : s === "pending" ? 1 : 2);
    out.sort((a, b) => rank(a.status) - rank(b.status));
    return out;
  });

  app.get<{ Params: { id: string } }>("/api/threads/:id", async (req, reply) => {
    const view = threadView(Number(req.params.id));
    if (!view) return reply.code(404).send({ error: "not found" });
    return view;
  });

  app.post<{ Params: { id: string }; Body: { instruction: string } }>(
    "/api/threads/:id/instruct",
    async (req, reply) => {
      const id = Number(req.params.id);
      const instruction = req.body?.instruction;
      if (!instruction) return reply.code(400).send({ error: "instruction required" });
      void applyInstruction(id, instruction);
      return { ok: true };
    }
  );

  app.post<{ Params: { id: string } }>("/api/threads/:id/retry", async (req) => {
    void processThread(Number(req.params.id));
    return { ok: true };
  });

  app.post("/api/poll", async () => {
    const r = await pollOnce();
    return r;
  });

  // SSE stream of app events for live dashboard updates.
  app.get("/events", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");
    const off = onEvent((ev) => {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    });
    const ka = setInterval(() => reply.raw.write(": ka\n\n"), 25000);
    req.raw.on("close", () => {
      clearInterval(ka);
      off();
    });
  });

  // Serve built dashboard if present (production).
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = join(here, "..", "..", "web", "dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/events")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  await app.listen({ port, host: "127.0.0.1" });
}
