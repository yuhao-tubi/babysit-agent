import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getThread,
  getThreadItems,
  getEvents,
  listThreads,
  listPrsWithThreads,
  listReviewerPrs,
  lastPollTime,
  getPrOverview,
} from "./db.js";
import { requestOverview } from "./overview.js";
import {
  applyInstruction,
  approveThread,
  approveReply,
  dismissReply,
  retryThread,
  rerunThread,
  replyDirect,
  resolveThread,
} from "./processor.js";
import { pollOnce } from "./poller.js";
import { refineText } from "./refine.js";
import { onEvent } from "./events.js";
import { loadConfig } from "./config.js";
import type { ThreadStatus } from "./types.js";

function threadView(id: number) {
  const s = getThread(id);
  if (!s) return null;
  return {
    ...s,
    verdict: s.verdictJson ? JSON.parse(s.verdictJson) : null,
    proposal: s.proposalJson ? JSON.parse(s.proposalJson) : null,
    items: getThreadItems(id),
    events: getEvents(id),
  };
}

/** Rollup status for a PR from its threads' statuses (needs-you floats up). */
function rollupStatus(statuses: ThreadStatus[]): ThreadStatus {
  if (statuses.some((s) => s === "blocked" || s === "error")) return "blocked";
  if (statuses.some((s) => s === "awaiting_approval")) return "awaiting_approval";
  if (statuses.some((s) => s === "pending" || s === "in_progress")) return "pending";
  return "resolved";
}

export async function startServer(port: number): Promise<void> {
  const app = Fastify({ logger: false });

  app.get("/api/config", async () => {
    const c = loadConfig();
    return {
      dryRun: c.dryRun,
      githubLogin: c.githubLogin,
      pollIntervalMs: c.pollIntervalMs,
      lastPolledAt: lastPollTime(),
    };
  });

  // PRs (the "Session" view) each with their threads; blocked PRs float to top.
  app.get("/api/prs", async () => {
    const threads = listThreads();
    // Authored PRs (with threads) + review-requested PRs (overview-only, no
    // threads). Reviewer rows render for the overview panel only.
    const authored = listPrsWithThreads();
    const reviewer = listReviewerPrs();
    const prs = [...authored, ...reviewer];
    const out = prs.map((p) => {
      const ts = threads.filter((t) => t.prKey === p.prKey);
      const status = rollupStatus(ts.map((t) => t.status));
      const counts = {
        blocked: ts.filter((t) => t.status === "blocked" || t.status === "error").length,
        awaiting: ts.filter((t) => t.status === "awaiting_approval").length,
        ongoing: ts.filter((t) => t.status === "pending" || t.status === "in_progress").length,
        resolved: ts.filter((t) => t.status === "resolved").length,
      };
      return {
        prKey: p.prKey,
        title: p.title,
        url: p.url,
        role: p.role,
        status,
        counts,
        lastPolled: p.lastPolled,
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
    // blocked PRs first, then awaiting approval, then ongoing, then resolved.
    // Reviewer PRs (no threads → "resolved" rollup) naturally sort last.
    const rank = (s: ThreadStatus) =>
      s === "blocked" ? 0 : s === "awaiting_approval" ? 1 : s === "pending" ? 2 : 3;
    out.sort((a, b) => rank(a.status) - rank(b.status));
    return out;
  });

  // ---- PR-level overview + diagram (a Session artifact). Keyed by prKey,
  // URL-encoded in the path (prKey = owner/repo#number is not path-safe). ----

  // Fetch the overview markdown + status + staleness for a PR.
  app.get<{ Params: { key: string } }>("/api/prs/:key/overview", async (req, reply) => {
    const prKey = decodeURIComponent(req.params.key);
    const pr = getPrOverview(prKey);
    if (!pr) return reply.code(404).send({ error: "not found" });
    // Stale when the artifact was built against a head that has since moved.
    const stale =
      !!pr.overviewHeadSha && !!pr.headSha && pr.overviewHeadSha !== pr.headSha;
    return {
      prKey: pr.prKey,
      status: pr.overviewStatus,
      overviewMd: pr.overviewMd,
      hasDiagram: !!pr.diagramPath,
      overviewHeadSha: pr.overviewHeadSha,
      currentHeadSha: pr.headSha,
      generatedAt: pr.overviewGeneratedAt,
      stale,
    };
  });

  // Trigger (re)generation. Fire-and-forget; progress arrives via SSE.
  app.post<{ Params: { key: string } }>("/api/prs/:key/overview", async (req, reply) => {
    const prKey = decodeURIComponent(req.params.key);
    const r = requestOverview(prKey);
    if (!r.ok) return reply.code(409).send({ error: r.reason });
    return { ok: true };
  });

  // Stream the generated SVG diagram from the DB-recorded path (never a static
  // mount over the state dir — the path is resolved only from the row).
  app.get<{ Params: { key: string } }>("/api/prs/:key/diagram", async (req, reply) => {
    const prKey = decodeURIComponent(req.params.key);
    const pr = getPrOverview(prKey);
    if (!pr?.diagramPath || !existsSync(pr.diagramPath)) {
      return reply.code(404).send({ error: "no diagram" });
    }
    reply.header("Content-Type", "image/svg+xml");
    reply.header("Cache-Control", "no-cache");
    return reply.send(createReadStream(pr.diagramPath));
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

  // Post the instruction text directly to the GitHub thread (no agent), then
  // mark the Thread resolved.
  app.post<{ Params: { id: string }; Body: { body: string } }>(
    "/api/threads/:id/reply",
    async (req, reply) => {
      const id = Number(req.params.id);
      const body = req.body?.body;
      if (!body?.trim()) return reply.code(400).send({ error: "body required" });
      void replyDirect(id, body);
      return { ok: true };
    }
  );

  // Manually mark a Thread resolved (and resolve its GitHub thread if inline).
  app.post<{ Params: { id: string } }>("/api/threads/:id/resolve", async (req) => {
    void resolveThread(Number(req.params.id));
    return { ok: true };
  });

  // Approve a parked proposal — the sole push path. Applies the frozen proposal
  // (code: apply-check + re-gate + ff-push; pr_body: gh pr edit).
  app.post<{ Params: { id: string } }>("/api/threads/:id/approve", async (req, reply) => {
    const s = getThread(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: "not found" });
    if (s.status !== "awaiting_approval" || !s.proposalJson) {
      return reply.code(409).send({ error: "no proposal awaiting approval" });
    }
    void approveThread(Number(req.params.id));
    return { ok: true };
  });

  // Approve a parked proposal's drafted REPLY (the reply half of a two-part
  // proposal). Posts it to GitHub; resolves the Thread if the change is also done.
  app.post<{ Params: { id: string } }>("/api/threads/:id/approve-reply", async (req, reply) => {
    const s = getThread(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: "not found" });
    if (s.status !== "awaiting_approval" || !s.proposalJson) {
      return reply.code(409).send({ error: "no proposal awaiting approval" });
    }
    void approveReply(Number(req.params.id));
    return { ok: true };
  });

  // Dismiss a parked proposal's drafted reply without posting it.
  app.post<{ Params: { id: string } }>("/api/threads/:id/dismiss-reply", async (req, reply) => {
    const s = getThread(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: "not found" });
    if (!s.proposalJson) return reply.code(409).send({ error: "no proposal" });
    void dismissReply(Number(req.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/threads/:id/retry", async (req) => {
    void retryThread(Number(req.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/threads/:id/rerun", async (req) => {
    void rerunThread(Number(req.params.id));
    return { ok: true };
  });

  // One-shot Claude text refinement for the instruction box's "AI refine"
  // helper. Direct Bedrock InvokeModel — no agent, no GitHub write. Returns the
  // rewritten text for the owner to review/edit; it is NOT persisted.
  app.post<{
    Params: { id: string };
    Body: { draft: string; note?: string };
  }>("/api/threads/:id/refine", async (req, reply) => {
    const id = Number(req.params.id);
    const s = getThread(id);
    if (!s) return reply.code(404).send({ error: "not found" });
    const draft = req.body?.draft ?? "";
    const note = req.body?.note;
    // Ground the rewrite in the thread's feedback text.
    const context = getThreadItems(id)
      .map((it) => `${it.author}: ${it.body}`)
      .join("\n\n")
      .slice(0, 4000);
    try {
      const refined = await refineText({ draft, note, context });
      return { refined };
    } catch (err: any) {
      return reply.code(502).send({ error: err?.message ?? String(err) });
    }
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
