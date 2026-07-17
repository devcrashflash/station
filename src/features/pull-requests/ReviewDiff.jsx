import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, Trash2 } from "lucide-react";
import { Highlight } from "prism-react-renderer";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Prism } from "@/lib/prism";
import { diffLanguageForPath, parseDiffLines, selectCommentRange } from "@/lib/reviewDiff";

const LINE_CLASS_NAMES = {
  addition: "bg-emerald-500/10",
  deletion: "bg-red-500/10",
  hunk: "bg-sky-500/10 text-sky-800 dark:text-sky-300",
  metadata: "bg-muted/40 text-muted-foreground",
  "no-newline": "text-muted-foreground italic",
  context: "",
};

const MARKER_CLASS_NAMES = {
  addition: "text-emerald-700 dark:text-emerald-300",
  deletion: "text-red-700 dark:text-red-300",
  hunk: "text-sky-700 dark:text-sky-300",
  metadata: "text-muted-foreground",
  "no-newline": "text-muted-foreground",
  context: "text-muted-foreground",
};

function SyntaxHighlightedCode({ code, language }) {
  if (!code) return null;
  const supportedLanguage = Prism.languages[language] ? language : "plain";
  return (
    <Highlight code={code} language={supportedLanguage}>
      {({ tokens }) => tokens.flatMap((line, lineIndex) => [
        ...(lineIndex > 0 ? ["\n"] : []),
        ...line.map((token, tokenIndex) => (
          <span className={["token", ...token.types].join(" ")} key={`${lineIndex}-${tokenIndex}`}>
            {token.content}
          </span>
        )),
      ])}
    </Highlight>
  );
}

function anchorLine(line, side) {
  return side === "LEFT" ? line.oldLine : line.newLine;
}

function findDraftLineIndex(lines, draft, start) {
  const side = start ? draft.startSide || draft.side : draft.side;
  const target = side === "LEFT"
    ? (start ? draft.startOldLine ?? draft.oldLine : draft.oldLine)
    : (start ? draft.startNewLine ?? draft.newLine : draft.newLine);
  return lines.findIndex((line) => line.commentable && line.side === side && anchorLine(line, side) === target);
}

export function ReviewDiff({
  path,
  oldPath = path,
  newPath = path,
  diff,
  drafts = [],
  headSha,
  disabled = false,
  onSaveDraft,
  onDeleteDraft,
}) {
  const language = diffLanguageForPath(path);
  const lines = useMemo(() => parseDiffLines(diff), [diff]);
  const containerRef = useRef(null);
  const [selection, setSelection] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [keyboardAnchor, setKeyboardAnchor] = useState(null);
  const [drag, setDrag] = useState(null);
  const [body, setBody] = useState("");
  const [editingDraft, setEditingDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  const draftRanges = useMemo(() => drafts.flatMap((draft) => {
    const firstIndex = findDraftLineIndex(lines, draft, true);
    const lastIndex = findDraftLineIndex(lines, draft, false);
    if (firstIndex < 0 || lastIndex < 0) return [];
    return [{ draft, firstIndex: Math.min(firstIndex, lastIndex), lastIndex: Math.max(firstIndex, lastIndex) }];
  }), [drafts, lines]);

  function beginEditor(range, draft = null) {
    setSelection(range);
    setEditorOpen(true);
    setEditingDraft(draft);
    setBody(draft?.body || "");
    setKeyboardAnchor(null);
  }

  function cancelEditor() {
    setSelection(null);
    setEditorOpen(false);
    setEditingDraft(null);
    setBody("");
    setKeyboardAnchor(null);
  }

  function updateDrag(clientX, clientY) {
    const container = containerRef.current;
    if (!container || !drag) return;
    const bounds = container.getBoundingClientRect();
    if (clientY < bounds.top + 36) container.scrollTop -= 18;
    if (clientY > bounds.bottom - 36) container.scrollTop += 18;
    const target = document.elementFromPoint(clientX, clientY)?.closest?.("[data-comment-line-index]");
    const targetIndex = Number(target?.dataset.commentLineIndex);
    if (Number.isInteger(targetIndex)) {
      const range = selectCommentRange(lines, drag.startIndex, targetIndex);
      if (range) setSelection(range);
    }
    setDrag((current) => current ? { ...current, clientX, clientY } : null);
  }

  function handlePointerDown(event, index) {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    const range = selectCommentRange(lines, index, index);
    setSelection(range);
    setEditorOpen(false);
    setEditingDraft(null);
    setBody("");
    setDrag({ startIndex: index, startX: event.clientX, startY: event.clientY, clientX: event.clientX, clientY: event.clientY });
    containerRef.current?.setPointerCapture?.(event.pointerId);
  }

  function handlePointerUp() {
    if (!drag) return;
    setDrag(null);
    if (selection) beginEditor(selection);
  }

  function handleLineKeyDown(event, index) {
    if (disabled) return;
    if (event.key === "Escape") {
      cancelEditor();
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      setKeyboardAnchor(index);
      setSelection(selectCommentRange(lines, index, index));
      setEditorOpen(false);
      return;
    }
    if (event.shiftKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const anchor = keyboardAnchor ?? index;
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const edge = direction < 0 ? selection?.firstIndex ?? index : selection?.lastIndex ?? index;
      const range = selectCommentRange(lines, anchor, edge + direction);
      if (range) setSelection(range);
      setEditorOpen(false);
      setKeyboardAnchor(anchor);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      beginEditor(selection || selectCommentRange(lines, index, index));
    }
  }

  async function saveDraft() {
    if (!selection || !body.trim() || !onSaveDraft || saving) return;
    setSaving(true);
    try {
      await onSaveDraft({
        id: editingDraft?.id,
        kind: "inline",
        body,
        path,
        oldPath,
        newPath,
        startOldLine: selection.start.oldLine,
        startNewLine: selection.start.newLine,
        startSide: selection.start.side,
        oldLine: selection.end.oldLine,
        newLine: selection.end.newLine,
        side: selection.end.side,
        headSha,
      });
      cancelEditor();
    } catch {
      // The overlay displays storage/provider errors while preserving the editor.
    } finally {
      setSaving(false);
    }
  }

  const rectangle = drag ? {
    left: Math.min(drag.startX, drag.clientX),
    top: Math.min(drag.startY, drag.clientY),
    width: Math.max(2, Math.abs(drag.clientX - drag.startX)),
    height: Math.max(2, Math.abs(drag.clientY - drag.startY)),
  } : null;

  return (
    <div
      ref={containerRef}
      className="review-diff relative h-full overflow-auto rounded-md border bg-muted/20 font-mono text-xs leading-relaxed"
      aria-label="Diff. Drag across lines with the crosshair to add a review comment."
      onPointerMove={(event) => updateDrag(event.clientX, event.clientY)}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { setDrag(null); setSelection(null); setEditorOpen(false); }}
      onPointerLeave={(event) => drag && updateDrag(event.clientX, event.clientY)}
    >
      {rectangle && createPortal(
        <div className="pointer-events-none fixed z-[100] border border-blue-500 bg-blue-500/10" style={rectangle} />,
        document.body,
      )}
      {lines.map((line) => {
        const selected = selection && line.index >= selection.firstIndex && line.index <= selection.lastIndex;
        const selectionStart = selected && line.index === selection.firstIndex;
        const selectionEnd = selected && line.index === selection.lastIndex;
        const drafted = draftRanges.some((range) => line.index >= range.firstIndex && line.index <= range.lastIndex);
        const cards = draftRanges.filter((range) => range.lastIndex === line.index);
        const showEditor = editorOpen && selection?.lastIndex === line.index;
        const highlightCode = ["addition", "deletion", "context"].includes(line.type);
        return (
          <div key={line.index}>
            <div
              className={`review-diff-line ${LINE_CLASS_NAMES[line.type]} ${line.commentable ? "cursor-crosshair select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500" : ""} ${selected ? `review-diff-line-selected bg-blue-500/15 ${selectionStart ? "review-diff-line-selection-start" : ""} ${selectionEnd ? "review-diff-line-selection-end" : ""}` : drafted ? "bg-amber-500/15" : ""}`}
              data-diff-line-type={line.type}
              data-comment-line-index={line.commentable ? line.index : undefined}
              tabIndex={line.commentable ? 0 : undefined}
              onPointerDown={line.commentable ? (event) => handlePointerDown(event, line.index) : undefined}
              onKeyDown={line.commentable ? (event) => handleLineKeyDown(event, line.index) : undefined}
            >
              <span className="review-diff-line-number">{line.oldLine || ""}</span>
              <span className="review-diff-line-number">{line.newLine || ""}</span>
              <span aria-hidden="true" className={`review-diff-marker ${MARKER_CLASS_NAMES[line.type]}`}>{line.marker}</span>
              <span className="review-diff-content whitespace-pre-wrap">
                {highlightCode ? <SyntaxHighlightedCode code={line.content} language={language} /> : line.content}
              </span>
            </div>
            {cards.filter(({ draft }) => !editorOpen || editingDraft?.id !== draft.id).map(({ draft, firstIndex, lastIndex }) => (
              <div key={draft.id} className="mx-10 my-2 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
                <div className="min-w-0 flex-1 font-sans text-sm">
                  <p className="mb-1 text-xs opacity-70">Lines {lines[firstIndex]?.oldLine || lines[firstIndex]?.newLine}–{lines[lastIndex]?.oldLine || lines[lastIndex]?.newLine}</p>
                  <p className="whitespace-pre-wrap">{draft.body}</p>
                  {draft.lastError && <p className="mt-1 text-xs text-destructive">{draft.lastError}</p>}
                </div>
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => beginEditor(selectCommentRange(lines, firstIndex, lastIndex), draft)}><Pencil /></Button>
                <Button type="button" variant="ghost" size="icon-xs" disabled={disabled} onClick={() => onDeleteDraft?.(draft.id)}><Trash2 /></Button>
              </div>
            ))}
            {showEditor && (
              <div className="mx-10 my-2 grid gap-2 rounded-md border border-blue-300 bg-background p-3 font-sans">
                <p className="text-xs text-muted-foreground">Comment on {selection.lines.length} line{selection.lines.length === 1 ? "" : "s"}</p>
                <Textarea autoFocus className="min-h-20" value={body} placeholder="Draft a review comment…" disabled={disabled || saving} onChange={(event) => setBody(event.target.value)} />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={cancelEditor}>Cancel</Button>
                  <Button type="button" size="sm" disabled={!body.trim() || saving} onClick={saveDraft}>{saving ? "Saving…" : "Save draft"}</Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
