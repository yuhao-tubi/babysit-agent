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
  listReviewerPrs,
  listExpiredPrs,
  lastPollTime,
  getPrOverview,
  updatePrOverview,
} from "./db.js";
import { requestOverview, requestQuestion } from "./overview.js";
import { requestQuiz } from "./quiz.js";
import { isIgnoredRepo } from "./classify.js";
import type { DiagramSection, DiagramSet, ExcalidrawDoc } from "./types.js";
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
import { onEvent, emit } from "./events.js";
import { loadConfig } from "./config.js";
import type { ThreadStatus } from "./types.js";

function threadView(id: number) {
  const s = getThread(id);
  if (!s) return null;
  return {
    ...s,
    verdict: s.verdictJson ? JSON.parse(s.verdictJson) : null,
    proposal: s.proposalJson ? JSON.parse(s.proposalJson) : null,
    newCommits: s.newCommitsJson ? JSON.parse(s.newCommitsJson) : null,
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
    // Expired PRs (merged/closed) are RETAINED and surfaced in their own section;
    // the dashboard splits the list on the `expiredAt` field.
    const expired = listExpiredPrs();
    const toGroup = (p: (typeof authored)[number]) => {
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
        expiredAt: p.expiredAt,
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
    };
    const out = [...authored, ...reviewer].map(toGroup);
    // blocked PRs first, then awaiting approval, then ongoing, then resolved.
    // Reviewer PRs (no threads → "resolved" rollup) naturally sort last.
    const rank = (s: ThreadStatus) =>
      s === "blocked" ? 0 : s === "awaiting_approval" ? 1 : s === "pending" ? 2 : 3;
    out.sort((a, b) => rank(a.status) - rank(b.status));
    // Expired PRs keep their own most-recently-expired-first order, appended last.
    return [...out, ...expired.map(toGroup)];
  });

  // ---- PR-level overview + diagram (a Session artifact). Keyed by prKey,
  // URL-encoded in the path (prKey = owner/repo#number is not path-safe). ----

  // Fetch the overview markdown + status + staleness for a PR.
  app.get<{ Params: { key: string } }>("/api/prs/:key/overview", async (req, reply) => {
    const prKey = decodeURIComponent(req.params.key);
    const pr = getPrOverview(prKey);
    if (!pr) return reply.code(404).send({ error: "not found" });
    // Stale when the artifact was built against a head that has since moved —
    // but once the owner has hand-edited a canvas, they own it, so suppress the
    // staleness nag (a Regenerate would discard their edits anyway).
    const stale =
      !pr.diagramsEditedAt &&
      !!pr.overviewHeadSha &&
      !!pr.headSha &&
      pr.overviewHeadSha !== pr.headSha;
    // The quiz is AUTO-INVALIDATED when the head moves (decision): if the quiz
    // was built against a different head than the live one, serve it as absent so
    // the owner can't take an outdated quiz — they must Regenerate.
    const quizStale =
      !!pr.quizHeadSha && !!pr.headSha && pr.quizHeadSha !== pr.headSha;
    const quizReady = pr.quizStatus === "ready" && !quizStale;
    return {
      prKey: pr.prKey,
      title: pr.title,
      url: pr.url,
      role: pr.role,
      status: pr.overviewStatus,
      overviewMd: pr.overviewMd,
      diagrams: pr.diagrams,
      overviewHeadSha: pr.overviewHeadSha,
      currentHeadSha: pr.headSha,
      generatedAt: pr.overviewGeneratedAt,
      diagramsEditedAt: pr.diagramsEditedAt,
      stale,
      // Verified Risk Analysis (reviewer PRs) — merged items + independent status.
      risks: pr.risks,
      risksStatus: pr.risksStatus,
      // PR-comprehension quiz. Questions are withheld while generating and when
      // stale (head moved) so the UI prompts a Regenerate rather than serving an
      // outdated quiz. `quizStatus` still reflects the raw row state.
      quiz: quizReady ? pr.quiz : [],
      quizStatus: pr.quizStatus,
      quizStale,
    };
  });

  // Trigger quiz (re)generation for a PR. Fire-and-forget; progress arrives via
  // the `pr_quiz_updated` SSE event. Requires an existing overview.
  app.post<{ Params: { key: string } }>("/api/prs/:key/quiz", async (req, reply) => {
    const prKey = decodeURIComponent(req.params.key);
    const r = requestQuiz(prKey);
    if (!r.ok) return reply.code(409).send({ error: r.reason });
    return { ok: true };
  });

  // Trigger (re)generation. Fire-and-forget; progress arrives via SSE.
  app.post<{ Params: { key: string } }>("/api/prs/:key/overview", async (req, reply) => {
    const prKey = decodeURIComponent(req.params.key);
    const r = requestOverview(prKey);
    if (!r.ok) return reply.code(409).send({ error: r.reason });
    return { ok: true };
  });

  // Ask a grounded question about the PR; the answer is appended to the
  // overview markdown. Fire-and-forget; the appended Q&A arrives via SSE.
  app.post<{ Params: { key: string }; Body: { question: string } }>(
    "/api/prs/:key/question",
    async (req, reply) => {
      const prKey = decodeURIComponent(req.params.key);
      const question = req.body?.question;
      if (!question?.trim()) return reply.code(400).send({ error: "question required" });
      const r = requestQuestion(prKey, question);
      if (!r.ok) return reply.code(409).send({ error: r.reason });
      return { ok: true };
    }
  );

  // Save a hand-edited diagram canvas (the dashboard's Save button). This is the
  // FIRST mutating overview route — the owner edits an Excalidraw canvas and
  // persists it. Local-disk only (SQLite), so it is exempt from `dryRun` (which
  // gates GitHub writes, not our own state). Overwrites the section's canvas
  // (single source of truth, Q7) and stamps `diagramsEditedAt` so Regenerate
  // knows to warn and the staleness nag is suppressed.
  app.put<{ Params: { key: string }; Body: { section?: string; doc?: unknown } }>(
    "/api/prs/:key/diagrams",
    async (req, reply) => {
      const prKey = decodeURIComponent(req.params.key);
      const pr = getPrOverview(prKey);
      if (!pr) return reply.code(404).send({ error: "not found" });
      if (isIgnoredRepo(pr.owner, pr.repo)) {
        return reply.code(409).send({ error: "repo not in scope" });
      }
      const section = req.body?.section as DiagramSection | undefined;
      if (section !== "why" && section !== "what" && section !== "how") {
        return reply.code(400).send({ error: "section must be why|what|how" });
      }
      const doc = req.body?.doc as ExcalidrawDoc | undefined;
      // Minimal structural validation — same wrapper check the renderer enforces.
      if (
        !doc ||
        typeof doc !== "object" ||
        (doc as any).type !== "excalidraw" ||
        !Array.isArray((doc as any).elements)
      ) {
        return reply.code(400).send({ error: "doc must be a valid excalidraw document" });
      }
      const next: DiagramSet = { ...pr.diagrams, [section]: doc };
      updatePrOverview(prKey, { diagrams: next, diagramsEditedAt: new Date().toISOString() });
      emit({ type: "pr_overview_updated", prKey });
      return { ok: true };
    }
  );

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
    // A frozen proposal is enough — the Thread may already be `resolved` because the
    // OTHER part (the reply) was approved first, yet the change is still pushable.
    if (!s.proposalJson) {
      return reply.code(409).send({ error: "no proposal to approve" });
    }
    void approveThread(Number(req.params.id));
    return { ok: true };
  });

  // Approve a parked proposal's drafted REPLY (the reply half of a two-part
  // proposal). Posts it to GitHub. Either part approved on its own resolves the
  // Thread; the other stays approvable while a frozen proposal remains.
  app.post<{ Params: { id: string } }>("/api/threads/:id/approve-reply", async (req, reply) => {
    const s = getThread(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: "not found" });
    if (!s.proposalJson) {
      return reply.code(409).send({ error: "no proposal to approve" });
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

  // Bind loopback by default (safe for a native local daemon). In a container
  // the published port can only reach a 0.0.0.0 bind, so BABYSIT_HOST=0.0.0.0
  // is set in the image (see Dockerfile).
  const host = process.env.BABYSIT_HOST || "127.0.0.1";
  await app.listen({ port, host });
}
