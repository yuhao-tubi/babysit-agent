import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Modal, Segmented, Space, Tag, message } from "antd";
import { EditOutlined, EyeOutlined, SaveOutlined } from "@ant-design/icons";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import type { DiagramSection, DiagramSet as DiagramSetT, ExcalidrawDoc } from "./types";
import { savePrDiagram } from "./api";

/**
 * Renders the 4W1H PR-overview diagram set as Excalidraw canvases — one per
 * section (Why / What / How), shown one at a time via a section switcher. Each
 * canvas defaults to READ-ONLY (`viewModeEnabled`): the toolbar is hidden and
 * only pan/zoom works. An Edit button in the header flips the live canvas into
 * edit mode, revealing the toolbar + Save. The agent authored each `.excalidraw`
 * document (coordinates and all); saving (PUT /api/prs/:key/diagrams) makes the
 * owner's edits the durable truth and stamps `diagramsEditedAt` server-side.
 */

const SECTION_LABEL: Record<DiagramSection, string> = { why: "Why", what: "What", how: "How" };
const SECTION_ORDER: DiagramSection[] = ["why", "what", "how"];

/** Chrome trimmed away while read-only — no export/save-to-file/help clutter. */
const VIEW_UI_OPTIONS = {
  canvasActions: {
    saveToActiveFile: false,
    loadScene: false,
    export: false as const,
    saveAsImage: false,
    toggleTheme: false,
    clearCanvas: false,
    changeViewBackgroundColor: false,
  },
} as const;

/**
 * A stable signature of the scene's live (non-deleted) elements. Panning/zooming
 * only mutates appState, so it leaves this untouched — that's how we tell a
 * genuine edit apart from Excalidraw's onChange noise (pan/zoom, initial settle).
 */
function sceneSig(elements: readonly any[]): string {
  return elements
    .filter((e) => !e.isDeleted)
    .map((e) => `${e.id}:${e.version}`)
    .join(",");
}

/** One canvas. Keyed by section+prKey so switching sections remounts cleanly. */
function OneCanvas({
  prKey,
  section,
  doc,
  onDirtyChange,
}: {
  prKey: string;
  section: DiagramSection;
  doc: ExcalidrawDoc;
  /** Report unsaved-edit state up so the parent can guard section switches. */
  onDirtyChange: (dirty: boolean) => void;
}) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Read-only by default, always — never persisted across loads/section switches.
  const [viewMode, setViewMode] = useState(true);
  // Signature of the last saved (or initial) scene; edits are diffed against it.
  const savedSigRef = useRef(sceneSig((doc.elements as any[]) ?? []));

  const setDirtyState = (next: boolean) => {
    setDirty(next);
    onDirtyChange(next);
  };

  // Snapshot the agent's document as the initial scene. Excalidraw mutates its
  // own internal state from here; we pull the latest via the imperative API on Save.
  const initialData = useMemo(
    () => ({
      elements: (doc.elements as any[]) ?? [],
      appState: {
        ...(doc.appState as any),
        viewBackgroundColor: (doc.appState as any)?.viewBackgroundColor ?? "#ffffff",
        // Never persist the collab/selection cruft into our stored doc.
        collaborators: undefined,
      },
      files: (doc.files as any) ?? {},
      scrollToContent: true,
    }),
    [doc]
  );

  const save = async () => {
    const api = apiRef.current;
    if (!api) return;
    setSaving(true);
    try {
      const next: ExcalidrawDoc = {
        type: "excalidraw",
        version: 2,
        source: "babysit-agent",
        // getSceneElements() excludes deleted elements — exactly what we want to store.
        elements: api.getSceneElements() as unknown[],
        appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor ?? "#ffffff" },
        files: api.getFiles() as Record<string, unknown>,
      };
      await savePrDiagram(prKey, section, next);
      // The saved scene becomes the new clean baseline; stay in edit mode.
      savedSigRef.current = sceneSig(api.getSceneElements() as any[]);
      setDirtyState(false);
      message.success(`Saved ${SECTION_LABEL[section]} diagram`);
    } catch (e: any) {
      message.error(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // Flip back to read-only, guarding unsaved edits.
  const exitEdit = () => {
    if (dirty) {
      Modal.confirm({
        title: "Discard unsaved edits?",
        content: "This diagram has changes that haven't been saved.",
        okText: "Discard",
        okButtonProps: { danger: true },
        cancelText: "Keep editing",
        onOk: () => {
          const api = apiRef.current;
          // Revert the canvas to the last saved/initial scene.
          if (api) api.updateScene({ elements: initialData.elements as any });
          setDirtyState(false);
          setViewMode(true);
        },
      });
      return;
    }
    setViewMode(true);
  };

  return (
    <div
      style={{
        border: "1px solid #f0f0f0",
        borderRadius: 8,
        background: "#fff",
        marginBottom: 12,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "6px 10px",
          borderBottom: "1px solid #f5f5f5",
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
        }}
      >
        {viewMode ? (
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => setViewMode(false)}
          >
            Edit
          </Button>
        ) : (
          <>
            <Button
              size="small"
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              disabled={!dirty}
              onClick={save}
            >
              {dirty ? "Save edits" : "Saved"}
            </Button>
            <Button size="small" icon={<EyeOutlined />} onClick={exitEdit}>
              Done
            </Button>
          </>
        )}
      </div>
      {/* Excalidraw fills its parent; give it a 4:3 viewport (height tracks width). */}
      <div style={{ aspectRatio: "4 / 3", width: "100%" }}>
        <Excalidraw
          excalidrawAPI={(api) => (apiRef.current = api)}
          initialData={initialData}
          viewModeEnabled={viewMode}
          UIOptions={viewMode ? VIEW_UI_OPTIONS : undefined}
          onChange={(elements) => {
            // Only genuine edits made while editing count. View-mode pan/zoom and
            // the initial scene settle leave the element signature unchanged.
            if (viewMode) return;
            const nextDirty = sceneSig(elements as any[]) !== savedSigRef.current;
            if (nextDirty !== dirty) setDirtyState(nextDirty);
          }}
        />
      </div>
      <Space size={6} style={{ padding: "6px 10px 8px", borderTop: "1px solid #f5f5f5" }}>
        <Tag color={viewMode ? "default" : "blue"} style={{ fontSize: 10 }}>
          {viewMode ? "read-only" : "editing"}
        </Tag>
        <span style={{ fontSize: 11, color: "#94a3b8" }}>
          {viewMode
            ? "Click Edit to rearrange or modify, then Save. Regenerate discards manual edits."
            : "Drag to rearrange, edit any element, then Save. Regenerate discards manual edits."}
        </span>
      </Space>
    </div>
  );
}

export function DiagramSet({ prKey, diagrams }: { prKey: string; diagrams: DiagramSetT }) {
  const sections = useMemo(
    () => SECTION_ORDER.filter((s) => !!diagrams[s]),
    [diagrams]
  );
  const [active, setActive] = useState<DiagramSection | null>(sections[0] ?? null);
  // Whether the currently-shown canvas has unsaved edits; guards section switches.
  const [dirty, setDirty] = useState(false);

  // Keep the active section valid as the set changes (e.g. after a Regenerate).
  useEffect(() => {
    if (!active || !sections.includes(active)) setActive(sections[0] ?? null);
  }, [sections, active]);

  if (!sections.length) return null;
  const current = active && sections.includes(active) ? active : sections[0];
  const doc = diagrams[current];

  // Switching sections remounts the canvas (discarding unsaved edits), so warn first.
  const switchTo = (next: DiagramSection) => {
    if (next === current) return;
    const go = () => {
      setDirty(false);
      setActive(next);
    };
    if (dirty) {
      Modal.confirm({
        title: "Discard unsaved edits?",
        content: `The ${SECTION_LABEL[current]} diagram has changes that haven't been saved.`,
        okText: "Discard",
        okButtonProps: { danger: true },
        cancelText: "Keep editing",
        onOk: go,
      });
      return;
    }
    go();
  };

  return (
    <div style={{ marginBottom: 12 }}>
      {sections.length > 1 && (
        <Segmented
          size="small"
          value={current}
          onChange={(v) => switchTo(v as DiagramSection)}
          options={sections.map((s) => ({ label: SECTION_LABEL[s], value: s }))}
          style={{ marginBottom: 10 }}
        />
      )}
      {doc && (
        // Remount per section so each canvas gets its own Excalidraw instance
        // seeded with that section's document (and resets to read-only).
        <OneCanvas
          key={`${prKey}-${current}`}
          prKey={prKey}
          section={current}
          doc={doc}
          onDirtyChange={setDirty}
        />
      )}
    </div>
  );
}
