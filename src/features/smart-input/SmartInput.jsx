import { useEffect, useRef, useState } from "react";
import { Link2, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { providerLabels } from "@/lib/domain";
import { isDesktopApp, oneFileDropErrorMessage, selectDesktopDropPath } from "@/lib/ocr";
import { parseSmartInput } from "@/lib/smartInputParser";
import { cn } from "@/lib/utils";

const NON_FILE_DROP_MESSAGE = "The dropped data was not a file. Only local files are supported.";
const DUPLICATE_DROP_WINDOW_MS = 1500;

export function SmartInput({ onSubmit, onFileDrop, large = false }) {
  const [value, setValue] = useState("");
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [dropError, setDropError] = useState(null);
  const desktopDragPathsRef = useRef([]);
  const lastFileDropRef = useRef({ key: "", at: 0 });
  const parsed = parseSmartInput(value);
  const canSubmit = value.trim().length > 0;

  useEffect(() => {
    if (!isDesktopApp() || !onFileDrop) return undefined;

    let active = true;
    let cleanup = null;

    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter") {
            desktopDragPathsRef.current = Array.isArray(payload.paths) ? payload.paths : [];
            setIsDraggingFile(true);
            return;
          }
          if (payload.type === "over") {
            setIsDraggingFile(true);
            return;
          }
          if (payload.type === "leave") {
            desktopDragPathsRef.current = [];
            setIsDraggingFile(false);
            return;
          }
          if (payload.type !== "drop") return;

          setIsDraggingFile(false);
          const dropPaths = Array.isArray(payload.paths) ? payload.paths : [];
          const paths = dropPaths.length > 0 ? dropPaths : desktopDragPathsRef.current;
          desktopDragPathsRef.current = [];
          const path = selectDesktopDropPath(paths);
          if (!path) {
            setDropError(paths.length > 0 ? oneFileDropErrorMessage(paths) : NON_FILE_DROP_MESSAGE);
            return;
          }

          void handleFileDrop({
            path,
            name: fileNameFromPath(path),
            mimeType: "",
          });
        }))
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        cleanup = unlisten;
      })
      .catch((error) => {
        setDropError(error?.message || String(error));
      });

    return () => {
      active = false;
      cleanup?.();
    };
  }, [onFileDrop]);

  useEffect(() => {
    if (!onFileDrop || isDesktopApp()) return undefined;

    function handleDocumentDrag(event) {
      if (!hasDropData(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setIsDraggingFile(true);
    }

    function handleDocumentDrop(event) {
      if (!hasDropData(event)) return;
      event.preventDefault();
      event.stopPropagation();
      void handleBrowserDrop(event);
    }

    document.addEventListener("dragenter", handleDocumentDrag, true);
    document.addEventListener("dragover", handleDocumentDrag, true);
    document.addEventListener("drop", handleDocumentDrop, true);

    return () => {
      document.removeEventListener("dragenter", handleDocumentDrag, true);
      document.removeEventListener("dragover", handleDocumentDrag, true);
      document.removeEventListener("drop", handleDocumentDrop, true);
    };
  }, [onFileDrop]);

  async function submit(event) {
    event.preventDefault();
    if (!canSubmit) return;
    setDropError(null);
    await onSubmit(value);
    setValue("");
  }

  function handleKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey) return;

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function handleFileDrop(fileDrop) {
    const dropKey = fileDropKey(fileDrop);
    const timestamp = Date.now();
    if (
      dropKey &&
      lastFileDropRef.current.key === dropKey &&
      timestamp - lastFileDropRef.current.at < DUPLICATE_DROP_WINDOW_MS
    ) {
      return;
    }

    lastFileDropRef.current = { key: dropKey, at: timestamp };
    setDropError(null);
    const result = await onFileDrop?.(fileDrop);
    if (typeof result === "string" && result.trim()) {
      setDropError(result);
    }
  }

  function handleDragOver(event) {
    if (!hasDropData(event)) return;
    event.preventDefault();
    setIsDraggingFile(true);
  }

  function handleDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setIsDraggingFile(false);
    }
  }

  async function handleDrop(event) {
    if (!hasDropData(event)) return;
    event.preventDefault();
    event.stopPropagation();
    await handleBrowserDrop(event);
  }

  async function handleBrowserDrop(event) {
    setIsDraggingFile(false);

    const files = Array.from(event.dataTransfer.files || []);
    if (files.length === 0) {
      const appleMailDrop = appleMailDropFromDataTransfer(event.dataTransfer);
      if (appleMailDrop) {
        setDropError(NON_FILE_DROP_MESSAGE);
        return;
      }
    }

    if (files.length !== 1) {
      setDropError(files.length > 0 ? oneFileDropErrorMessage(files) : NON_FILE_DROP_MESSAGE);
      return;
    }

    const file = files[0];
    await handleFileDrop({
      file,
      name: file.name,
      mimeType: file.type,
    });
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={submit}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Textarea
        className={cn(
          "min-h-28 resize-none rounded-lg bg-card px-4 py-3 text-base shadow-sm",
          large && "min-h-40 text-lg",
          isDraggingFile && "border-primary ring-2 ring-primary/25",
        )}
        value={value}
        placeholder="Write a task, paste a Trello link, or capture work to route later..."
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      {dropError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          <p className="break-words whitespace-pre-wrap">{dropError}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ParsedBadge parsed={parsed} />
        <Button type="submit" disabled={!canSubmit}>
          <Plus />
          Add
        </Button>
      </div>
    </form>
  );
}

function hasDropData(event) {
  return Boolean(event.dataTransfer);
}

function fileNameFromPath(path) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function fileDropKey(fileDrop) {
  if (fileDrop?.messageUri) return `message:${fileDrop.messageUri}`;
  if (fileDrop?.path) return `path:${fileDrop.path}`;
  if (fileDrop?.file) {
    return [
      "file",
      fileDrop.file.name,
      fileDrop.file.type,
      fileDrop.file.size,
      fileDrop.file.lastModified,
    ].join(":");
  }
  return ["drop", fileDrop?.name, fileDrop?.mimeType].filter(Boolean).join(":");
}

function safeDataTransferValue(dataTransfer, type) {
  try {
    return dataTransfer?.getData(type) || "";
  } catch (error) {
    return `<error: ${error?.message || String(error)}>`;
  }
}

function appleMailDropFromDataTransfer(dataTransfer) {
  const uri = safeDataTransferValue(dataTransfer, "text/uri-list")
    || firstLine(safeDataTransferValue(dataTransfer, "text/x-moz-url"));
  if (!uri.trim().startsWith("message:")) return null;

  const subject = safeDataTransferValue(dataTransfer, "text/plain")
    || safeDataTransferValue(dataTransfer, "text/x-moz-url").split(/\r?\n/).at(1)
    || "Apple Mail message";
  return {
    messageUri: uri.trim(),
    name: subject.trim() || "Apple Mail message",
    mimeType: "message/rfc822",
  };
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).at(0) || "";
}

export function ParsedBadge({ parsed }) {
  const label =
    parsed.kind === "text"
      ? "Plain task"
      : `${providerLabels[parsed.provider] || "Link"} · ${parsed.kind.replaceAll("_", " ")}`;

  return (
    <Badge variant="secondary" className="gap-2">
      <Link2 className="size-3.5" />
      {label}
    </Badge>
  );
}
