/**
 * Pre-triage — a text-only "is anything actually being asked here?" check.
 *
 * A lot of Threads carry no work at all: a bot's review-summary header with no
 * findings, boilerplate, "LGTM", or a comment that just quotes the agent's own
 * earlier reply. Running the full grounded Verdict on those costs a worktree and
 * holds the per-repo SerialQueue for minutes, only to park a "nothing to address"
 * reply Proposal the owner then has to click away.
 *
 * So before `runVerdict` provisions a checkout, one direct Bedrock `InvokeModel`
 * call (NOT an agent run — `bedrock-auth.ts`'s shared `invokeModel`, like
 * refine.ts: no tools, no checkout, no multi-turn loop) reads ONLY the comment
 * text and answers a single question:
 * does this text request anything? If it doesn't, the Verdict is `dismiss` and
 * the Thread resolves locally without any GitHub write.
 *
 * Deliberately blind to the PR's code and description: "does this ask for
 * something" is answerable from the text alone, and withholding the rest keeps
 * the model from judging code it hasn't read — that grounded work belongs to the
 * real Verdict, which this only ever DEFERS to. Every uncertainty, malformed
 * answer, or API failure falls through to the full Verdict; nothing is ever
 * dismissed on error.
 */
import { invokeModel } from "./bedrock-auth.js";
import type { AuthorClass, FeedbackItem } from "./types.js";

/** Outcome of the pre-triage check. `dismiss` is only ever a confident "no ask". */
export interface TriageResult {
  dismiss: boolean;
  /** One line: why it was dismissed, or why it wasn't. Shown as the Verdict summary. */
  reason: string;
}

const TRIAGE_SYSTEM = `You are a fast pre-filter for a code-review triage agent. You see ONLY the text of one comment thread on a pull request — never the code, never the PR description. Answer ONE question: does this text request anything from the PR author?

Reply with ONLY a JSON object, no prose, no code fence:
{"dismiss": true|false, "reason": "<one short sentence>"}

Set dismiss:true ONLY when the thread contains NOTHING actionable, i.e. it is:
- a bot's review-summary header, scaffold, or status/boilerplate text with no findings,
- empty, or only headings/links/badges/metadata,
- pure approval or praise ("LGTM", "nice", "thanks", ship-it),
- an echo/quote of the automated agent's own earlier reply with nothing new added.

Set dismiss:false for EVERYTHING else. In particular, dismiss:false whenever the text makes any concrete claim about the code, reports a bug, asks a question, suggests or requests a change, or raises a concern — even a small nit, even one you suspect is a false positive, and even if it looks already handled. You have not read the code, so you cannot know; deciding those is the grounded agent's job.

When in doubt, dismiss:false. A wrong dismiss:false only costs an extra review; a wrong dismiss:true silently drops real reviewer feedback.`;

/**
 * Read a pre-triage reply. FAIL-OPEN by construction: `dismiss` is true only for
 * a well-formed object whose `dismiss` is the boolean `true`. Anything else —
 * unparseable text, a missing/odd field, a truthy string — returns dismiss:false
 * so the caller runs the full Verdict.
 */
export function parseTriage(text: string): TriageResult {
  const raw = (text ?? "").trim();
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    // Tolerate a wrapping fence or stray prose: take the outermost {...} region.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return { dismiss: false, reason: "pre-triage reply not parseable" };
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return { dismiss: false, reason: "pre-triage reply not parseable" };
    }
  }
  if (!obj || typeof obj !== "object") return { dismiss: false, reason: "pre-triage reply not an object" };
  const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "";
  // Strict `=== true`: a string "true", 1, or a missing field must NOT dismiss.
  if (obj.dismiss !== true) return { dismiss: false, reason: reason || "actionable feedback" };
  return { dismiss: true, reason: reason || "nothing actionable in this thread" };
}

/** Per-item body cap — a long quote block adds no signal to "is anything asked?". */
const BODY_CAP = 4000;

/** The text-only prompt: author class plus the raw comment bodies. Nothing else. */
export function buildTriagePrompt(items: FeedbackItem[], authorClass: AuthorClass): string {
  const lines: string[] = [];
  lines.push(`Comment author_class: ${authorClass}`);
  lines.push("");
  lines.push("Comment thread text:");
  for (const it of items) {
    lines.push("---");
    lines.push(`author: ${it.author} (${it.authorType})  kind: ${it.kind}`);
    const body = (it.body ?? "").trim();
    lines.push(`body:\n${body.length > BODY_CAP ? `${body.slice(0, BODY_CAP)}\n…[truncated]` : body || "(empty)"}`);
  }
  lines.push("---");
  lines.push("");
  lines.push("Does this text request anything? Reply with only the JSON object.");
  return lines.join("\n");
}

/**
 * Run the pre-triage check. Never throws and never dismisses on failure — a
 * network/auth/parse problem returns dismiss:false so the caller falls through to
 * the full grounded Verdict.
 */
export async function preTriage(items: FeedbackItem[], authorClass: AuthorClass): Promise<TriageResult> {
  if (!items.length) return { dismiss: false, reason: "no items to pre-triage" };
  try {
    const out = await invokeModel({
      system: TRIAGE_SYSTEM,
      prompt: buildTriagePrompt(items, authorClass),
      maxTokens: 300,
      temperature: 0,
      // Short cap: this runs INSIDE the per-repo SerialQueue, and the whole point
      // is to be quick. A slow answer is worth less than falling through.
      timeoutMs: 20_000,
      label: "pre-triage",
    });
    return parseTriage(out);
  } catch (err) {
    return { dismiss: false, reason: `pre-triage unavailable: ${(err as Error).message}` };
  }
}
