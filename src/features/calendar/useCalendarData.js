import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { shouldAutoSyncCalendar } from "@/lib/calendar";

function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}

export function useCalendarData({ date, enabled = true, hasAccounts = true, onError }) {
  const [events, setEvents] = useState([]);
  const [syncRuns, setSyncRuns] = useState([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const load = useCallback(async () => {
    const result = await api.listCalendarEvents({ date });
    setEvents(result.events || []);
    setSyncRuns(result.syncRuns || []);
    return result;
  }, [date]);

  const refresh = useCallback(async () => {
    if (!enabled || !hasAccounts) return load();
    setIsSyncing(true);
    await waitForNextPaint();
    try {
      const result = await api.syncCalendarEvents({ date });
      setEvents(result.events || []);
      setSyncRuns(result.syncRuns || []);
      return result;
    } catch (error) {
      onErrorRef.current?.(error);
      return load();
    } finally {
      setIsSyncing(false);
    }
  }, [date, enabled, hasAccounts, load]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    api.listCalendarEvents({ date })
      .then((result) => {
        if (cancelled) return;
        setEvents(result.events || []);
        setSyncRuns(result.syncRuns || []);
        if (hasAccounts && shouldAutoSyncCalendar(date, result.syncRuns || [])) {
          refresh();
        }
      })
      .catch((error) => !cancelled && onErrorRef.current?.(error));
    return () => { cancelled = true; };
  }, [date, enabled, hasAccounts, refresh]);

  return { events, syncRuns, isSyncing, refresh, reload: load };
}
