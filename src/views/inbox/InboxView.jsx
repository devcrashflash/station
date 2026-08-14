import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CalendarDays, ClipboardList, ExternalLink, Eye, Files, FileText, GitPullRequest, Inbox, LoaderCircle, MapPin, Pencil, Plus, RefreshCw, Search, Settings, SquareKanban, Trash2, Video } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Modal } from "@/components/common/Modal";
import { Panel } from "@/components/common/Panel";
import { SegmentedTabs } from "@/components/common/SegmentedTabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SmartInput } from "@/features/smart-input/SmartInput";
import {
  dashboardTaskCreatedAt,
  dashboardTaskProjectName,
  filterDashboardTasks,
  latestDashboardTasks,
} from "@/lib/dashboardTasks";
import { isPrimarySearchShortcut, shortcutModifier } from "@/lib/keyboardShortcut";
import { isSupportedOcrFile } from "@/lib/ocr";
import { reviewRequestInput, reviewRequestSubtitle } from "@/lib/smartInboxReviewRequests";
import { buildAllSmartInboxItems } from "@/lib/smartInboxAll";
import { filterAllSmartInboxItems, filterSmartInboxItems } from "@/lib/smartInboxSearch";
import { cn } from "@/lib/utils";
import { calendarEventOpenUrl, calendarEventTimeLabel, calendarWarnings, sortCalendarEvents } from "@/lib/calendar";

export function InboxView({
  tasks = [],
  projects = [],
  smartInboxTodos = [],
  recentDirectoryFiles = [],
  onSubmit,
  onFileDrop,
  onEditTodo,
  onOpenTodo,
  onDeleteTodo,
  onOpenRecentFile,
  onRefreshAll,
  onRefreshRecentFiles,
  onLoadProviderItems,
  onSyncProviderItems,
  onLoadProviderSources,
  onUpdateProviderSources,
  onOpenReviewRequest,
  onOpenTask,
  smartInputFocusRequestKey = 0,
  calendarEvents = [],
  calendarSyncRuns = [],
  isCalendarSyncing = false,
  hasCalendarAccounts = false,
  onRefreshCalendar,
  onReconnectCalendarAccount,
  onShowCalendarSettings,
}) {
  const [activeTab, setActiveTab] = useState("all");
  const latestTasks = latestDashboardTasks(tasks, 20);
  const recentTasks = latestTasks.slice(0, 3);
  const dashboardTaskCount = filterDashboardTasks(tasks).length;

  return (
    <div className="grid flex-1 gap-6 overflow-y-auto p-6 [scrollbar-gutter:stable] lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="flex min-w-0 flex-col gap-5">
        <div>
          <h2 className="text-3xl font-semibold">Capture work from anywhere</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Add a task, paste a Trello card or board, or route a pull request to a project and task.
          </p>
        </div>
        <SmartInput
          large
          focusRequestKey={smartInputFocusRequestKey}
          onSubmit={onSubmit}
          onFileDrop={onFileDrop}
        />
        <InboxCaptureTabs
          activeTab={activeTab}
          onActiveTabChange={setActiveTab}
          todos={smartInboxTodos}
          tasks={latestTasks}
          taskCount={dashboardTaskCount}
          projects={projects}
          files={recentDirectoryFiles}
          onEditTodo={onEditTodo}
          onOpenTodo={onOpenTodo}
          onDeleteTodo={onDeleteTodo}
          onOpenFile={onOpenRecentFile}
          onRefreshAll={onRefreshAll}
          onRefresh={onRefreshRecentFiles}
          onLoadProviderItems={onLoadProviderItems}
          onSyncProviderItems={onSyncProviderItems}
          onLoadProviderSources={onLoadProviderSources}
          onUpdateProviderSources={onUpdateProviderSources}
          onOpenReviewRequest={onOpenReviewRequest}
          onOpenTask={onOpenTask}
        />
      </section>

      <aside className="grid min-w-0 content-start gap-6">
        <Panel title="Today's meetings" icon={CalendarDays}>
          <TodayMeetings
            events={calendarEvents}
            syncRuns={calendarSyncRuns}
            isSyncing={isCalendarSyncing}
            hasAccounts={hasCalendarAccounts}
            onRefresh={onRefreshCalendar}
            onReconnect={onReconnectCalendarAccount}
            onShowSettings={onShowCalendarSettings}
          />
        </Panel>
        <Panel title="Recent tasks" icon={ClipboardList}>
          <DashboardTaskList tasks={recentTasks} projects={projects} onOpenTask={onOpenTask} />
          {dashboardTaskCount > 3 && (
            <Button
              type="button"
              variant="outline"
              className="mt-4 w-full"
              onClick={() => setActiveTab("tasks")}
            >
              Show more
            </Button>
          )}
        </Panel>
      </aside>
    </div>
  );
}

function TodayMeetings({ events, syncRuns, isSyncing, hasAccounts, onRefresh, onReconnect, onShowSettings }) {
  const [reconnectingAccountId, setReconnectingAccountId] = useState(null);
  const [reconnectError, setReconnectError] = useState("");
  const warnings = calendarWarnings(syncRuns);
  const sorted = sortCalendarEvents(events);

  async function reconnect(accountId) {
    setReconnectingAccountId(accountId);
    setReconnectError("");
    try {
      await onReconnect(accountId);
    } catch (error) {
      setReconnectError(error?.message || String(error));
    } finally {
      setReconnectingAccountId(null);
    }
  }

  if (!hasAccounts) {
    return (
      <div className="grid gap-3">
        <EmptyState text="Connect a calendar to see today's meetings." />
        <Button type="button" variant="outline" className="w-full" onClick={onShowSettings}>
          <Settings />
          Calendar settings
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {isSyncing ? "Syncing calendars…" : `${sorted.length} event${sorted.length === 1 ? "" : "s"}`}
        </p>
        <Button type="button" size="icon-sm" variant="ghost" title={isSyncing ? "Syncing calendars" : "Refresh today's meetings"} aria-label={isSyncing ? "Syncing calendars" : "Refresh today's meetings"} aria-busy={isSyncing} disabled={isSyncing} onClick={onRefresh}>
          {isSyncing ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
        </Button>
      </div>
      {warnings.map((warning) => (
        <div key={`${warning.accountId}:${warning.collectionId}:${warning.message}`} className="flex items-start justify-between gap-2">
          <p className="min-w-0 text-xs text-destructive">{warning.message}</p>
          {warning.reconnectable && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={Boolean(reconnectingAccountId)}
              onClick={() => reconnect(warning.accountId)}
            >
              {reconnectingAccountId === warning.accountId && <LoaderCircle className="animate-spin" />}
              {reconnectingAccountId === warning.accountId ? "Reconnecting…" : "Reconnect"}
            </Button>
          )}
        </div>
      ))}
      {reconnectError && <p className="text-xs text-destructive">{reconnectError}</p>}
      {sorted.length === 0 ? <EmptyState text={isSyncing ? "Syncing today's meetings…" : "No events today."} /> : (
        <div className="grid gap-2">
          {sorted.map((event) => {
            const openUrl = calendarEventOpenUrl(event);
            return (
              <div key={event.id} className="grid gap-1 rounded-md border p-3" style={{ borderLeftColor: event.calendarColor || "#64748b", borderLeftWidth: 4 }}>
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">{calendarEventTimeLabel(event)}</p>
                    <p className="mt-0.5 break-words text-sm font-medium [overflow-wrap:anywhere]">{event.title}</p>
                  </div>
                  {openUrl && (
                    <Button size="icon-sm" variant="ghost" asChild>
                      <a href={openUrl} target="_blank" rel="noreferrer" title={event.joinUrl ? "Join meeting" : "Open event"}>
                        {event.joinUrl ? <Video /> : <ExternalLink />}
                      </a>
                    </Button>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">{event.calendarName}</p>
                {event.location && !event.joinUrl && (
                  <p className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
                    <MapPin className="size-3 shrink-0" /><span className="truncate">{event.location}</span>
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function InboxCaptureTabs({
  activeTab,
  onActiveTabChange,
  todos,
  tasks,
  taskCount,
  projects,
  files,
  onEditTodo,
  onOpenTodo,
  onDeleteTodo,
  onOpenFile,
  onRefreshAll,
  onRefresh,
  onLoadProviderItems,
  onSyncProviderItems,
  onLoadProviderSources,
  onUpdateProviderSources,
  onOpenReviewRequest,
  onOpenTask,
}) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [settingsProvider, setSettingsProvider] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef(null);
  const shortcutKey = shortcutModifier();
  const [providerItems, setProviderItems] = useState({
    github: { items: [], warnings: [], loaded: false, syncing: false },
    gitlab: { items: [], warnings: [], loaded: false, syncing: false },
    trello: { items: [], warnings: [], loaded: false, syncing: false },
  });
  const startedProviders = useRef(new Set());
  const allItems = useMemo(() => buildAllSmartInboxItems({
    todos,
    tasks,
    files,
    providerItems,
  }), [files, providerItems, tasks, todos]);
  const tabs = [
    { id: "all", label: "All", count: allItems.length, icon: Inbox },
    { id: "todos", label: "Todo", count: todos.length, icon: Inbox },
    { id: "tasks", label: "Tasks", count: taskCount, icon: ClipboardList },
    { id: "latest-files", label: "Latest files", count: files.length, icon: Files },
    { id: "github", label: "GitHub", count: providerItems.github.items.length, icon: GitPullRequest },
    { id: "gitlab", label: "GitLab", count: providerItems.gitlab.items.length, icon: GitPullRequest },
    { id: "trello", label: "Trello", count: providerItems.trello.items.length, icon: SquareKanban },
  ];
  const isProviderTab = ["github", "gitlab", "trello"].includes(activeTab);
  const isAnyProviderSyncing = ["github", "gitlab", "trello"]
    .some((provider) => providerItems[provider].syncing);
  const activeItems = activeTab === "all"
    ? allItems
    : activeTab === "todos"
      ? todos
      : activeTab === "tasks"
        ? tasks
        : activeTab === "latest-files"
          ? files
          : providerItems[activeTab]?.items || [];
  const visibleItems = useMemo(
    () => activeTab === "all"
      ? filterAllSmartInboxItems(activeItems, searchQuery, projects)
      : filterSmartInboxItems(activeTab, activeItems, searchQuery, projects),
    [activeItems, activeTab, projects, searchQuery],
  );
  const filteredEmptyText = activeItems.length > 0 && visibleItems.length === 0
    ? "No items match your search."
    : undefined;

  useEffect(() => {
    setSearchQuery("");
  }, [activeTab]);

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
    if (!onLoadProviderItems) return;

    for (const provider of ["github", "gitlab", "trello"]) {
      if (startedProviders.current.has(provider)) continue;
      startedProviders.current.add(provider);
      loadThenSyncProvider(provider);
    }
  }, [onLoadProviderItems, onSyncProviderItems]);

  useEffect(() => {
    for (const provider of ["github", "gitlab", "trello"]) {
      if (startedProviders.current.has(provider)) {
        loadProviderItems(provider);
      }
    }
  }, [tasks]);

  async function refreshFiles() {
    if (!onRefresh || isRefreshing) return;

    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }

  async function refreshAll() {
    if (!onRefreshAll || isRefreshing || isAnyProviderSyncing) return;

    setIsRefreshing(true);
    try {
      await Promise.all([
        onRefreshAll(),
        ...["github", "gitlab", "trello"].map(syncProviderItems),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }

  async function loadThenSyncProvider(provider) {
    await loadProviderItems(provider);
    await syncProviderItems(provider);
  }

  async function loadProviderItems(provider) {
    if (!onLoadProviderItems) return;

    try {
      const result = await onLoadProviderItems(provider);
      setProviderItems((current) => ({
        ...current,
        [provider]: {
          ...current[provider],
          items: result?.items || [],
          warnings: result?.warnings || [],
          loaded: true,
        },
      }));
    } catch (error) {
      setProviderError(provider, error);
    }
  }

  async function syncProviderItems(provider) {
    if (!onSyncProviderItems) return;

    setProviderItems((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        syncing: true,
      },
    }));
    try {
      const result = await onSyncProviderItems(provider);
      setProviderItems((current) => ({
        ...current,
        [provider]: {
          items: result?.items || [],
          warnings: result?.warnings || [],
          loaded: true,
          syncing: false,
        },
      }));
    } catch (error) {
      setProviderError(provider, error);
    }
  }

  function setProviderError(provider, error) {
    setProviderItems((current) => ({
        ...current,
        [provider]: {
          ...current[provider],
          warnings: [{
            provider,
            connectionId: "",
            connectionName: providerName(provider),
            message: error?.message || String(error),
          }],
          loaded: true,
          syncing: false,
        },
      }));
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <SegmentedTabs
          tabs={tabs}
          value={activeTab}
          onValueChange={onActiveTabChange}
          ariaLabel="Smart inbox captures"
        />
        {activeTab === "all" && onRefreshAll && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Refresh all smart inbox items"
                disabled={isRefreshing || isAnyProviderSyncing}
                onClick={refreshAll}
              >
                <RefreshCw className={isRefreshing || isAnyProviderSyncing ? "animate-spin" : ""} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh all smart inbox items</TooltipContent>
          </Tooltip>
        )}
        {activeTab === "latest-files" && onRefresh && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Refresh latest files"
                disabled={isRefreshing}
                onClick={refreshFiles}
              >
                <RefreshCw className={isRefreshing ? "animate-spin" : ""} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh latest files</TooltipContent>
          </Tooltip>
        )}
        {isProviderTab && (
          <div className="flex items-center gap-2">
            {onLoadProviderSources && onUpdateProviderSources && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label={`Configure ${activeTab} smart inbox sources`}
                    onClick={() => setSettingsProvider(activeTab)}
                  >
                    <Settings />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Configure {providerName(activeTab)} sources</TooltipContent>
              </Tooltip>
            )}
            {onSyncProviderItems && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label={`Refresh ${activeTab} smart inbox items`}
                    disabled={providerItems[activeTab]?.syncing}
                    onClick={() => syncProviderItems(activeTab)}
                  >
                    <RefreshCw className={providerItems[activeTab]?.syncing ? "animate-spin" : ""} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh {providerName(activeTab)} items</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchInputRef}
          className="pl-9 pr-16"
          type="search"
          value={searchQuery}
          placeholder={`Search ${tabLabel(tabs, activeTab).toLocaleLowerCase()}`}
          aria-label="Search smart inbox"
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        <Kbd className="absolute right-3 top-1/2 -translate-y-1/2">{shortcutKey} F</Kbd>
      </div>

      <div role="tabpanel" aria-label={tabLabel(tabs, activeTab)}>
        {activeTab === "all" ? (
          <AllSmartInboxItemList
            entries={visibleItems}
            providerItems={providerItems}
            projects={projects}
            onEditTodo={onEditTodo}
            onOpenTodo={onOpenTodo}
            onDeleteTodo={onDeleteTodo}
            onOpenFile={onOpenFile}
            onOpenReviewRequest={onOpenReviewRequest}
            onOpenTask={onOpenTask}
            emptyText={filteredEmptyText}
          />
        ) : activeTab === "todos" ? (
          <SmartInboxTodoList
            todos={visibleItems}
            onEditTodo={onEditTodo}
            onOpenTodo={onOpenTodo}
            onDeleteTodo={onDeleteTodo}
            emptyText={filteredEmptyText}
          />
        ) : activeTab === "tasks" ? (
          <DashboardTaskList
            tasks={visibleItems}
            projects={projects}
            onOpenTask={onOpenTask}
            emptyText={filteredEmptyText}
          />
        ) : activeTab === "latest-files" ? (
          <RecentDirectoryFilesList
            files={visibleItems}
            onOpenFile={onOpenFile}
            emptyText={filteredEmptyText}
          />
        ) : (
          <ReviewRequestList
            provider={activeTab}
            result={{ ...providerItems[activeTab], items: visibleItems }}
            onOpenReviewRequest={onOpenReviewRequest}
            onOpenTask={onOpenTask}
            emptyText={filteredEmptyText}
          />
        )}
      </div>

      {settingsProvider && (
        <SmartInboxSourceSettingsDialog
          provider={settingsProvider}
          onClose={() => setSettingsProvider(null)}
          onLoad={onLoadProviderSources}
          onSave={onUpdateProviderSources}
          onSaved={() => syncProviderItems(settingsProvider)}
        />
      )}
    </div>
  );
}

function AllSmartInboxItemList({
  entries,
  providerItems,
  projects,
  onEditTodo,
  onOpenTodo,
  onDeleteTodo,
  onOpenFile,
  onOpenReviewRequest,
  onOpenTask,
  emptyText,
}) {
  const warnings = ["github", "gitlab", "trello"]
    .flatMap((provider) => providerItems[provider]?.warnings || []);

  return (
    <div className="grid gap-2">
      <ProviderWarnings warnings={warnings} />
      {entries.length === 0 ? (
        <EmptyState text={emptyText || "No inbox items."} />
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map(({ category, item, key }) => {
            if (category === "todos") {
              return (
                <SmartInboxTodoItem
                  key={key}
                  todo={item}
                  onEditTodo={onEditTodo}
                  onOpenTodo={onOpenTodo}
                  onDeleteTodo={onDeleteTodo}
                />
              );
            }
            if (category === "tasks") {
              return (
                <DashboardTaskItem
                  key={key}
                  task={item}
                  projects={projects}
                  onOpenTask={onOpenTask}
                />
              );
            }
            if (category === "latest-files") {
              return <RecentDirectoryFileItem key={key} file={item} onOpenFile={onOpenFile} />;
            }
            return (
              <ReviewRequestItem
                key={key}
                provider={category}
                item={item}
                onOpenReviewRequest={onOpenReviewRequest}
                onOpenTask={onOpenTask}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function SmartInboxSourceSettingsDialog({ provider, onClose, onLoad, onSave, onSaved }) {
  const [sources, setSources] = useState([]);
  const [enabledByKey, setEnabledByKey] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    onLoad(provider)
      .then((result) => {
        if (!active) return;
        setSources(result || []);
        setEnabledByKey(Object.fromEntries((result || []).map((source) => [sourceKey(source), source.enabled])));
      })
      .catch((loadError) => active && setError(loadError?.message || String(loadError)))
      .finally(() => active && setIsLoading(false));
    return () => { active = false; };
  }, [onLoad, provider]);

  const groups = sources.reduce((result, source) => {
    const existing = result.find((group) => group.connectionId === source.connectionId);
    if (existing) existing.sources.push(source);
    else result.push({ connectionId: source.connectionId, connectionName: source.connectionName, sources: [source] });
    return result;
  }, []);

  async function save() {
    const changes = sources
      .filter((source) => enabledByKey[sourceKey(source)] !== source.enabled)
      .map((source) => ({
        connectionId: source.connectionId,
        sourceId: source.sourceId,
        enabled: enabledByKey[sourceKey(source)] === true,
      }));
    setIsSaving(true);
    setError("");
    try {
      await onSave(provider, changes);
      await onSaved();
      onClose();
    } catch (saveError) {
      setError(saveError?.message || String(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal title={`${providerName(provider)} Smart Inbox sources`} onClose={() => !isSaving && onClose()}>
      <p className="text-sm text-muted-foreground">
        New {provider === "trello" ? "boards" : "repositories"} are enabled automatically when discovered.
      </p>
      <div className="mt-4 grid max-h-[55vh] gap-4 overflow-y-auto">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading sources…</p>
        ) : groups.length === 0 ? (
          <EmptyState text={`No ${provider === "trello" ? "boards" : "repositories"} discovered yet.`} />
        ) : groups.map((group) => (
          <section key={group.connectionId} className="grid gap-2">
            <h3 className="text-sm font-medium">{group.connectionName}</h3>
            <div className="grid gap-1 rounded-md border p-2">
              {group.sources.map((source) => (
                <label key={sourceKey(source)} className="flex items-center gap-3 rounded-sm px-2 py-2 hover:bg-muted/50">
                  <Checkbox
                    checked={enabledByKey[sourceKey(source)] === true}
                    disabled={isSaving}
                    onCheckedChange={(checked) => setEnabledByKey((current) => ({
                      ...current,
                      [sourceKey(source)]: checked === true,
                    }))}
                  />
                  <span className="min-w-0 truncate text-sm">{source.sourceName}</span>
                </label>
              ))}
            </div>
          </section>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <DialogFooter className="mt-5">
        <Button type="button" variant="outline" disabled={isSaving} onClick={onClose}>Cancel</Button>
        <Button type="button" disabled={isLoading || isSaving} onClick={save}>
          {isSaving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </Modal>
  );
}

function sourceKey(source) {
  return `${source.connectionId}:${source.sourceId}`;
}

export function DashboardTaskList({
  tasks = [],
  projects = [],
  onOpenTask,
  emptyText = "No tasks yet.",
}) {
  if (tasks.length === 0) return <EmptyState text={emptyText} />;

  return (
    <div className="flex flex-col gap-2">
      {tasks.map((task) => (
        <DashboardTaskItem
          key={task.id}
          task={task}
          projects={projects}
          onOpenTask={onOpenTask}
        />
      ))}
    </div>
  );
}

function DashboardTaskItem({ task, projects, onOpenTask }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border bg-card p-3">
      <span className="min-w-0 overflow-hidden">
        <span className="block truncate text-sm font-medium">{task.title}</span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {dashboardTaskProjectName(task, projects)} · {dashboardTaskCreatedAt(task)}
        </span>
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!onOpenTask}
        onClick={() => onOpenTask?.(task)}
      >
        <Eye />
        View
      </Button>
    </div>
  );
}

function tabLabel(tabs, activeTab) {
  return tabs.find((tab) => tab.id === activeTab)?.label || activeTab;
}

function ReviewRequestList({
  provider,
  result,
  onOpenReviewRequest,
  onOpenTask,
  emptyText,
}) {
  const displayName = providerName(provider);
  const items = result?.items || [];
  const warnings = result?.warnings || [];

  return (
    <div className="grid gap-2">
      <ProviderWarnings warnings={warnings} />
      {items.length === 0 ? (
        <EmptyState text={emptyText || (provider === "trello" ? "No assigned Trello cards." : `No ${displayName} review requests.`)} />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <ReviewRequestItem
              key={`${item.provider}:${item.externalId || item.url}`}
              provider={provider}
              item={item}
              onOpenReviewRequest={onOpenReviewRequest}
              onOpenTask={onOpenTask}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderWarnings({ warnings }) {
  return warnings.map((warning) => (
    <div
      key={`${warning.provider || "provider"}:${warning.connectionId || warning.connectionName}:${warning.message}`}
      className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {warning.connectionName}: {warning.message}
    </div>
  ));
}

function ReviewRequestItem({ provider, item, onOpenReviewRequest, onOpenTask }) {
  const input = reviewRequestInput(item);
  const canOpen = Boolean(item.url);
  const linkedTask = item.linkedTask || null;

  return (
    <div
      className={cn(
        "grid min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-md border bg-card p-3 transition-colors sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]",
        canOpen && "cursor-pointer hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
      role={canOpen ? "link" : undefined}
      tabIndex={canOpen ? 0 : undefined}
      title={canOpen ? `Open ${provider === "trello" ? "Trello card" : "review request"}` : undefined}
      onClick={() => openReviewRequestLink(item.url)}
      onKeyDown={(event) => {
        if (!canOpen || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        openReviewRequestLink(item.url);
      }}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted/40">
        {provider === "trello" ? (
          <SquareKanban className="size-4 text-muted-foreground" />
        ) : (
          <GitPullRequest className="size-4 text-muted-foreground" />
        )}
      </span>
      <span className="min-w-0 overflow-hidden text-left">
        <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium">
          {item.title}
        </span>
        <span className="mt-1 block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
          {reviewRequestSubtitle(item)}
        </span>
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="col-start-2 row-start-2 w-fit sm:col-start-auto sm:row-start-auto"
        disabled={!canOpen}
        onClick={(event) => {
          event.stopPropagation();
          openReviewRequestLink(item.url);
        }}
      >
        <ExternalLink />
        View
      </Button>
      {linkedTask ? (
        <Button
          type="button"
          size="sm"
          className="col-start-2 row-start-3 w-fit sm:col-start-auto sm:row-start-auto"
          disabled={!onOpenTask}
          onClick={(event) => {
            event.stopPropagation();
            onOpenTask?.(linkedTask);
          }}
        >
          <Eye />
          View Task
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          className="col-start-2 row-start-3 w-fit sm:col-start-auto sm:row-start-auto"
          disabled={!input || !onOpenReviewRequest}
          onClick={(event) => {
            event.stopPropagation();
            onOpenReviewRequest?.(input);
          }}
        >
          <Plus />
          Create task
        </Button>
      )}
    </div>
  );
}

function providerName(provider) {
  return { github: "GitHub", gitlab: "GitLab", trello: "Trello" }[provider] || provider;
}

async function openReviewRequestLink(url) {
  if (!url) return;
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    try {
      await openUrl(url);
      return;
    } catch {
      // Fall through to the browser fallback.
    }
  }
  window.open(url, "_blank", "noreferrer");
}

export function SmartInboxTodoList({
  todos = [],
  onEditTodo,
  onOpenTodo,
  onDeleteTodo,
  emptyText = "No todos yet.",
}) {
  if (todos.length === 0) return <EmptyState text={emptyText} />;

  return (
    <div className="flex flex-col gap-2">
      {todos.map((todo) => (
        <SmartInboxTodoItem
          key={todo.id}
          todo={todo}
          onEditTodo={onEditTodo}
          onOpenTodo={onOpenTodo}
          onDeleteTodo={onDeleteTodo}
        />
      ))}
    </div>
  );
}

function SmartInboxTodoItem({ todo, onEditTodo, onOpenTodo, onDeleteTodo }) {
  const isMissing = todo.kind === "file" && todo.fileMissing;
  const canCreateTask = Boolean(onOpenTodo) && !isMissing;

  return (
    <div
      className={cn(
        "grid min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border bg-card p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]",
        isMissing && "border-destructive/30 bg-destructive/5",
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted/40">
        <FileText className={cn("size-4 text-muted-foreground", isMissing && "text-destructive")} />
      </span>
      <button
        type="button"
        className="min-w-0 overflow-hidden text-left"
        disabled={!onEditTodo}
        onClick={() => onEditTodo?.(todo)}
        title="Edit todo"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium">{todo.title}</span>
          {isMissing && (
            <Badge variant="secondary" className="shrink-0 border border-destructive/30 bg-destructive/10 text-destructive">
              Missing
            </Badge>
          )}
        </span>
        <span className="mt-1 block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
          {todoSubtitle(todo)}
        </span>
      </button>
      <Button
        type="button"
        size="sm"
        className="col-start-2 row-start-2 w-fit sm:col-start-auto sm:row-start-auto"
        onClick={() => onOpenTodo?.(todo)}
        disabled={!canCreateTask}
      >
        <Plus />
        Create task
      </Button>
      <span className="col-start-3 row-start-1 inline-flex items-center sm:col-start-auto sm:row-start-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Edit todo"
              disabled={!onEditTodo}
              onClick={() => onEditTodo?.(todo)}
            >
              <Pencil />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Edit todo</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Delete todo"
              disabled={!onDeleteTodo}
              onClick={() => onDeleteTodo?.(todo)}
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete todo</TooltipContent>
        </Tooltip>
      </span>
    </div>
  );
}

function todoSubtitle(todo) {
  if (todo.kind === "file" && todo.fileMissing) {
    return [todo.fileName, "File missing", todo.filePath].filter(Boolean).join(" · ");
  }
  if (todo.kind === "file") {
    return [todo.fileName, todo.filePath, todo.mimeType].filter(Boolean).join(" · ") || "File";
  }
  return todo.rawText.substring(todo.title.length) || todo.title;
}

export function RecentDirectoryFilesList({
  files = [],
  onOpenFile,
  onRefresh,
  emptyText = "No latest files.",
}) {
  return (
    <div className="grid gap-2">
      {files.length === 0 ? (
        <EmptyState text={emptyText} />
      ) : (
        <div className="flex flex-col gap-2">
          {files.slice(0, 5).map((file) => (
            <RecentDirectoryFileItem key={file.path} file={file} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  );
}

function RecentDirectoryFileItem({ file, onOpenFile }) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-3 rounded-md border bg-card p-3">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden text-left transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!onOpenFile}
        onClick={() => onOpenFile?.(file)}
        title="Create task"
      >
        <RecentFilePreview file={file} />
        <span className="min-w-0 flex-1 overflow-hidden">
          <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium">{file.name}</span>
          <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
            {file.directoryName} · {file.relativePath || file.path}
          </span>
        </span>
      </button>
      <Button
        type="button"
        size="sm"
        className="shrink-0"
        onClick={() => onOpenFile?.(file)}
        disabled={!onOpenFile}
      >
        <Plus />
        Create task
      </Button>
    </div>
  );
}

function RecentFilePreview({ file }) {
  const [failed, setFailed] = useState(false);
  const isImage = isSupportedOcrFile({ name: file.name || file.path, mimeType: "" });

  if (isImage && !failed) {
    return (
      <img
        className="size-12 shrink-0 rounded-md border object-cover"
        src={convertFileSrc(file.path)}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span className="flex size-12 shrink-0 items-center justify-center rounded-md border bg-muted/40">
      <FileText className="size-4 text-muted-foreground" />
    </span>
  );
}
