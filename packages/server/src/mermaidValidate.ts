import { JSDOM } from "jsdom";

/**
 * Mermaid's npm build assumes a browser: several diagram types (state, class, ER…)
 * sanitize labels through DOMPurify at PARSE time, not just render time, so even a
 * syntax-only check throws "DOMPurify.addHook is not a function" without a real
 * `document`. `jsdom` gives it just enough of one. Set up once and reused for every
 * validation call in the process.
 */
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

async function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = (async () => {
      const dom = new JSDOM("<!doctype html><html><body></body></html>");
      (globalThis as any).window ??= dom.window;
      (globalThis as any).document ??= dom.window.document;
      (globalThis as any).navigator ??= dom.window.navigator;
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({ startOnLoad: false });
      return mermaid;
    })();
  }
  return mermaidPromise;
}

/**
 * Whether mermaid can parse `source` at all. Used to keep agent-authored diagrams
 * (which are never seen rendered before landing in the dashboard — see risks.ts /
 * explain.ts) from ever reaching the browser as broken mermaid: callers drop or
 * demote anything that fails this check, so the owner never sees a parse-error
 * diagram, just no diagram.
 */
export async function isValidMermaid(source: string): Promise<boolean> {
  if (!source.trim()) return false;
  try {
    const mermaid = await loadMermaid();
    await mermaid.parse(source, { suppressErrors: false });
    return true;
  } catch {
    return false;
  }
}
