import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Modal, Progress, Space, Tag, Typography } from "antd";
import {
  BulbOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  ReloadOutlined,
  RedoOutlined,
  TrophyOutlined,
} from "@ant-design/icons";
import type { QuizQuestion, QuizStatus } from "./types";
import { Markdown } from "./Markdown";

const { Text, Title } = Typography;

/**
 * Client-side quiz progress persisted to localStorage so closing/reopening the
 * modal resumes where you left off. Keyed by prKey; the stored `sig` is a
 * content signature of the quiz — a Regenerate produces a different signature, so
 * stale progress from a previous quiz version is discarded rather than misapplied.
 */
interface QuizProgress {
  sig: string;
  current: number;
  answers: Record<number, number>;
}

const storageKey = (prKey: string) => `babysit.quiz.${prKey}`;

/** Stable signature of the quiz content (questions + correct answers). */
function quizSignature(quiz: QuizQuestion[]): string {
  return JSON.stringify(quiz.map((q) => [q.question, q.correctIndex, q.options.length]));
}

function loadProgress(prKey: string, sig: string): QuizProgress | null {
  try {
    const raw = localStorage.getItem(storageKey(prKey));
    if (!raw) return null;
    const p = JSON.parse(raw) as QuizProgress;
    // Only honor progress that belongs to THIS quiz version.
    if (!p || p.sig !== sig || typeof p.current !== "number" || !p.answers) return null;
    return p;
  } catch {
    return null;
  }
}

function saveProgress(prKey: string, p: QuizProgress): void {
  try {
    localStorage.setItem(storageKey(prKey), JSON.stringify(p));
  } catch {
    /* quota / disabled storage — progress is best-effort */
  }
}

function clearProgress(prKey: string): void {
  try {
    localStorage.removeItem(storageKey(prKey));
  } catch {
    /* ignore */
  }
}

/**
 * PR-comprehension QUIZ panel — a Session artifact rendered inside OverviewPanel.
 * On-demand: nothing generates until the owner clicks "Quiz me". Taking the quiz
 * happens in a MODAL, one question at a time: pick an answer → instant client-side
 * feedback (the correct index + explanation are baked into the artifact) → Next,
 * ending on a results screen. The owner's answers are ephemeral (browser state
 * only). Progress arrives via the `pr_quiz_updated` SSE event, surfaced through
 * the parent's `refreshKey`.
 */
export function QuizPanel({
  prKey,
  quiz,
  status,
  stale,
  hasOverview,
  busy,
  onGenerate,
}: {
  prKey: string;
  quiz: QuizQuestion[];
  status: QuizStatus | null;
  stale: boolean;
  hasOverview: boolean;
  busy: boolean;
  onGenerate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const generating = status === "generating";
  const hasQuiz = status === "ready" && !stale && quiz.length > 0;

  return (
    <div style={{ marginTop: 16, borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          <BulbOutlined /> Quiz — check your understanding of this PR
        </Text>
        <Space size={8}>
          {hasQuiz && (
            <Button size="small" type="primary" onClick={() => setOpen(true)}>
              Take quiz ({quiz.length})
            </Button>
          )}
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={busy || generating}
            disabled={!hasOverview || generating}
            onClick={onGenerate}
          >
            {hasQuiz ? "Regenerate" : "Quiz me"}
          </Button>
        </Space>
      </Space>

      {!hasOverview && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          Generate an overview first — the quiz is grounded on it.
        </Text>
      )}

      {generating && (
        <Alert
          type="info"
          showIcon
          message="Generating quiz…"
          description="Investigating the PR diff to write comprehension questions. This runs one agent pass and may take a minute."
          style={{ marginBottom: 8 }}
        />
      )}

      {status === "failed" && !generating && (
        <Alert
          type="error"
          showIcon
          message="Quiz generation failed"
          description="No usable questions were produced. Try Regenerate."
          style={{ marginBottom: 8 }}
        />
      )}

      {stale && !generating && (
        <Alert
          type="warning"
          showIcon
          message="This quiz is out of date"
          description="The PR head has moved since the quiz was generated. Regenerate to quiz against the current code."
          style={{ marginBottom: 8 }}
        />
      )}

      {hasOverview && !hasQuiz && !generating && status !== "failed" && !stale && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          No quiz yet. Click “Quiz me” to generate a few questions and test yourself.
        </Text>
      )}

      {hasQuiz && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {quiz.length} question{quiz.length === 1 ? "" : "s"} ready. Click “Take quiz” to answer
          them one at a time.
        </Text>
      )}

      <QuizModal prKey={prKey} open={open} quiz={quiz} onClose={() => setOpen(false)} />
    </div>
  );
}

/**
 * The modal quiz-taking flow. Steps through each question; the final step is the
 * results screen. Progress (`current` + `answers`) is persisted to localStorage
 * per-PR, so closing and reopening the modal resumes where you left off — until
 * you Retake (clears it) or Regenerate (changes the content signature).
 *
 * `destroyOnHidden` unmounts QuizRunner on close, so it re-initializes from
 * localStorage on the next open — exactly the resume behavior we want.
 */
function QuizModal({
  prKey,
  open,
  quiz,
  onClose,
}: {
  prKey: string;
  open: boolean;
  quiz: QuizQuestion[];
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      destroyOnHidden
      title={
        <span>
          <BulbOutlined /> PR comprehension quiz
        </span>
      }
    >
      <QuizRunner prKey={prKey} quiz={quiz} onClose={onClose} />
    </Modal>
  );
}

function QuizRunner({
  prKey,
  quiz,
  onClose,
}: {
  prKey: string;
  quiz: QuizQuestion[];
  onClose: () => void;
}) {
  const sig = useMemo(() => quizSignature(quiz), [quiz]);
  // Resume from persisted progress for THIS quiz version, if any.
  const saved = useMemo(() => loadProgress(prKey, sig), [prKey, sig]);
  // `current` walks 0..quiz.length; the final value (=== length) is the results
  // screen. `answers[i]` is undefined until question i is answered, then locked.
  const [current, setCurrent] = useState(saved?.current ?? 0);
  const [answers, setAnswers] = useState<Record<number, number>>(saved?.answers ?? {});

  // Persist on every change so a mid-quiz close is remembered.
  useEffect(() => {
    saveProgress(prKey, { sig, current, answers });
  }, [prKey, sig, current, answers]);

  const onRetake = () => {
    clearProgress(prKey);
    setAnswers({});
    setCurrent(0);
  };

  const correctCount = Object.entries(answers).filter(
    ([qi, oi]) => quiz[Number(qi)]?.correctIndex === oi
  ).length;

  // Results screen.
  if (current >= quiz.length) {
    return (
      <Results
        quiz={quiz}
        answers={answers}
        correctCount={correctCount}
        onRetake={onRetake}
        onClose={onClose}
      />
    );
  }

  const q = quiz[current];
  const selected = answers[current];
  const answered = selected !== undefined;
  const isLast = current === quiz.length - 1;

  return (
    <div>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 4 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Question {current + 1} of {quiz.length}
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {correctCount} correct so far
        </Text>
      </Space>
      <Progress
        percent={Math.round((current / quiz.length) * 100)}
        showInfo={false}
        size="small"
        style={{ marginBottom: 16 }}
      />

      <QuestionBody
        q={q}
        selected={selected}
        onSelect={(oi) =>
          setAnswers((a) => (current in a ? a : { ...a, [current]: oi }))
        }
      />

      <div style={{ marginTop: 20, textAlign: "right" }}>
        <Button
          type="primary"
          disabled={!answered}
          onClick={() => setCurrent((c) => c + 1)}
        >
          {isLast ? "See results" : "Next question"}
        </Button>
      </div>
    </div>
  );
}

/** A single question: options + (after answering) feedback and explanation. */
function QuestionBody({
  q,
  selected,
  onSelect,
}: {
  q: QuizQuestion;
  selected: number | undefined;
  onSelect: (optionIndex: number) => void;
}) {
  const answered = selected !== undefined;
  const gotItRight = answered && selected === q.correctIndex;

  return (
    <div>
      <Text strong style={{ display: "block", marginBottom: 12, fontSize: 15 }}>
        {q.question}
      </Text>
      <Space direction="vertical" style={{ width: "100%" }} size={8}>
        {q.options.map((opt, oi) => {
          const isCorrect = oi === q.correctIndex;
          const isChosen = oi === selected;
          let bg = "transparent";
          let border = "#d9d9d9";
          if (answered) {
            if (isCorrect) {
              bg = "#f6ffed";
              border = "#b7eb8f";
            } else if (isChosen) {
              bg = "#fff2f0";
              border = "#ffccc7";
            }
          }
          return (
            <button
              key={oi}
              type="button"
              disabled={answered}
              onClick={() => onSelect(oi)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                textAlign: "left",
                padding: "10px 12px",
                borderRadius: 8,
                border: `1px solid ${border}`,
                background: bg,
                cursor: answered ? "default" : "pointer",
                font: "inherit",
                color: "inherit",
              }}
            >
              {answered && isCorrect ? (
                <CheckCircleFilled style={{ color: "#52c41a" }} />
              ) : answered && isChosen && !isCorrect ? (
                <CloseCircleFilled style={{ color: "#ff4d4f" }} />
              ) : (
                <span
                  style={{
                    display: "inline-block",
                    width: 18,
                    textAlign: "center",
                    color: "#8c8c8c",
                  }}
                >
                  {String.fromCharCode(65 + oi)}
                </span>
              )}
              <span>{opt}</span>
            </button>
          );
        })}
      </Space>

      {answered && (
        <div style={{ marginTop: 14 }}>
          <Tag color={gotItRight ? "success" : "error"}>
            {gotItRight ? "Correct" : "Not quite"}
          </Tag>
          <div style={{ marginTop: 6 }}>
            <Markdown>{q.explanation}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
}

/** Final results screen: score + a compact per-question recap. */
function Results({
  quiz,
  answers,
  correctCount,
  onRetake,
  onClose,
}: {
  quiz: QuizQuestion[];
  answers: Record<number, number>;
  correctCount: number;
  onRetake: () => void;
  onClose: () => void;
}) {
  const total = quiz.length;
  const pct = Math.round((correctCount / total) * 100);
  const perfect = correctCount === total;
  const strong = pct >= 70;

  return (
    <div>
      <div style={{ textAlign: "center", padding: "8px 0 16px" }}>
        <Progress
          type="circle"
          percent={pct}
          format={() => `${correctCount}/${total}`}
          strokeColor={perfect ? "#52c41a" : strong ? "#1677ff" : "#faad14"}
          size={120}
        />
        <Title level={4} style={{ marginTop: 16, marginBottom: 4 }}>
          <TrophyOutlined style={{ color: perfect ? "#faad14" : undefined }} />{" "}
          {perfect
            ? "Perfect score!"
            : strong
            ? "Nicely done"
            : "Worth another look"}
        </Title>
        <Text type="secondary">
          {perfect
            ? "You clearly understand what this PR changes."
            : strong
            ? "Solid grasp — review the ones you missed below."
            : "Revisit the overview and diagram, then retake."}
        </Text>
      </div>

      <Space direction="vertical" style={{ width: "100%" }} size={8}>
        {quiz.map((q, qi) => {
          const chosen = answers[qi];
          const right = chosen === q.correctIndex;
          return (
            <div
              key={qi}
              style={{
                display: "flex",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 6,
                border: "1px solid #f0f0f0",
              }}
            >
              {right ? (
                <CheckCircleFilled style={{ color: "#52c41a", marginTop: 3 }} />
              ) : (
                <CloseCircleFilled style={{ color: "#ff4d4f", marginTop: 3 }} />
              )}
              <div style={{ flex: 1 }}>
                <Text style={{ fontSize: 13 }}>
                  {qi + 1}. {q.question}
                </Text>
                {!right && (
                  <div style={{ fontSize: 12, marginTop: 2 }}>
                    <Text type="danger">
                      Your answer: {chosen !== undefined ? q.options[chosen] : "—"}
                    </Text>
                    <br />
                    <Text type="success">Correct: {q.options[q.correctIndex]}</Text>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </Space>

      <div style={{ marginTop: 20, textAlign: "right" }}>
        <Space>
          <Button icon={<RedoOutlined />} onClick={onRetake}>
            Retake
          </Button>
          <Button type="primary" onClick={onClose}>
            Close
          </Button>
        </Space>
      </div>
    </div>
  );
}
