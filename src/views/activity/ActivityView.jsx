import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ListFilter,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Panel } from "@/components/common/Panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import {
  activityActionClassName,
  activityActionLabel,
  activityEventKindLabel,
  activityProviderLabel,
  addDays,
  formatLocalDate,
  isTrelloAutomationActivity,
  parseLocalDate,
  shouldAutoSyncActivity,
  sortActivities,
  syncWarningMessages,
} from "@/lib/activity";
import { cn } from "@/lib/utils";

function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}

export function ActivityView({
  date,
  activities,
  syncRuns,
  isSyncing,
  onDateChange,
  onRefresh,
}) {
  const today = formatLocalDate();
  const connectionFilters = useMemo(
    () => activityConnectionFilters(activities, syncRuns),
    [activities, syncRuns],
  );
  const [disabledConnectionKeys, setDisabledConnectionKeys] = useState(() => new Set());
  const manualActivities = useMemo(
    () => (activities || []).filter((activity) => !isTrelloAutomationActivity(activity)),
    [activities],
  );
  const sortedActivities = sortActivities(manualActivities);
  const filteredActivities = sortedActivities.filter(
    (activity) => !disabledConnectionKeys.has(activityConnectionKey(activity)),
  );
  const selectedWeekdayLabel = useMemo(
    () => new Intl.DateTimeFormat(undefined, {
      weekday: "long",
    }).format(parseLocalDate(date)),
    [date],
  );
  const warnings = syncWarningMessages(syncRuns);
  const activityCountText = filteredActivities.length === sortedActivities.length
    ? `${sortedActivities.length} activities`
    : `${filteredActivities.length} of ${sortedActivities.length} activities`;

  useEffect(() => {
    const knownKeys = new Set(connectionFilters.map((connection) => connection.key));
    setDisabledConnectionKeys((current) => {
      const next = new Set([...current].filter((key) => knownKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [connectionFilters]);

  const toggleConnection = useCallback((key, enabled) => {
    setDisabledConnectionKeys((current) => {
      const next = new Set(current);
      if (enabled) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  return (
    <div className="grid flex-1 gap-6 overflow-y-auto p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="flex min-w-0 flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-2xl font-semibold">{selectedWeekdayLabel}</h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="icon"
              variant="outline"
              title="Previous day"
              onClick={() => onDateChange(addDays(date, -1))}
            >
              <ChevronLeft />
            </Button>
            <div className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5">
              <CalendarDays className="size-4 text-muted-foreground" />
              <Input
                className="h-8 w-[9.5rem] border-0 p-0 shadow-none focus-visible:ring-0"
                type="date"
                value={date}
                onChange={(event) => onDateChange(event.target.value || today)}
              />
            </div>
            <Button
              type="button"
              size="icon"
              variant="outline"
              title="Next day"
              onClick={() => onDateChange(addDays(date, 1))}
            >
              <ChevronRight />
            </Button>
            <Button type="button" variant="outline" onClick={() => onDateChange(today)}>
              Today
            </Button>
            <Button
              type="button"
              variant="outline"
              aria-busy={isSyncing}
              disabled={isSyncing}
              onClick={onRefresh}
            >
              {isSyncing ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {isSyncing ? "Syncing..." : "Sync"}
            </Button>
          </div>
        </div>

        {warnings.length > 0 && (
          <div className="grid min-w-0 gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            {warnings.map((warning) => (
              <p key={warning} className="min-w-0 break-words text-sm text-destructive [overflow-wrap:anywhere]">
                {warning}
              </p>
            ))}
          </div>
        )}

        <Panel title="Timeline" icon={Activity}>
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium">{activityCountText}</p>
              <SyncSummary syncRuns={syncRuns} isSyncing={isSyncing} />
            </div>

            {filteredActivities.length === 0 ? (
              <EmptyState
                text={
                  sortedActivities.length > 0
                    ? "No activity matches the selected filters."
                    : (activities || []).length > 0
                      ? "No manual activity cached for this day."
                    : isSyncing
                      ? "Syncing activity..."
                      : "No activity cached for this day."
                }
              />
            ) : (
              <div className="flex flex-col gap-2">
                {filteredActivities.map((activity) => (
                  <ActivityItem key={activity.id} activity={activity} />
                ))}
              </div>
            )}
          </div>
        </Panel>
      </section>

      <aside className="min-w-0">
        <Panel title="Filters" icon={ListFilter}>
          <ActivityFilters
            connections={connectionFilters}
            disabledConnectionKeys={disabledConnectionKeys}
            onReset={() => setDisabledConnectionKeys(new Set())}
            onToggle={toggleConnection}
          />
        </Panel>
      </aside>
    </div>
  );
}

export function useActivityData({ date, enabled = true, onError }) {
  const [activities, setActivities] = useState([]);
  const [syncRuns, setSyncRuns] = useState([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const loadCached = useCallback(async () => {
    const result = await api.listActivities({ date });
    setActivities(result.activities || []);
    setSyncRuns(result.syncRuns || []);
    return result;
  }, [date]);

  const sync = useCallback(async () => {
    if (!enabled) {
      return { activities, syncRuns };
    }
    setIsSyncing(true);
    await waitForNextPaint();
    try {
      const result = await api.syncActivities({ date });
      setActivities(result.activities || []);
      setSyncRuns(result.syncRuns || []);
      return result;
    } catch (error) {
      onErrorRef.current?.(error);
      return loadCached();
    } finally {
      setIsSyncing(false);
    }
  }, [activities, date, enabled, loadCached, syncRuns]);

  useEffect(() => {
    if (!enabled) {
      setIsSyncing(false);
      return undefined;
    }
    let cancelled = false;
    let syncTimer = null;
    setIsSyncing(false);

    api.listActivities({ date })
      .then((result) => {
        if (cancelled) return;
        setActivities(result.activities || []);
        setSyncRuns(result.syncRuns || []);
        if (!shouldAutoSyncActivity(date, result.syncRuns || [])) {
          return;
        }

        syncTimer = window.setTimeout(() => {
          if (cancelled) return;
          setIsSyncing(true);
          api.syncActivities({ date })
            .then((syncResult) => {
              if (cancelled) return;
              setActivities(syncResult.activities || []);
              setSyncRuns(syncResult.syncRuns || []);
            })
            .catch((error) => {
              if (!cancelled) onErrorRef.current?.(error);
            })
            .finally(() => {
              if (!cancelled) setIsSyncing(false);
            });
        }, 250);
      })
      .catch((error) => {
        if (!cancelled) onErrorRef.current?.(error);
      });

    return () => {
      cancelled = true;
      if (syncTimer) {
        window.clearTimeout(syncTimer);
      }
    };
  }, [date, enabled]);

  return {
    activities,
    syncRuns,
    isSyncing,
    refresh: sync,
  };
}

function SyncSummary({ syncRuns, isSyncing }) {
  const latest = Math.max(0, ...(syncRuns || []).map((run) => run.syncedAt || 0));
  const lastSyncText = latest
    ? `Last sync ${new Date(latest).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "Last sync: never";

  if (isSyncing) {
    return <span className="text-xs text-muted-foreground">Syncing remote activity · {lastSyncText}</span>;
  }

  if (!syncRuns?.length) {
    return <span className="text-xs text-muted-foreground">{lastSyncText}</span>;
  }

  const failedCount = syncRuns.filter((run) => run.status === "failed").length;
  if (failedCount > 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {lastSyncText} · {failedCount} connection sync warning
      </span>
    );
  }

  return <span className="text-xs text-muted-foreground">{lastSyncText}</span>;
}

function ActivityFilters({ connections, disabledConnectionKeys, onReset, onToggle }) {
  const disabledCount = disabledConnectionKeys.size;

  if (!connections.length) {
    return <EmptyState text="No synced activity connections yet." />;
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Connections</p>
          <p className="text-xs text-muted-foreground">
            {connections.length} source{connections.length === 1 ? "" : "s"}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabledCount === 0}
          onClick={onReset}
        >
          Reset
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {connections.map((connection) => {
          const enabled = !disabledConnectionKeys.has(connection.key);

          return (
            <label
              key={connection.key}
              className="flex min-w-0 cursor-pointer items-start gap-3 rounded-md border bg-card p-3 text-card-foreground transition-colors hover:bg-muted/35"
            >
              <Checkbox
                className="mt-0.5"
                checked={enabled}
                onCheckedChange={(checked) => onToggle(connection.key, checked === true)}
                aria-label={`${enabled ? "Disable" : "Enable"} ${connection.label}`}
              />
              <span className="min-w-0">
                <span className="block min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">
                  {connection.label}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {activityProviderLabel(connection.provider)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ActivityItem({ activity }) {
  const occurred = activity.occurredAt ? new Date(activity.occurredAt) : null;
  const actionLabel = activityActionLabel(activity);
  const kindLabel = activityEventKindLabel(activity);
  const Wrapper = activity.targetUrl ? "a" : "div";

  return (
    <Wrapper
      className={cn(
        "grid min-w-0 grid-cols-[4rem_minmax(0,1fr)_auto] gap-3 overflow-hidden rounded-md border bg-card p-3 text-card-foreground",
        activity.targetUrl && "cursor-pointer transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
      href={activity.targetUrl || undefined}
      target={activity.targetUrl ? "_blank" : undefined}
      rel={activity.targetUrl ? "noreferrer" : undefined}
      title={activity.targetUrl ? "Open activity" : undefined}
    >
      <div className="w-16 shrink-0 text-xs text-muted-foreground">
        {occurred ? occurred.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
      </div>
      <div className="min-w-0 overflow-hidden">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge className="max-w-full shrink-0" variant="secondary">
            {activityProviderLabel(activity.provider)}
          </Badge>
          <Badge className={activityActionClassName(actionLabel)} variant="outline">
            {actionLabel}
          </Badge>
          <Badge className="max-w-full border-border bg-background text-muted-foreground" variant="outline">
            {kindLabel}
          </Badge>
          {activity.actor && (
            <span className="min-w-0 max-w-full break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
              by {activity.actor}
            </span>
          )}
        </div>
        <p className="mt-1 min-w-0 break-words text-sm leading-5 [overflow-wrap:anywhere]">
          {activity.title || activity.externalId}
        </p>
        <p className="mt-1 min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {activity.connectionName || activity.connectionId}
        </p>
      </div>
      {activity.targetUrl && (
        <span
          className="shrink-0 text-blue-700 hover:text-blue-800"
          aria-hidden="true"
        >
          <ExternalLink className="size-4" />
        </span>
      )}
    </Wrapper>
  );
}

function activityConnectionFilters(activities, syncRuns) {
  const connections = new Map();

  for (const activity of activities || []) {
    addActivityConnection(connections, activity);
  }

  for (const syncRun of syncRuns || []) {
    addActivityConnection(connections, syncRun);
  }

  return [...connections.values()].sort((left, right) => (
    activityProviderLabel(left.provider).localeCompare(activityProviderLabel(right.provider))
    || left.label.localeCompare(right.label)
  ));
}

function addActivityConnection(connections, source) {
  const key = activityConnectionKey(source);

  if (!connections.has(key)) {
    connections.set(key, {
      key,
      provider: source.provider || "unknown",
      label: source.connectionName || source.connectionId || activityProviderLabel(source.provider),
    });
  }
}

function activityConnectionKey(source) {
  return [
    source.provider || "unknown",
    source.connectionId || source.connectionName || "unknown",
  ].join(":");
}
