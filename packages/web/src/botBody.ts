/**
 * Bot review bodies are prose wrapped in machine chrome: HTML comments carrying
 * the bot's own bookkeeping (`<!-- BUGBOT_BUG_ID ... -->`, `<!-- LOCATIONS
 * START ... -->`), `<details>` blocks of extra locations, and a footer of
 * `<div><a href="..."><picture><img ...>` deep-link buttons. The dashboard
 * renders markdown with no raw-HTML plugin, so all of that shows up as literal
 * tag soup - screens of base64 link blobs around two useful sentences.
 *
 * `cleanBotBody` drops the chrome and keeps the prose. It is **display only** -
 * the verdict agent always reads the untouched body, so nothing the bot said can
 * be lost by a bad guess here.
 *
 * Code is left completely alone: a bot suggesting a fix in a `.tsx` file has real
 * `<div>` tags in its diff, and those are content, not chrome. Fenced blocks are
 * split out before any cleaning; inline code spans are split out before tags are
 * unwrapped.
 */

/** Elements that are pure chrome - dropped with their contents. */
const DROP_WHOLE = /<(details|picture|svg|sup|script|style|iframe)\b[\s\S]*?<\/\1>/gi;

/** Block-level tags: unwrapped to a line break so text doesn't run together. */
const UNWRAP_BLOCK =
  /<\/?(div|p|blockquote|ul|ol|li|h[1-6]|table|thead|tbody|tfoot|tr|td|th|hr|center|pre)\b[^>]*>/gi;

/** Inline tags: unwrapped in place. */
const UNWRAP_INLINE = /<\/?(span|b|strong|i|em|u|s|small|font|kbd|code|a)\b[^>]*>/gi;

/** An inline code span, as a capturing split so the spans survive `.split()`. */
const INLINE_CODE = /(`[^`\n]+`)/g;

/** Cleans one stretch of markdown that is not inside a fenced code block. */
function cleanProse(text: string): string {
  let out = text;
  // Bookkeeping comments first - the DESCRIPTION/LOCATIONS markers live in them.
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(DROP_WHOLE, "");
  out = out.replace(/<img\b[^>]*>/gi, "");
  out = out.replace(/<br\s*\/?>/gi, "\n");
  // A link whose body was an image is now empty; one with text becomes markdown.
  out = out.replace(
    /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, label: string) => {
      const inner = label.replace(/<[^>]*>/g, "").trim();
      return inner ? `[${inner}](${href})` : "";
    },
  );
  // Unwrap the leftover tags outside inline code spans only.
  return out
    .split(INLINE_CODE)
    .map((seg) =>
      seg.startsWith("`")
        ? seg
        : seg
            .replace(UNWRAP_BLOCK, "\n")
            .replace(UNWRAP_INLINE, "")
            // Spacer entities between the stripped buttons would be left behind
            // as a line of their own.
            .replace(/&nbsp;/gi, " "),
    )
    .join("");
}

/** Splits a body on fenced code blocks so `cleanProse` never touches code. */
function splitFences(body: string): { code: boolean; text: string }[] {
  const parts: { code: boolean; text: string }[] = [];
  let buf: string[] = [];
  let inFence = false;
  let fence = "";
  const flush = (code: boolean) => {
    if (buf.length) parts.push({ code, text: buf.join("\n") });
    buf = [];
  };
  for (const line of body.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!inFence && marker) {
      flush(false);
      inFence = true;
      fence = marker[1][0];
      buf.push(line);
      continue;
    }
    if (inFence && marker && marker[1][0] === fence) {
      buf.push(line);
      flush(true);
      inFence = false;
      continue;
    }
    buf.push(line);
  }
  flush(inFence);
  return parts;
}

/**
 * Strips bot chrome from a comment body for display. Returns the original body
 * if cleaning would leave nothing to read.
 */
export function cleanBotBody(body: string): string {
  const cleaned = splitFences(body)
    .map((part) => (part.code ? part.text : cleanProse(part.text)))
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || body;
}

/** True for a comment author we treat as a bot (matches the server heuristic). */
export function isBotAuthor(author: string, authorType: string): boolean {
  return authorType === "Bot" || author.toLowerCase().endsWith("[bot]");
}
