import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";

import { api } from "@/lib/api";
import {
  AI_SESSION_MAX_WINDOW_HOURS,
  aiSessionPollingIntervalMs,
  aiSessionsWaitingForInput,
  normalizeAiSessionSettings,
} from "@/lib/aiSessions";
import {
  AI_SESSION_WAITING_STATUS_EVENT,
  AI_SESSION_WAITING_STATUS_REQUEST_EVENT,
} from "@/lib/aiSessionEvents";
import { isDesktopApp } from "@/lib/ocr";

const EMPTY_RESULT = {
  sessions: [],
  archivedSessions: [],
  warnings: [],
  loadedAt: Date.now(),
  lastRefreshedAt: null,
};

export function useAiSessionMonitor({
  settings,
  settingsReady,
  foreground,
  onNotice,
}) {
  const normalizedSettings = useMemo(
    () => normalizeAiSessionSettings(settings),
    [settings],
  );
  const [result, setResult] = useState(EMPTY_RESULT);
  const [loading, setLoading] = useState(false);
  const activeRun = useRef(0);
  const started = useRef(false);
  const waitingRef = useRef(false);
  const hasWaitingAiSession = useMemo(
    () => aiSessionsWaitingForInput(result.sessions),
    [result.sessions],
  );
  waitingRef.current = hasWaitingAiSession;

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!settingsReady) return null;
    const run = activeRun.current + 1;
    const requestedAt = Date.now();
    activeRun.current = run;
    if (!quiet) setLoading(true);
    try {
      const next = await api.listAiSessions({
        since: requestedAt - AI_SESSION_MAX_WINDOW_HOURS * 3_600_000,
        settings: normalizedSettings,
      });
      if (activeRun.current !== run) return null;
      const loadedAt = Date.now();
      const nextResult = { ...next, loadedAt, lastRefreshedAt: loadedAt };
      setResult(nextResult);
      return nextResult;
    } catch (error) {
      if (activeRun.current === run && !quiet) {
        onNotice(error?.message || String(error));
      }
      return null;
    } finally {
      if (activeRun.current === run) setLoading(false);
    }
  }, [normalizedSettings, onNotice, settingsReady]);

  useEffect(() => {
    if (!settingsReady) return undefined;
    const quiet = started.current;
    started.current = true;
    refresh({ quiet });
    const interval = window.setInterval(
      () => refresh({ quiet: true }),
      aiSessionPollingIntervalMs(normalizedSettings, foreground),
    );
    return () => window.clearInterval(interval);
  }, [foreground, normalizedSettings, refresh, settingsReady]);

  useEffect(() => {
    if (!isDesktopApp() || result.lastRefreshedAt === null) return;
    emit(AI_SESSION_WAITING_STATUS_EVENT, {
      waitingForInput: hasWaitingAiSession,
    }).catch(console.error);
  }, [hasWaitingAiSession, result.lastRefreshedAt]);

  useEffect(() => {
    if (!isDesktopApp()) return undefined;
    let active = true;
    let unlisten = null;
    listen(AI_SESSION_WAITING_STATUS_REQUEST_EVENT, () => {
      emit(AI_SESSION_WAITING_STATUS_EVENT, {
        waitingForInput: waitingRef.current,
      }).catch(console.error);
    }).then((cleanup) => {
      if (active) unlisten = cleanup;
      else cleanup();
    }).catch(console.error);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return {
    result,
    loading,
    refresh,
    hasWaitingAiSession,
  };
}
