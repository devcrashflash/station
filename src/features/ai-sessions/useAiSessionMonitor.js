import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { api } from "@/lib/api";
import {
  AI_SESSION_MAX_WINDOW_HOURS,
  aiSessionPollingIntervalMs,
  normalizeAiSessionSettings,
} from "@/lib/aiSessions";
import {
  AI_SESSION_MONITOR_UPDATED_EVENT,
  aiSessionRevisionFromPayload,
  newerAiSessionSnapshot,
  normalizeAiSessionSnapshot,
} from "@/lib/aiSessionEvents";
import { isDesktopApp } from "@/lib/ocr";

const EMPTY_RESULT = {
  sessions: [],
  archivedSessions: [],
  warnings: [],
  revision: "",
  loadedAt: Date.now(),
  lastRefreshedAt: null,
  waitingSessionCount: 0,
  waitingTerminalTabIds: [],
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
  const [waitingAiSessionCount, setWaitingAiSessionCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const activeRun = useRef(0);
  const resultRevision = useRef("");
  const started = useRef(false);
  const hasWaitingAiSession = waitingAiSessionCount > 0;

  const applyResult = useCallback((next) => {
    const normalized = normalizeAiSessionSnapshot(next);
    setResult((current) => {
      const selected = newerAiSessionSnapshot(current, normalized);
      resultRevision.current = selected.revision;
      return selected;
    });
    setWaitingAiSessionCount((current) => (
      current === normalized.waitingSessionCount ? current : normalized.waitingSessionCount
    ));
    return normalized;
  }, []);

  const applyStatus = useCallback((next) => {
    const count = Number(next?.waitingSessionCount);
    if (Number.isFinite(count)) {
      const normalized = Math.max(0, count);
      setWaitingAiSessionCount((current) => (current === normalized ? current : normalized));
    }
    const refreshedAt = Number(next?.lastRefreshedAt);
    const revision = aiSessionRevisionFromPayload(next);
    if (!Number.isFinite(refreshedAt) || refreshedAt <= 0 || !revision) return;
    setResult((current) => revision === current.revision ? {
      ...current,
      loadedAt: refreshedAt,
      lastRefreshedAt: refreshedAt,
    } : current);
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
    let disposed = false;
    let timeoutId = null;
    const firstQuiet = started.current;
    started.current = true;
    async function poll(quiet) {
      await refresh({ quiet });
      if (!disposed) {
        timeoutId = window.setTimeout(
          () => poll(true),
          aiSessionPollingIntervalMs(normalizedSettings, foreground),
        );
      }
    }
    void poll(firstQuiet);
    return () => {
      disposed = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [foreground, normalizedSettings, refresh, settingsReady]);

  useEffect(() => {
    if (!settingsReady || !isDesktopApp()) return undefined;
    let disposed = false;
    let unlisten = null;
    let requestedRevision = "";
    listen(AI_SESSION_MONITOR_UPDATED_EVENT, ({ payload }) => {
      if (disposed) return;
      applyStatus(payload);
      const revision = aiSessionRevisionFromPayload(payload);
      if (!foreground || !revision || revision === resultRevision.current || revision === requestedRevision) {
        return;
      }
      requestedRevision = revision;
      api.latestAiSessions().then((next) => {
        if (!disposed) applyResult(next);
      }).catch((error) => {
        if (!disposed) onNotice(error?.message || String(error));
      }).finally(() => {
        if (requestedRevision === revision) requestedRevision = "";
      });
    }).then((cleanup) => {
      if (disposed) cleanup();
      else {
        unlisten = cleanup;
        api.latestAiSessionStatus().then((next) => {
          if (!disposed) applyStatus(next);
        }).catch((error) => {
          if (!disposed) onNotice(error?.message || String(error));
        });
      }
    }).catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyResult, applyStatus, foreground, onNotice, settingsReady]);

  useEffect(() => {
    if (!settingsReady || !foreground || !isDesktopApp()) return undefined;
    let disposed = false;
    setLoading(true);
    api.latestAiSessions().then((next) => {
      if (!disposed) applyResult(next);
    }).catch((error) => {
      if (!disposed) onNotice(error?.message || String(error));
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [applyResult, foreground, onNotice, settingsReady]);

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
