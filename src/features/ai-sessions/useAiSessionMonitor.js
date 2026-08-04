import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { api } from "@/lib/api";
import {
  AI_SESSION_MAX_WINDOW_HOURS,
  aiSessionPollingIntervalMs,
  aiSessionsWaitingForInputCount,
  normalizeAiSessionSettings,
} from "@/lib/aiSessions";
import {
  AI_SESSION_MONITOR_UPDATED_EVENT,
  newerAiSessionSnapshot,
  normalizeAiSessionSnapshot,
} from "@/lib/aiSessionEvents";
import { isDesktopApp } from "@/lib/ocr";

const EMPTY_RESULT = {
  sessions: [],
  archivedSessions: [],
  warnings: [],
  loadedAt: Date.now(),
  lastRefreshedAt: null,
  waitingSessionCount: 0,
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
  const waitingAiSessionCount = useMemo(
    () => Number.isFinite(Number(result.waitingSessionCount))
      ? Number(result.waitingSessionCount)
      : aiSessionsWaitingForInputCount(result.sessions),
    [result.sessions, result.waitingSessionCount],
  );
  const hasWaitingAiSession = waitingAiSessionCount > 0;

  const applyResult = useCallback((next) => {
    const normalized = normalizeAiSessionSnapshot(next);
    setResult((current) => newerAiSessionSnapshot(current, normalized));
    return normalized;
  }, []);

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
      return applyResult(next);
    } catch (error) {
      if (activeRun.current === run && !quiet) {
        onNotice(error?.message || String(error));
      }
      return null;
    } finally {
      if (activeRun.current === run) setLoading(false);
    }
  }, [applyResult, normalizedSettings, onNotice, settingsReady]);

  useEffect(() => {
    if (!settingsReady) return undefined;
    if (isDesktopApp()) return undefined;
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
    if (!settingsReady || !isDesktopApp()) return undefined;
    let disposed = false;
    let unlisten = null;
    listen(AI_SESSION_MONITOR_UPDATED_EVENT, ({ payload }) => {
      if (!disposed) applyResult(payload);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else {
        unlisten = cleanup;
        api.latestAiSessions().then((next) => {
          if (!disposed) applyResult(next);
        }).catch((error) => {
          if (!disposed) onNotice(error?.message || String(error));
        });
      }
    }).catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyResult, onNotice, settingsReady]);

  useEffect(() => {
    if (!settingsReady || !isDesktopApp()) return;
    api.setAiSessionMonitorViewActive({ active: foreground }).catch(console.error);
    return () => {
      api.setAiSessionMonitorViewActive({ active: false }).catch(console.error);
    };
  }, [foreground, settingsReady]);

  return {
    result,
    loading,
    refresh,
    hasWaitingAiSession,
  };
}
