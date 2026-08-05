import { useState } from "react";
import { Button, Tooltip, message } from "antd";
import { CopyOutlined, CheckOutlined } from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";
import { Mermaid } from "./Mermaid";

/**
 * Route ```mermaid fences to the <Mermaid> renderer instead of a highlighted code
 * block, so any markdown surface can carry a diagram (Explanations author them;
 * GitHub renders the same fences natively, so pasted comments work too). A broken
 * chart is safe: <Mermaid> falls back to showing the raw source.
 */
const components = {
  code({ className, children, ...props }: any) {
    if (/\blanguage-mermaid\b/.test(className ?? "")) {
      return <Mermaid chart={String(children).replace(/\n$/, "")} />;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

/**
 * Renders GitHub-flavored markdown as a preview, with a button to copy the raw
 * source text to the clipboard.
 */
export function Markdown({
  children,
  maxHeight,
}: {
  children: string;
  maxHeight?: number;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      message.error("Couldn’t copy to clipboard");
    }
  };

  return (
    <div
      style={{
        position: "relative",
        background: "#f6f7f9",
        border: "1px solid #f0f0f0",
        borderRadius: 8,
        fontSize: 13,
        maxHeight,
        overflow: "auto",
      }}
    >
      <Tooltip title={copied ? "Copied" : "Copy raw markdown"}>
        <Button
          size="small"
          type="text"
          icon={copied ? <CheckOutlined /> : <CopyOutlined />}
          onClick={copy}
          style={{ position: "absolute", top: 6, right: 6, zIndex: 1 }}
        />
      </Tooltip>

      <div className="md-body" style={{ padding: "4px 36px 12px 12px" }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
          components={components}
        >
          {children}
        </ReactMarkdown>
      </div>
    </div>
  );
}
