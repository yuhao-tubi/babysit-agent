import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Dropdown,
  Input,
  Modal,
  Space,
  Spin,
  Tag,
  Timeline,
  Typography,
  message,
} from "antd";
import {
  RedoOutlined,
  ReloadOutlined,
  SendOutlined,
  LinkOutlined,
  WarningOutlined,
  CheckOutlined,
  CheckCircleOutlined,
  CommentOutlined,
  GithubOutlined,
  CopyOutlined,
} from "@ant-design/icons";
import type { ThreadDetail } from "./types";
import {
  fetchThread,
  sendInstruction,
  approveThread,
  approveReply,
  dismissReply,
  retryThread,
  rerunThread,
  replyToThread,
  resolveThread,
  refineInstruction,
} from "./api";
import { StatusTag } from "./status";
import { Markdown } from "./Markdown";
import { RelativeTime } from "./RelativeTime";
import { DiffView } from "./DiffView";
import { prUrl, VscodeLink } from "./prLinks";

const { Title, Text, Paragraph } = Typography;

/** Four-pointed concave "AI sparkle" glyph, sized to the current font. */
function SparkIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <span role="img" aria-label="ai-refine" style={{ display: "inline-flex", ...style }}>
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor">
        <path d="M12 0c.6 6.3 5.7 11.4 12 12-6.3.6-11.4 5.7-12 12-.6-6.3-5.7-11.4-12-12C6.3 11.4 11.4 6.3 12 0z" />
      </svg>
    </span>
  );
}

const RISK_COLOR: Record<string, string> = {
  low: "success",
  medium: "warning",
  high: "error",
};

/** Copy the manual-plan brief to the clipboard for pasting into Claude Code. */
async function copyPlan(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    message.success("Plan copied — paste it into Claude Code");
  } catch {
    message.error("Couldn't copy to clipboard");
  }
}

export function ThreadDetailView({
  id,
  onChanged,
}: {
  id: number;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [replying, setReplying] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [approving, setApproving] = useState(false);
  const [postingReply, setPostingReply] = useState(false);
  const [dismissingReply, setDismissingReply] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineNote, setRefineNote] = useState("");
  const [refinePreview, setRefinePreview] = useState("");
  const [refining, setRefining] = useState(false);

  const load = useCallback(() => {
    fetchThread(id).then(setDetail).catch(() => setDetail(null));
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  if (!detail) {
    return (
      <div style={{ textAlign: "center", paddingTop: 80 }}>
        <Spin tip={`Loading #${id}…`} />
      </div>
    );
  }

  const submit = async () => {
    if (!instruction.trim()) return;
    setBusy(true);
    await sendInstruction(id, instruction);
    setInstruction("");
    setBusy(false);
    onChanged();
    load();
  };

  const reply = async () => {
    if (!instruction.trim()) return;
    setReplying(true);
    await replyToThread(id, instruction);
    setInstruction("");
    setReplying(false);
    onChanged();
    load();
  };

  const resolve = async () => {
    setResolving(true);
    await resolveThread(id);
    setResolving(false);
    onChanged();
    load();
  };

  const retry = async () => {
    setRetrying(true);
    await retryThread(id);
    setRetrying(false);
    onChanged();
    load();
  };

  const rerun = async () => {
    setRerunning(true);
    await rerunThread(id);
    setRerunning(false);
    onChanged();
    load();
  };

  const approve = async () => {
    setApproving(true);
    try {
      await approveThread(id);
      // The push runs asynchronously on the server (re-check HEAD → re-run gate →
      // fast-forward push), which can take a while. Tell the owner it's in flight;
      // the outcome arrives as a live status change (resolved) or a toast (if it
      // couldn't complete). Without this the spinner cleared instantly and a failed
      // push looked like nothing happened.
      message.info("Re-checking against the latest HEAD and pushing… you'll see the result here.");
    } catch (e: any) {
      message.error(e?.message ?? "Couldn't start the push");
    } finally {
      setApproving(false);
      onChanged();
      load();
    }
  };

  const postReply = async () => {
    setPostingReply(true);
    await approveReply(id);
    setPostingReply(false);
    onChanged();
    load();
  };

  const skipReply = async () => {
    setDismissingReply(true);
    await dismissReply(id);
    setDismissingReply(false);
    onChanged();
    load();
  };

  // Open the AI-refine modal seeded with the current box text.
  const openRefine = () => {
    setRefinePreview(instruction);
    setRefineNote("");
    setRefineOpen(true);
  };

  // Run a one-shot Claude rewrite of the preview text using the note (direct API,
  // no agent). The result replaces the preview so the owner can iterate or edit.
  const runRefine = async () => {
    setRefining(true);
    try {
      const refined = await refineInstruction(id, refinePreview, refineNote);
      setRefinePreview(refined);
      setRefineNote("");
    } catch (e: any) {
      message.error(e?.message ?? "Refine failed");
    } finally {
      setRefining(false);
    }
  };

  // Accept the refined preview back into the instruction box.
  const applyRefine = () => {
    setInstruction(refinePreview);
    setRefineOpen(false);
  };

  return (
    <Space direction="vertical" size={16} style={{ maxWidth: 900, width: "100%" }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} align="start">
        <div>
          <Title level={3} style={{ margin: 0 }}>
            {detail.prKey}
            {prUrl(detail.prKey) && (
              <a
                href={prUrl(detail.prKey)!}
                target="_blank"
                rel="noreferrer"
                title="Open PR on GitHub"
                style={{ marginInlineStart: 8, fontSize: 18 }}
              >
                <GithubOutlined />
              </a>
            )}
            <VscodeLink
              githubUrl={prUrl(detail.prKey)}
              style={{ marginInlineStart: 8, fontSize: 18 }}
            />
          </Title>
          <Space size={8} style={{ marginTop: 4 }}>
            <Text type="secondary">{detail.threadKey}</Text>
            <StatusTag status={detail.status} />
            <Tag>{detail.authorClass}</Tag>
            {detail.attemptCount > 0 && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {detail.attemptCount} attempt{detail.attemptCount === 1 ? "" : "s"}
              </Text>
            )}
          </Space>
        </div>
        <Space>
          {detail.status !== "resolved" && (
            <Button
              icon={<CheckCircleOutlined />}
              loading={resolving}
              onClick={resolve}
              title="Mark this thread resolved (and resolve the GitHub thread if it's an inline comment)"
            >
              Mark resolved
            </Button>
          )}
          <Dropdown.Button
            loading={retrying || rerunning}
            onClick={retry}
            disabled={!detail.verdict}
            trigger={["hover"]}
            buttonsRender={([left, right]) => [
              <span
                key="left"
                title="Resume from the last state, reusing the existing verdict (e.g. after a transient commit/push failure)"
              >
                {left}
              </span>,
              right,
            ]}
            menu={{
              items: [
                {
                  key: "rerun",
                  icon: <RedoOutlined />,
                  label: "Fresh Rerun",
                  onClick: rerun,
                },
              ],
            }}
          >
            <ReloadOutlined /> Retry
          </Dropdown.Button>
        </Space>
      </Space>

      {detail.error && (
        <Alert type="error" showIcon icon={<WarningOutlined />} message={detail.error} />
      )}

      {detail.verdict && (
        <Card
          size="small"
          title={
            <Space>
              <Text strong>Verdict</Text>
              <Tag color="blue">{detail.verdict.action}</Tag>
              <Tag color={RISK_COLOR[detail.verdict.risk] ?? "default"}>
                risk: {detail.verdict.risk}
              </Tag>
            </Space>
          }
        >
          <Paragraph style={{ marginBottom: detail.verdict.reply_draft ? 12 : 0 }}>
            {detail.verdict.summary}
          </Paragraph>
          {detail.verdict.reply_draft && (
            <Markdown>{detail.verdict.reply_draft}</Markdown>
          )}
        </Card>
      )}

      {/* CHANGE part — code diff / PR-description rewrite / manual plan. The
          reply (if any) is a separate, independently-approvable card below. */}
      {detail.proposal && detail.proposal.kind !== "reply" && (
        <Card
          size="small"
          title={
            <Space>
              <Text strong>
                {detail.proposal.kind === "manual_plan" ? "Manual plan" : "Proposed plan"}
              </Text>
              <Tag
                color={
                  detail.proposal.kind === "pr_body"
                    ? "purple"
                    : detail.proposal.kind === "manual_plan"
                      ? "volcano"
                      : "geekblue"
                }
              >
                {detail.proposal.kind === "pr_body"
                  ? "PR description"
                  : detail.proposal.kind === "manual_plan"
                    ? "copy to Claude Code"
                    : "code"}
              </Tag>
              {detail.proposal.gatePassed && detail.proposal.kind === "code" && (
                <Tag color="success">gate passed</Tag>
              )}
              {detail.proposal.changeApplied && <Tag color="success">applied</Tag>}
            </Space>
          }
          extra={
            detail.proposal.kind === "manual_plan" ? (
              <Button
                type="primary"
                icon={<CopyOutlined />}
                onClick={() => copyPlan(detail.proposal!.planMarkdown)}
              >
                Copy plan
              </Button>
            ) : detail.status === "in_progress" && !detail.proposal.changeApplied ? (
              // The approval is in flight (queued/running on the server: re-check
              // HEAD → re-gate → push). Show it so the click is visibly registered
              // even while a long re-gate runs — the button won't reappear until
              // the server reports a terminal status.
              <Space>
                <Spin size="small" />
                <Text type="secondary">
                  {detail.proposal.kind === "code" ? "Re-checking & pushing…" : "Applying…"}
                </Text>
              </Space>
            ) : (
              // Approvable whenever the change part is still pending — even if the
              // Thread already `resolved` because the reply was approved first. Each
              // part is independent; approving one never forecloses the other.
              !detail.proposal.changeApplied && (
                <Button
                  type="primary"
                  icon={<CheckOutlined />}
                  loading={approving}
                  onClick={approve}
                >
                  {detail.proposal.kind === "code" ? "Approve & push code" : "Approve & update description"}
                </Button>
              )
            )
          }
        >
          <Paragraph type="secondary" style={{ fontSize: 12 }}>
            {detail.proposal.kind === "code"
              ? "Not pushed yet. Review the diff, then “Approve & push code” re-checks it against the latest branch HEAD, re-runs the gate, and pushes these exact changes. The reply below is approved separately. Or send a freeform instruction to revise the proposal — it will re-propose for you to review again."
              : detail.proposal.kind === "manual_plan"
                ? "This change was too large to apply automatically (the fix agent ran out of turns). Copy the brief below, open this PR's branch in Claude Code, and paste it to finish the change by hand. The daemon will not push this."
                : "Not applied yet. Review the change, then “Approve & update description” updates the PR description. The reply below is approved separately. Or send a freeform instruction to revise it."}
          </Paragraph>
          {detail.proposal.kind === "manual_plan" ? (
            <Pre maxHeight={480}>{detail.proposal.planMarkdown}</Pre>
          ) : (
            detail.proposal.planMarkdown && (
              <Markdown>{detail.proposal.planMarkdown}</Markdown>
            )
          )}
          {detail.proposal.kind === "code" && detail.proposal.diff && (
            <DiffView maxHeight={360} diff={detail.proposal.diff} />
          )}
          {detail.proposal.kind === "pr_body" && (
            <>
              {detail.proposal.bodyDiff && (
                <DiffView maxHeight={360} diff={detail.proposal.bodyDiff} />
              )}
              <Title level={5} style={{ marginTop: 12 }}>
                New description (preview)
              </Title>
              <Markdown>{detail.proposal.proposedBody ?? ""}</Markdown>
            </>
          )}
        </Card>
      )}

      {/* REPLY part — a drafted comment, approved independently of the change.
          Hidden while the Thread is `blocked` on a decision with options: the
          verdict text is a question to you (shown as choosable tags in the
          instruction box), not a GitHub-ready reply. Once you send an
          instruction the Thread re-proposes to `awaiting_approval`, so the card
          (and its Post button) returns. */}
      {detail.proposal &&
        detail.proposal.replyDraft?.trim() &&
        !detail.proposal.replyPosted &&
        !detail.proposal.replyDismissed &&
        !(
          detail.status === "blocked" &&
          detail.verdict?.options &&
          detail.verdict.options.length > 0
        ) && (
          <Card
            size="small"
            title={
              <Space>
                <Text strong>Proposed reply</Text>
                <Tag color="cyan">reply</Tag>
              </Space>
            }
            extra={
              // Independent of the Thread's overall status: the reply stays
              // postable even after the Thread `resolved` because the change was
              // approved first. The card itself is only rendered while the reply is
              // neither posted nor dismissed (see condition above).
              <Space>
                <Button
                  icon={<CopyOutlined />}
                  onClick={() => copyPlan(detail.proposal!.replyDraft!)}
                  title="Copy the draft so you can refine it in the instruction box below"
                >
                  Copy
                </Button>
                <Button
                  loading={dismissingReply}
                  onClick={skipReply}
                  title="Don't post this reply (you'll reply by hand, or no reply is needed)"
                >
                  Dismiss
                </Button>
                <Button
                  type="primary"
                  icon={<CommentOutlined />}
                  loading={postingReply}
                  onClick={postReply}
                >
                  Post reply
                </Button>
              </Space>
            }
          >
            <Paragraph type="secondary" style={{ fontSize: 12 }}>
              Not posted yet. “Post reply” posts this to the GitHub thread. It is
              independent of the change above — push the code without it, or post
              it without the code. “Copy” drops the text into the instruction box
              to refine; a freeform instruction re-drafts it.
            </Paragraph>
            <Markdown>{detail.proposal.replyDraft}</Markdown>
          </Card>
        )}

      <Card size="small" title={`Feedback (${detail.items.length})`}>
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          {detail.items.map((it) => (
            <div key={it.ghId}>
              <Space size={6} wrap style={{ marginBottom: 4 }}>
                <Text strong style={{ fontSize: 12 }}>
                  {it.author}
                </Text>
                <Tag style={{ marginInlineEnd: 0 }}>{it.authorType}</Tag>
                <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                  {it.kind}
                </Tag>
                {it.path && (
                  <Text type="secondary" style={{ fontSize: 12 }} code>
                    {it.path}
                    {it.line ? `:${it.line}` : ""}
                  </Text>
                )}
                {it.htmlUrl && (
                  <a href={it.htmlUrl} target="_blank" rel="noreferrer">
                    <LinkOutlined /> open
                  </a>
                )}
                <RelativeTime at={it.createdAt} />
              </Space>
              <Markdown>{it.body}</Markdown>
            </div>
          ))}
        </Space>
      </Card>

      {detail.newCommits && detail.newCommits.commits.length > 0 && (
        <Card
          size="small"
          title={
            <Space>
              <Text strong>Branch advanced</Text>
              <Tag color="gold">
                {detail.newCommits.commits.length} new commit
                {detail.newCommits.commits.length === 1 ? "" : "s"}
              </Tag>
            </Space>
          }
        >
          <Paragraph type="secondary" style={{ fontSize: 12 }}>
            Commits pushed to the branch since this thread stalled — a fix may
            already have landed. This does not resolve the thread; if it's
            addressed, use “Mark resolved”.
          </Paragraph>
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {detail.newCommits.commits.map((c) => (
              <Space key={c.sha} size={8} wrap>
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer">
                    <Text code style={{ fontSize: 12 }}>
                      {c.sha.slice(0, 7)}
                    </Text>
                  </a>
                ) : (
                  <Text code style={{ fontSize: 12 }}>
                    {c.sha.slice(0, 7)}
                  </Text>
                )}
                <Text style={{ fontSize: 13 }}>{c.message}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {c.author}
                </Text>
              </Space>
            ))}
          </Space>
        </Card>
      )}

      {detail.diff && (
        <Card size="small" title="Applied diff">
          <DiffView maxHeight={360} diff={detail.diff} />
        </Card>
      )}

      <Card size="small" title="Your instruction">
        <Paragraph type="secondary" style={{ fontSize: 12 }}>
          “Send to agent” is freeform and always RE-PROPOSES — e.g. “add the null
          check, it’s valid” or “update all four call sites for consistency”. It
          never pushes; only Approve on a proposal does. Prefix with “reply:” to
          park that text as a reply you review and Post above (no code change), or
          “ignore” to drop it. “Reply on GitHub” posts your text verbatim and
          marks this resolved. Tap the spark in the box corner to have Claude
          rewrite the text.
        </Paragraph>
        {detail.verdict?.options && detail.verdict.options.length > 0 && (
          <Space wrap size={6} style={{ marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Options:
            </Text>
            {detail.verdict.options.map((opt, i) => (
              <Tag.CheckableTag
                key={i}
                checked={instruction === opt}
                onChange={() => setInstruction(opt)}
                style={{ border: "1px solid #d9d9d9", cursor: "pointer" }}
              >
                {opt}
              </Tag.CheckableTag>
            ))}
          </Space>
        )}
        <div style={{ position: "relative" }}>
          <Input.TextArea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            placeholder="Tell the agent what to do, or write a reply…"
            autoSize={{ minRows: 3, maxRows: 8 }}
          />
          <Button
            size="small"
            type="text"
            icon={<SparkIcon style={{ color: "#722ed1" }} />}
            onClick={openRefine}
            title="AI refine — let Claude rewrite this text (a direct one-shot rewrite, not an agent run)"
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              zIndex: 1,
              background: "rgba(255,255,255,0.85)",
            }}
          />
        </div>
        <Space style={{ marginTop: 12 }}>
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={submit}
            loading={busy}
            disabled={!instruction.trim()}
          >
            Send to agent
          </Button>
          <Button
            icon={<CommentOutlined />}
            onClick={reply}
            loading={replying}
            disabled={!instruction.trim()}
            title="Post this text directly to the GitHub thread (no agent), then mark resolved"
          >
            Reply on GitHub
          </Button>
        </Space>
      </Card>

      <Modal
        title="AI refine"
        open={refineOpen}
        onCancel={() => setRefineOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setRefineOpen(false)}>
            Cancel
          </Button>,
          <Button
            key="refine"
            icon={<SparkIcon />}
            loading={refining}
            onClick={runRefine}
            disabled={!refinePreview.trim() && !refineNote.trim()}
          >
            Refine
          </Button>,
          <Button
            key="apply"
            type="primary"
            icon={<CheckOutlined />}
            onClick={applyRefine}
            disabled={!refinePreview.trim()}
          >
            Use this text
          </Button>,
        ]}
        width={640}
      >
        <Paragraph type="secondary" style={{ fontSize: 12 }}>
          Edit the text directly, or describe how to change it and click Refine —
          Claude rewrites it in place (grounded in this thread's feedback). “Use
          this text” drops the result back into the instruction box.
        </Paragraph>
        <Text strong style={{ fontSize: 12 }}>
          How to refine (optional)
        </Text>
        <Input
          value={refineNote}
          onChange={(e) => setRefineNote(e.target.value)}
          placeholder="e.g. make it firmer, shorter, explain why we disagree…"
          onPressEnter={runRefine}
          style={{ margin: "4px 0 12px" }}
        />
        <Text strong style={{ fontSize: 12 }}>
          Text
        </Text>
        <Input.TextArea
          value={refinePreview}
          onChange={(e) => setRefinePreview(e.target.value)}
          autoSize={{ minRows: 4, maxRows: 14 }}
          style={{ marginTop: 4 }}
        />
      </Modal>

      <Card size="small" title="Activity">
        {detail.events.length === 0 ? (
          <Text type="secondary">No activity yet.</Text>
        ) : (
          <Timeline
            items={detail.events.map((e) => ({
              children: (
                <Space direction="vertical" size={0}>
                  <Space size={6}>
                    <Tag style={{ marginInlineEnd: 0 }}>{e.kind}</Tag>
                    <RelativeTime at={e.at} />
                  </Space>
                  <EventMessage message={e.message} />
                </Space>
              ),
            }))}
          />
        )}
      </Card>
    </Space>
  );
}

/** Number of lines (or characters) beyond which an event message is folded. */
const EVENT_FOLD_LINES = 8;
const EVENT_FOLD_CHARS = 600;

/**
 * An Activity event message. Long messages (multi-line command output like a
 * gate log) are folded to a preview with a "Show more" toggle so the timeline
 * stays scannable; short ones render inline as before.
 */
function EventMessage({ message }: { message: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = message.split("\n");
  const isLong = lines.length > EVENT_FOLD_LINES || message.length > EVENT_FOLD_CHARS;

  const shown =
    isLong && !expanded
      ? lines.slice(0, EVENT_FOLD_LINES).join("\n").slice(0, EVENT_FOLD_CHARS)
      : message;

  return (
    <div>
      <Text
        style={{
          fontSize: 13,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          display: "block",
        }}
      >
        {shown}
        {isLong && !expanded && "…"}
      </Text>
      {isLong && (
        <Button
          type="link"
          size="small"
          style={{ padding: 0, height: "auto", fontSize: 12 }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}

function Pre({
  children,
  maxHeight,
  mono,
}: {
  children: React.ReactNode;
  maxHeight?: number;
  mono?: boolean;
}) {
  return (
    <pre
      style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        background: "#f6f7f9",
        border: "1px solid #f0f0f0",
        padding: 12,
        borderRadius: 8,
        fontSize: 12,
        fontFamily: mono
          ? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
          : "inherit",
        margin: 0,
        maxHeight,
        overflow: "auto",
      }}
    >
      {children}
    </pre>
  );
}
