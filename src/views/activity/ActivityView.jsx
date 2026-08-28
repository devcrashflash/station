import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
  FileText,
  List,
  ListFilter,
  LoaderCircle,
  MapPin,
  RefreshCw,
  Search,
  Video,
} from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { CheckboxFilterCard } from "@/components/common/CheckboxFilterCard";
import { Panel } from "@/components/common/Panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { DaySummaryPreview } from "@/features/activity/DaySummaryPreview";
import { api } from "@/lib/api";
import {
  activityActionClassName,
  activityActionFilters,
  activityActionLabel,
  activityEventKindLabel,
  activityOpenUrl,
  activityProviderLabel,
  addDays,
  formatActivityLastSyncText,
  formatLocalDate,
  filterActivitiesByActionBadges,
  isTrelloAutomationActivity,
  isTrelloDelimiterActivity,
  isTrelloPositionOnlyActivity,
  latestActivitySyncAt,
  parseLocalDate,
  recentActivityDates,
  sortActivities,
  staleActivityConnectionIds,
  syncWarningMessages,
  timelineItemsToCsv,
} from "@/lib/activity";
import {
  buildDaySummaryModel,
  daySummaryModelToMarkdown,
  filterDaySummaryModelBySearch,
  trelloTicketUrlsForActivities,
} from "@/lib/activitySummary";
import { filterTimelineItemsBySearch } from "@/lib/activitySearch";
import { openExternalUrl } from "@/lib/externalLinks";
import { isPrimarySearchShortcut, shortcutModifier } from "@/lib/keyboardShortcut";
import { cn } from "@/lib/utils";
import { calendarEventOpenUrl, calendarEventTimeLabel, calendarWarningMessages } from "@/lib/calendar";

function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}

export function ActivityView({
  date,
  projects = [],
  activities,
  syncRuns,
  isSyncing,
  calendarEvents = [],
  calendarSyncRuns = [],
  isCalendarSyncing = false,
  onDateChange,
  onNotice,
  onRefresh,
}) {
  const today = formatLocalDate();
  const connectionFilters = useMemo(
    () => activityConnectionFilters(activities, syncRuns, calendarEvents, calendarSyncRuns),
    [activities, syncRuns, calendarEvents, calendarSyncRuns],
  );
  const [disabledConnectionKeys, setDisabledConnectionKeys] = useState(() => new Set());
  const [disabledActionKeys, setDisabledActionKeys] = useState(() => new Set());
  const [copyState, setCopyState] = useState("idle");
  const [summaryCopyState, setSummaryCopyState] = useState("idle");
  const [activeTimelineTab, setActiveTimelineTab] = useState("summary");
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef(null);
  const shortcutKey = shortcutModifier();
  const [summaryContext, setSummaryContext] = useState({
    date: null,
    loading: false,
    resources: [],
    resolvedTickets: [],
    warnings: [],
  });
  const summaryRunRef = useRef(0);
  const manualActivities = useMemo(
    () => (activities || []).filter((activity) => (
      !isTrelloAutomationActivity(activity)
      && !isTrelloDelimiterActivity(activity)
      && !isTrelloPositionOnlyActivity(activity)
    )),
    [activities],
  );
  const sortedActivities = useMemo(() => sortActivities(manualActivities), [manualActivities]);
  const connectionFilteredActivities = useMemo(
    () => sortedActivities.filter(
      (activity) => !disabledConnectionKeys.has(activityConnectionKey(activity)),
    ),
    [disabledConnectionKeys, sortedActivities],
  );
  const actionFilters = useMemo(
    () => activityActionFilters(connectionFilteredActivities),
    [connectionFilteredActivities],
  );
  const filteredActivities = useMemo(
    () => filterActivitiesByActionBadges(connectionFilteredActivities, disabledActionKeys),
    [connectionFilteredActivities, disabledActionKeys],
  );
  const filteredCalendarEvents = calendarEvents.filter(
    (event) => !disabledConnectionKeys.has(calendarConnectionKey(event)),
  );
  const timelineItems = [
    ...filteredActivities.map((activity) => ({ type: "activity", value: activity, time: activity.occurredAt || 0, allDay: false })),
    ...filteredCalendarEvents.map((event) => ({ type: "calendar", value: event, time: event.startAt || 0, allDay: Boolean(event.allDay) })),
  ].sort((left, right) => Number(right.allDay) - Number(left.allDay) || left.time - right.time || String(left.value.id).localeCompare(String(right.value.id)));
  const searchedTimelineItems = filterTimelineItemsBySearch(timelineItems, searchQuery);
  const selectedWeekdayLabel = useMemo(
    () => new Intl.DateTimeFormat("en", {
      weekday: "long",
    }).format(parseLocalDate(date)),
    [date],
  );
  const warnings = [...syncWarningMessages(syncRuns), ...calendarWarningMessages(calendarSyncRuns)];
  const totalItems = sortedActivities.length + calendarEvents.length;
  const activityCountText = timelineItems.length === totalItems
    ? `${totalItems} timeline items`
    : `${timelineItems.length} of ${totalItems} timeline items`;
  const syncing = isSyncing || isCalendarSyncing;
  const summary = useMemo(() => {
    if (summaryContext.date !== date) return null;
    return buildDaySummaryModel({
      activities: filteredActivities,
      calendarEvents: filteredCalendarEvents,
      projects,
      resources: summaryContext.resources,
      resolvedTickets: summaryContext.resolvedTickets,
    });
  }, [date, filteredActivities, filteredCalendarEvents, projects, summaryContext]);
  const searchedSummary = useMemo(
    () => filterDaySummaryModelBySearch(summary, searchQuery),
    [searchQuery, summary],
  );
  const summaryMarkdown = useMemo(
    () => searchedSummary ? daySummaryModelToMarkdown(searchedSummary) : "",
    [searchedSummary],
  );
  const hasSummary = Boolean(summary && (summary.sections.length > 0 || summary.meetings.length > 0));
  const hasSearchedSummary = Boolean(
    searchedSummary && (searchedSummary.sections.length > 0 || searchedSummary.meetings.length > 0),
  );
  const summaryPreparing = summaryContext.date !== date || summaryContext.loading;

  useEffect(() => {
    setSearchQuery("");
    setDisabledActionKeys(new Set());
  }, [date]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (!isPrimarySearchShortcut(event)) return;
      if (document.querySelector("[role='dialog']")) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (copyState === "idle") return undefined;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  useEffect(() => {
    if (summaryCopyState === "idle") return undefined;
    const timer = window.setTimeout(() => setSummaryCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [summaryCopyState]);

  useEffect(() => {
    const runId = summaryRunRef.current + 1;
    summaryRunRef.current = runId;
    setSummaryContext((current) => current.date === date
      ? { ...current, loading: true }
      : { date, loading: true, resources: [], resolvedTickets: [], warnings: [] });

    let cancelled = false;
    async function prepareSummary() {
      let resources = [];
      const summaryWarnings = [];
      try {
        const resourceLists = await Promise.all(
          projects.map((project) => api.listProjectResources({ projectId: project.id })),
        );
        resources = resourceLists.flat();
      } catch (error) {
        summaryWarnings.push(error?.message || "Could not load project resources for the summary.");
      }

      let resolvedTickets = [];
      const ticketUrls = trelloTicketUrlsForActivities(manualActivities);
      if (ticketUrls.length > 0) {
        try {
          const result = await api.resolveTrelloTickets({ urls: ticketUrls });
          resolvedTickets = result.tickets || [];
          summaryWarnings.push(...(result.warnings || []));
        } catch (error) {
          summaryWarnings.push(error?.message || "Could not load linked Trello tickets.");
        }
      }

      if (cancelled || summaryRunRef.current !== runId) return;
      setSummaryContext({
        date,
        loading: false,
        resources,
        resolvedTickets,
        warnings: summaryWarnings,
      });
    }

    prepareSummary();
    return () => {
      cancelled = true;
    };
  }, [date, manualActivities, projects]);

  useEffect(() => {
    const knownKeys = new Set(connectionFilters.map((connection) => connection.key));
    setDisabledConnectionKeys((current) => {
      const next = new Set([...current].filter((key) => knownKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [connectionFilters]);

  useEffect(() => {
    const knownKeys = new Set(actionFilters);
    setDisabledActionKeys((current) => {
      const next = new Set([...current].filter((key) => knownKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [actionFilters]);

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

  const toggleAction = useCallback((key, enabled) => {
    setDisabledActionKeys((current) => {
      const next = new Set(current);
      if (enabled) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const copyTimelineAsCsv = useCallback(async () => {
    try {
      await copyTextToClipboard(timelineItemsToCsv(searchedTimelineItems));
      setCopyState("copied");
      onNotice?.("Timeline copied as CSV.");
    } catch (error) {
      setCopyState("error");
      onNotice?.(error?.message || "Could not copy the timeline as CSV.");
    }
  }, [onNotice, searchedTimelineItems]);

  const copySummary = useCallback(async () => {
    try {
      await copyTextToClipboard(summaryMarkdown);
      setSummaryCopyState("copied");
      onNotice?.("Summary copied as Markdown.");
    } catch (error) {
      setSummaryCopyState("error");
      onNotice?.(error?.message || "Could not copy the summary.");
    }
  }, [onNotice, summaryMarkdown]);

  return (
    <div className="grid flex-1 gap-6 overflow-y-auto p-6 [scrollbar-gutter:stable] lg:grid-cols-[minmax(0,1fr)_320px]">
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
              aria-busy={syncing}
              disabled={syncing}
              onClick={onRefresh}
            >
              {syncing ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {syncing ? "Syncing..." : "Sync"}
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
              <div
                className="inline-flex w-fit rounded-md border bg-muted/30 p-1"
                role="tablist"
                aria-label="Timeline views"
              >
                <TimelineTab
                  id="summary"
                  label="Summary"
                  icon={FileText}
                  activeTab={activeTimelineTab}
                  onChange={setActiveTimelineTab}
                />
                <TimelineTab
                  id="details"
                  label="Details"
                  icon={List}
                  activeTab={activeTimelineTab}
                  onChange={setActiveTimelineTab}
                />
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <SyncSummary syncRuns={[...syncRuns, ...calendarSyncRuns]} isSyncing={syncing} />
                {activeTimelineTab === "details" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={searchedTimelineItems.length === 0}
                    onClick={copyTimelineAsCsv}
                  >
                    {copyState === "copied" ? <Check /> : <ClipboardCopy />}
                    {copyState === "copied" ? "Copied" : "Copy as CSV"}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={summaryPreparing || !summaryMarkdown}
                    onClick={copySummary}
                  >
                    {summaryCopyState === "copied" ? <Check /> : <ClipboardCopy />}
                    {summaryCopyState === "copied" ? "Copied" : "Copy as Markdown"}
                  </Button>
                )}
              </div>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                className="pl-9 pr-16"
                type="search"
                value={searchQuery}
                placeholder={`Search timeline ${activeTimelineTab}`}
                aria-label="Search activity timeline"
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              <Kbd className="absolute right-3 top-1/2 -translate-y-1/2">{shortcutKey} F</Kbd>
            </div>

            {activeTimelineTab === "details" ? (
              <div id="timeline-details-panel" role="tabpanel" aria-labelledby="timeline-details-tab" className="grid gap-4">
                <p className="text-sm font-medium">{activityCountText}</p>
                {timelineItems.length === 0 ? (
                  <EmptyState
                    text={
                      sortedActivities.length > 0
                        ? "No activity matches the selected filters."
                        : totalItems > 0
                          ? "No manual activity cached for this day."
                        : isSyncing
                          ? "Syncing activity..."
                          : "No timeline items cached for this day."
                    }
                  />
                ) : searchedTimelineItems.length === 0 ? (
                  <EmptyState text="No timeline items match your search." />
                ) : (
                  <div className="flex flex-col gap-2">
                    {searchedTimelineItems.map((item) => item.type === "calendar" ? (
                      <CalendarEventItem key={`calendar:${item.value.id}`} event={item.value} />
                    ) : (
                      <ActivityItem key={`activity:${item.value.id}`} activity={item.value} />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div id="timeline-summary-panel" role="tabpanel" aria-labelledby="timeline-summary-tab" className="grid gap-4">
                {summaryContext.warnings.length > 0 && summaryContext.date === date && (
                  <div className="grid gap-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    {summaryContext.warnings.map((warning, index) => <p key={`${index}:${warning}`}>{warning}</p>)}
                  </div>
                )}
                {summaryPreparing && !hasSummary ? (
                  <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" />
                    Building summary...
                  </div>
                ) : hasSummary && !hasSearchedSummary ? (
                  <EmptyState text="No summary items match your search." />
                ) : hasSearchedSummary ? (
                  <div className="grid gap-3">
                    {summaryContext.loading && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <LoaderCircle className="size-3.5 animate-spin" />
                        Updating summary...
                      </div>
                    )}
                    <DaySummaryPreview summary={searchedSummary} />
                  </div>
                ) : (
                  <EmptyState text="No visible timeline items to summarize." />
                )}
              </div>
            )}
          </div>
        </Panel>
      </section>

      <aside className="min-w-0">
        <Panel title="Filters" icon={ListFilter}>
          <ActivityFilters
            actions={actionFilters}
            connections={connectionFilters}
            disabledActionKeys={disabledActionKeys}
            disabledConnectionKeys={disabledConnectionKeys}
            onReset={() => {
              setDisabledConnectionKeys(new Set());
              setDisabledActionKeys(new Set());
            }}
            onToggleAction={toggleAction}
            onToggle={toggleConnection}
          />
        </Panel>
      </aside>
    </div>
  );
}

function TimelineTab({ id, label, icon: Icon, activeTab, onChange }) {
  const isActive = activeTab === id;
  const otherTab = id === "details" ? "summary" : "details";

  function selectOtherTab(event) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    onChange(otherTab);
    requestAnimationFrame(() => document.getElementById(`timeline-${otherTab}-tab`)?.focus());
  }

  return (
    <button
      id={`timeline-${id}-tab`}
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-controls={`timeline-${id}-panel`}
      tabIndex={isActive ? 0 : -1}
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-sm px-3 text-sm font-medium text-muted-foreground transition-colors",
        "hover:bg-background hover:text-foreground",
        isActive && "bg-background text-foreground shadow-xs",
      )}
      onClick={() => onChange(id)}
      onKeyDown={selectOtherTab}
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for webviews that expose the Clipboard API without granting access.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) throw new Error("Could not copy text.");
}

export function useActivityData({
  date,
  connections = [],
  enabled = true,
  onError,
  startupSyncEnabled = false,
}) {
  const [resultsByDate, setResultsByDate] = useState(() => new Map());
  const [isSyncing, setIsSyncing] = useState(false);
  const onErrorRef = useRef(onError);
  const resultsByDateRef = useRef(resultsByDate);
  const currentDateRef = useRef(date);
  const syncsByDateRef = useRef(new Map());
  const syncQueueRef = useRef(Promise.resolve());
  const startupSyncStartedRef = useRef(false);

  currentDateRef.current = date;

  const currentResult = resultsByDate.get(date) || { activities: [], syncRuns: [] };
  const activities = currentResult.activities;
  const syncRuns = currentResult.syncRuns;

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const storeResult = useCallback((targetDate, result) => {
    const normalized = {
      activities: result.activities || [],
      syncRuns: result.syncRuns || [],
    };
    const next = new Map(resultsByDateRef.current);
    next.set(targetDate, normalized);
    resultsByDateRef.current = next;
    setResultsByDate(next);
    return normalized;
  }, []);

  const loadCached = useCallback(async (targetDate = date) => {
    const result = await api.listActivities({ date: targetDate });
    storeResult(targetDate, result);
    return result;
  }, [date, storeResult]);

  const syncDate = useCallback((targetDate, {
    connectionIds,
    quiet = false,
    waitForPaint = false,
  } = {}) => {
    const pending = syncsByDateRef.current.get(targetDate);
    if (pending) {
      if (!quiet) pending.reportErrors = true;
      return pending.promise;
    }

    const entry = { promise: null, reportErrors: !quiet };
    entry.promise = syncQueueRef.current.catch(() => {}).then(async () => {
      if (currentDateRef.current === targetDate) setIsSyncing(true);
      if (waitForPaint) await waitForNextPaint();
      try {
        const result = await api.syncActivities({ date: targetDate, connectionIds });
        storeResult(targetDate, result);
        return result;
      } catch (error) {
        if (entry.reportErrors) onErrorRef.current?.(error);
        return loadCached(targetDate);
      } finally {
        syncsByDateRef.current.delete(targetDate);
        if (currentDateRef.current === targetDate) setIsSyncing(false);
      }
    });

    syncsByDateRef.current.set(targetDate, entry);
    syncQueueRef.current = entry.promise;
    return entry.promise;
  }, [loadCached, storeResult]);

  const sync = useCallback(async () => {
    if (!enabled) {
      return { activities, syncRuns };
    }
    return syncDate(date, { waitForPaint: true });
  }, [activities, date, enabled, syncDate, syncRuns]);

  useEffect(() => {
    let cancelled = false;
    let syncTimer = null;
    setIsSyncing(syncsByDateRef.current.has(date));

    async function hydrate() {
      try {
        const cached = resultsByDateRef.current.get(date);
        const result = cached || await loadCached(date);
        if (cancelled || !enabled) return;
        const connectionIds = staleActivityConnectionIds({
          date,
          connections,
          syncRuns: result.syncRuns || [],
        });
        if (!connectionIds.length) return;

        syncTimer = window.setTimeout(() => {
          if (!cancelled) void syncDate(date, { connectionIds });
        }, 250);
      } catch (error) {
        if (!cancelled) onErrorRef.current?.(error);
      }
    }

    void hydrate();

    return () => {
      cancelled = true;
      if (syncTimer) {
        window.clearTimeout(syncTimer);
      }
    };
  }, [connections, date, enabled, loadCached, syncDate]);

  useEffect(() => {
    if (!startupSyncEnabled || startupSyncStartedRef.current) return;
    startupSyncStartedRef.current = true;

    async function startBackgroundSync() {
      const dates = recentActivityDates();
      const cachedResults = await Promise.all(dates.map((targetDate) => loadCached(targetDate)));

      for (let index = 0; index < dates.length; index += 1) {
        const targetDate = dates[index];
        const connectionIds = staleActivityConnectionIds({
          date: targetDate,
          connections,
          syncRuns: cachedResults[index].syncRuns || [],
        });
        if (connectionIds.length) {
          void syncDate(targetDate, { connectionIds, quiet: true }).catch(() => {});
        }
      }
    }

    void startBackgroundSync().catch(() => {});
  }, [connections, loadCached, startupSyncEnabled, syncDate]);

  return {
    activities,
    syncRuns,
    isSyncing,
    refresh: sync,
  };
}

function SyncSummary({ syncRuns, isSyncing }) {
  const lastSyncText = formatActivityLastSyncText(latestActivitySyncAt(syncRuns));

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

function ActivityFilters({
  actions,
  connections,
  disabledActionKeys,
  disabledConnectionKeys,
  onReset,
  onToggleAction,
  onToggle,
}) {
  const hasActiveFilters = disabledConnectionKeys.size > 0 || disabledActionKeys.size > 0;

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
          disabled={!hasActiveFilters}
          onClick={onReset}
        >
          Reset
        </Button>
      </div>

      {connections.length > 0 ? (
        <div className="flex flex-col gap-2">
          {connections.map((connection) => {
            const enabled = !disabledConnectionKeys.has(connection.key);

            return (
              <CheckboxFilterCard
                key={connection.key}
                label={connection.label}
                description={activityProviderLabel(connection.provider)}
                checked={enabled}
                ariaLabel={`${enabled ? "Disable" : "Enable"} ${connection.label}`}
                onCheckedChange={(checked) => onToggle(connection.key, checked === true)}
              />
            );
          })}
        </div>
      ) : (
        <EmptyState text="No synced timeline sources yet." />
      )}

      <div className="grid gap-2 border-t pt-4">
        <p className="text-sm font-medium">Activity</p>
        {actions.length > 0 ? actions.map((action) => {
          const enabled = !disabledActionKeys.has(action);
          return (
            <CheckboxFilterCard
              key={action}
              label={action}
              checked={enabled}
              ariaLabel={`${enabled ? "Disable" : "Enable"} ${action} activity`}
              onCheckedChange={(checked) => onToggleAction(action, checked === true)}
            />
          );
        }) : (
          <EmptyState text="No activity badges for enabled connections." />
        )}
      </div>
    </div>
  );
}

function ActivityItem({ activity }) {
  const occurred = activity.occurredAt ? new Date(activity.occurredAt) : null;
  const actionLabel = activityActionLabel(activity);
  const kindLabel = activityEventKindLabel(activity);
  const openUrl = activityOpenUrl(activity);
  const Wrapper = openUrl ? "a" : "div";

  return (
    <Wrapper
      className={cn(
        "grid min-w-0 grid-cols-[4rem_minmax(0,1fr)_auto] gap-3 overflow-hidden rounded-md border bg-card p-3 text-card-foreground",
        openUrl && "cursor-pointer transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
      href={openUrl || undefined}
      target={openUrl ? "_blank" : undefined}
      rel={openUrl ? "noreferrer" : undefined}
      title={openUrl ? "Open activity" : undefined}
      onClick={openUrl ? (event) => {
        event.preventDefault();
        void openExternalUrl(openUrl);
      } : undefined}
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
      {openUrl && (
        <span
          className="shrink-0 text-blue-700 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200"
          aria-hidden="true"
        >
          <ExternalLink className="size-4" />
        </span>
      )}
    </Wrapper>
  );
}

function CalendarEventItem({ event }) {
  const openUrl = calendarEventOpenUrl(event);
  return (
    <div
      className="grid min-w-0 grid-cols-[4rem_minmax(0,1fr)_auto] gap-3 overflow-hidden rounded-md border bg-card p-3 text-card-foreground"
      style={{ borderLeftColor: event.calendarColor || "#64748b", borderLeftWidth: 4 }}
    >
      <div className="w-16 shrink-0 text-xs text-muted-foreground">{calendarEventTimeLabel(event)}</div>
      <div className="min-w-0 overflow-hidden">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant="secondary">Calendar</Badge>
          <Badge variant="outline">{event.calendarName}</Badge>
          {event.attendeeStatus && <Badge variant="outline">{event.attendeeStatus}</Badge>}
        </div>
        <p className="mt-1 min-w-0 break-words text-sm font-medium leading-5 [overflow-wrap:anywhere]">{event.title}</p>
        {event.location && (
          <p className="mt-1 flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
            <MapPin className="size-3 shrink-0" />
            <span className="truncate">{event.location}</span>
          </p>
        )}
      </div>
      {openUrl && (
        <Button size="sm" variant="outline" asChild>
          <a href={openUrl} target="_blank" rel="noreferrer" title={event.joinUrl ? "Join meeting" : "Open event"}>
            {event.joinUrl ? <Video /> : <ExternalLink />}
            {event.joinUrl ? "Join" : "Open"}
          </a>
        </Button>
      )}
    </div>
  );
}

function activityConnectionFilters(activities, syncRuns, calendarEvents, calendarSyncRuns) {
  const connections = new Map();

  for (const activity of activities || []) {
    addActivityConnection(connections, activity);
  }

  for (const syncRun of syncRuns || []) {
    addActivityConnection(connections, syncRun);
  }

  for (const event of calendarEvents || []) {
    connections.set(calendarConnectionKey(event), {
      key: calendarConnectionKey(event),
      provider: "calendar",
      label: event.calendarName || "Calendar",
    });
  }

  for (const run of calendarSyncRuns || []) {
    const key = `calendar:${run.collectionId}`;
    if (!connections.has(key)) connections.set(key, { key, provider: "calendar", label: run.calendarName || "Calendar" });
  }

  return [...connections.values()].sort((left, right) => (
    activityProviderLabel(left.provider).localeCompare(activityProviderLabel(right.provider))
    || left.label.localeCompare(right.label)
  ));
}

function calendarConnectionKey(event) {
  return `calendar:${event.collectionId}`;
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
