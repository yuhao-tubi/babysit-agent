/**
 * Direct Claude API (one-shot text refinement) — NOT an agent run.
 *
 * Used by the dashboard's "AI refine" helper on the instruction box: the owner
 * types a rough reply/instruction plus an optional note ("make it firmer",
 * "shorter"), and we return a single rewritten string. No tools, no checkout, no
 * multi-turn loop — just one Bedrock `InvokeModel` call against the same
 * KeySmith-vended bearer token and inference-profile ARN the Agent SDK uses.
 *
 * Kept separate from executor.ts (which orchestrates agent runs) on purpose:
 * this never touches GitHub or a worktree and never parks a Proposal — the
 * refined text is handed back to the box for the owner to edit and submit.
 */
import { getBedrockSession } from "./keysmith.js";

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

  const { token, region, modelArn } = await getBedrockSession();
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(
    modelArn
  )}/invoke`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 1024,
        temperature: 0.3,
        system: REFINE_SYSTEM,
        messages: [{ role: "user", content: parts.join("\n") }],
      }),
    });
  } catch (err) {
    throw new Error(`refine: Bedrock request failed (network): ${(err as Error).message}`);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`refine: Bedrock rejected ${res.status} ${res.statusText}: ${text}`);
  }

  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
  };
  const out = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  return out || draft;
}
