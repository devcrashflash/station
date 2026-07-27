import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CheckCircle2, LoaderCircle, Plus, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { quickCaptureTitle } from "@/lib/quickCapture";

export function QuickCapture() {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const inputRef = useRef(null);
  const canSubmit = value.trim().length > 0 && !isSaving;

  useEffect(() => {
    const currentWindow = getCurrentWindow();
    let active = true;
    const unlisteners = [];

    function handleFocusChanged(focused) {
      if (focused) {
        const focusInput = () => inputRef.current?.focus({ preventScroll: true });
        window.requestAnimationFrame(focusInput);
        window.setTimeout(focusInput, 50);
      } else {
        setError("");
      }
    }

    currentWindow.onFocusChanged(({ payload: focused }) => {
      handleFocusChanged(focused);
    }).then((cleanup) => {
      if (!active) {
        cleanup();
      } else {
        unlisteners.push(cleanup);
      }
    }).catch((focusError) => {
      if (active) setError(focusError?.message || String(focusError));
    });

    currentWindow.listen("quick-capture-focus-changed", ({ payload: focused }) => {
      handleFocusChanged(Boolean(focused));
    }).then((cleanup) => {
      if (!active) {
        cleanup();
      } else {
        unlisteners.push(cleanup);
      }
    }).catch((focusError) => {
      if (active) setError(focusError?.message || String(focusError));
    });

    inputRef.current?.focus();
    return () => {
      active = false;
      unlisteners.forEach((cleanup) => cleanup());
    };
  }, []);

  useEffect(() => {
    function handleWindowKeyDown(event) {
      if (event.key !== "Escape") return;

      event.preventDefault();
      api.hideQuickCapture({ restoreFocus: true }).catch((hideError) => {
        setError(hideError?.message || String(hideError));
      });
    }

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, []);

  async function hide(restoreFocus = false) {
    await api.hideQuickCapture({ restoreFocus });
  }

  async function submit(event) {
    event.preventDefault();
    if (!canSubmit) return;

    setError("");
    setIsSaving(true);
    try {
      await api.createSmartInboxTodo({
        kind: "text",
        title: quickCaptureTitle(value),
        rawText: value,
        filePath: null,
        fileName: null,
        mimeType: null,
      });
      await emit("smart-inbox-updated").catch((emitError) => {
        console.error("Could not notify the main window about quick capture", emitError);
      });
      setValue("");
      setIsSaved(true);
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      await hide(true);
    } catch (submitError) {
      setError(submitError?.message || String(submitError));
    } finally {
      setIsSaved(false);
      setIsSaving(false);
    }
  }

  function handleKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey) return;

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <main className="flex h-screen items-center overflow-hidden bg-transparent px-6 py-3 text-foreground">
      <form
        className="grid w-full overflow-hidden rounded-2xl border border-border/80 bg-background/95 shadow-[0_3px_10px_-4px_rgba(0,0,0,0.32),0_10px_28px_-14px_rgba(0,0,0,0.28)] backdrop-blur-xl"
        onSubmit={submit}
      >
        <div className="flex min-h-24 items-start gap-3 px-4 py-3">
          {isSaved ? (
            <div className="flex min-h-16 flex-1 animate-in items-center justify-center gap-2 text-sm font-medium text-foreground fade-in-0 zoom-in-95 duration-200">
              <CheckCircle2 className="size-5 animate-in text-emerald-600 zoom-in-50 duration-200" aria-hidden="true" />
              Captured to Smart Inbox
            </div>
          ) : (
            <>
              <Sparkles className="mt-2 size-5 shrink-0 text-primary" aria-hidden="true" />
              <Textarea
                ref={inputRef}
                className="max-h-24 min-h-16 resize-none border-0 bg-transparent p-2 text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
                value={value}
                placeholder="Capture something for your Smart Inbox..."
                aria-label="Quick capture"
                disabled={isSaving}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={handleKeyDown}
              />
              <Button className="mt-1" type="submit" size="icon" disabled={!canSubmit} aria-label="Add to Smart Inbox">
                {isSaving ? <LoaderCircle className="animate-spin" /> : <Plus />}
              </Button>
            </>
          )}
        </div>
        <div className="flex min-h-8 items-center justify-between border-t border-border/60 px-4 text-xs text-muted-foreground">
          {error ? <p className="truncate text-destructive" role="alert">{error}</p> : <span>Shift+Enter for a new line</span>}
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd>Esc</Kbd> close
            <Kbd>↵</Kbd> save
          </span>
        </div>
      </form>
    </main>
  );
}
