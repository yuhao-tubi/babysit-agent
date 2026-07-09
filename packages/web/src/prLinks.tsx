/**
 * Helpers for the external links shown next to a PR title: the GitHub link and
 * the adjacent VS Code online-review link (`vscode.dev/github/...`).
 */
import type { ReactElement } from "react";
import { CodeOutlined } from "@ant-design/icons";

/** GitHub PR URL from a prKey of the form `owner/repo#number`. */
export function prUrl(prKey: string): string | null {
  const m = prKey.match(/^(.+?)\/(.+?)#(\d+)$/);
  return m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` : null;
}

/** vscode.dev online-review URL for a GitHub PR URL (or null if not a PR URL). */
export function vscodeUrl(githubUrl: string | null | undefined): string | null {
  if (!githubUrl) return null;
  const m = githubUrl.match(/github\.com\/(.+?)\/(.+?)\/pull\/(\d+)/);
  return m ? `https://vscode.dev/github/${m[1]}/${m[2]}/pull/${m[3]}` : null;
}

/** VS Code review-env link, rendered adjacent to the GitHub icon. */
export function VscodeLink({
  githubUrl,
  style,
  onClick,
}: {
  githubUrl: string | null | undefined;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent) => void;
}): ReactElement | null {
  const url = vscodeUrl(githubUrl);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title="Open PR in VS Code (vscode.dev)"
      style={style}
      onClick={onClick}
    >
      <CodeOutlined />
    </a>
  );
}
