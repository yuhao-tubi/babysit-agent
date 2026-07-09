/**
 * Renders a unified-diff string as a GitHub-light diff view, grouped by changed
 * file. The noisy git headers (`diff --git`, `index`, `--- a/…`, `+++ b/…`, mode
 * / rename lines) are hidden; each file gets a clean header bar with its path,
 * and its hunks render below as full-width colored rows. Works for git diffs and
 * for the server's synthetic PR-description pseudo-diff (a single group).
 */

type RowKind = "add" | "del" | "hunk" | "divider" | "context";

// GitHub light-theme diff palette.
const STYLES: Record<RowKind, { bg: string; color: string }> = {
  add: { bg: "#e6ffec", color: "#1f2328" },
  del: { bg: "#ffebe9", color: "#1f2328" },
  hunk: { bg: "#ddf4ff", color: "#0550ae" },
  divider: { bg: "#f6f8fa", color: "#57606a" },
  context: { bg: "#ffffff", color: "#1f2328" },
};

type FileBlock = { path: string; lines: string[] };

/** True for the git metadata lines we suppress in favor of the file header. */
function isMetaLine(line: string): boolean {
  return (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ")
  );
}

/** Strip a leading a/ or b/ prefix from a diff path. */
function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, "");
}

/** Split a unified diff into per-file blocks, hiding git metadata lines. */
function parseFiles(diff: string): FileBlock[] {
  let lines = diff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);

  const files: FileBlock[] = [];

  const ensure = (): FileBlock => {
    let cur = files[files.length - 1];
    if (!cur) {
      cur = { path: "", lines: [] };
      files.push(cur);
    }
    return cur;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      // "diff --git a/x b/x" → prefer the b/ path.
      const m = line.match(/ b\/(\S+)$/);
      files.push({ path: m ? m[1] : line.slice("diff --git ".length), lines: [] });
      continue;
    }
    // Capture path from +++ when present; it's more reliable than the
    // `diff --git` line for paths with spaces.
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      // Only real git paths carry an a/ or b/ prefix; the pseudo-diff's
      // "+++ proposed PR description" isn't a path, so leave that header blank.
      if (/^[ab]\//.test(raw)) {
        const p = stripPrefix(raw);
        const cur = ensure();
        if (cur.lines.length === 0 && p !== "/dev/null") cur.path = p;
      }
      continue;
    }
    if (isMetaLine(line)) continue; // hidden git metadata
    ensure().lines.push(line);
  }

  return files.filter((f) => f.lines.length > 0);
}

function classify(line: string): RowKind {
  if (line.startsWith("@@")) return "hunk";
  if (line === "~~~") return "divider"; // PR-body pseudo-diff separator
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

function DiffRow({ line }: { line: string }) {
  const kind = classify(line);
  const s = STYLES[kind];
  const gutter =
    kind === "add" || kind === "del" ? line[0] : kind === "context" ? " " : "";
  const content = kind === "add" || kind === "del" ? line.slice(1) : line;
  return (
    <div style={{ display: "flex", background: s.bg, color: s.color }}>
      <span
        style={{
          flex: "0 0 auto",
          width: 20,
          textAlign: "center",
          userSelect: "none",
          color: "#8c959f",
          whiteSpace: "pre",
        }}
      >
        {gutter}
      </span>
      <span
        style={{
          flex: "1 1 auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          paddingRight: 8,
        }}
      >
        {kind === "divider" ? "" : content || "​"}
      </span>
    </div>
  );
}

export function DiffView({
  diff,
  maxHeight,
}: {
  diff: string;
  maxHeight?: number;
}) {
  if (!diff.trim()) return null;
  const files = parseFiles(diff);
  if (files.length === 0) return null;

  return (
    <div
      style={{
        maxHeight,
        overflow: "auto",
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {files.map((f, i) => (
        <div
          key={i}
          style={{
            border: "1px solid #d0d7de",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background: "#f6f8fa",
              borderBottom: "1px solid #d0d7de",
              padding: "6px 10px",
              color: "#1f2328",
              fontWeight: 600,
              wordBreak: "break-all",
            }}
          >
            {f.path || "changes"}
          </div>
          <div style={{ background: "#ffffff" }}>
            {f.lines.map((line, j) => (
              <DiffRow key={j} line={line} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
