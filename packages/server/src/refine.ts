/**
 * Direct Claude API (one-shot text refinement) — NOT an agent run.
 *
 * Used by the dashboard's "AI refine" helper on the instruction box: the owner
 * types a rough reply/instruction plus an optional note ("make it firmer",
 * "shorter"), and we return a single rewritten string. No tools, no checkout, no
 * multi-turn loop — just one Bedrock `InvokeModel` call against the same
 * TVM-vended bearer token and inference-profile ARN the Agent SDK uses.
 *
 * Kept separate from executor.ts (which orchestrates agent runs) on purpose:
 * this never touches GitHub or a worktree and never parks a Proposal — the
 * refined text is handed back to the box for the owner to edit and submit.
 *
 * The Bedrock call itself lives in `bedrock-auth.ts` (`invokeModel`) — the one
 * shared direct-model path, so this file is just prompt + shaping.
 */
import { invokeModel } from "./bedrock-auth.js";

const REFINE_SYSTEM =
  "You refine a PR author's draft text (a code-review reply or an instruction to an automated fixing agent). Apply the author's note and return ONLY the rewritten text — no preamble, no quotes, no commentary. Keep it concise and professional, preserve the author's intent and any technical specifics, and use Markdown where the original would. If the draft is empty, write a sensible draft from the note alone.";

export interface RefineInput {
  /** The current text in the box (may be empty). */
  draft: string;
  /** What the owner wants changed (e.g. "firmer", "shorter", "explain why"). Optional. */
  note?: string;
  /** Optional surrounding context (the feedback being replied to) for grounding. */
  context?: string;
}

/** One-shot rewrite. Returns the refined text; throws on an API/auth failure. */
export async function refineText(input: RefineInput): Promise<string> {
  const draft = input.draft?.trim() ?? "";
  const note = input.note?.trim();
  if (!draft && !note) return draft;

  const parts: string[] = [];
  if (input.context?.trim()) {
    parts.push(`Context (the review feedback being addressed):\n${input.context.trim()}`);
    parts.push("");
  }
  parts.push(`Draft to refine:\n${draft || "(empty)"}`);
  if (note) {
    parts.push("");
    parts.push(`How to refine it: ${note}`);
  }
  parts.push("");
  parts.push("Return only the rewritten text.");

  const out = (
    await invokeModel({
      system: REFINE_SYSTEM,
      prompt: parts.join("\n"),
      maxTokens: 1024,
      temperature: 0.3,
      label: "refine",
    })
  ).trim();
  return out || draft;
}
