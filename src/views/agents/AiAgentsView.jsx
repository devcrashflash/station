import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Archive,
  ArchiveRestore,
  Bot,
  CalendarDays,
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  Ellipsis,
  ListFilter,
  LoaderCircle,
  RefreshCw,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";

import { CheckboxFilterCard } from "@/components/common/CheckboxFilterCard";
import { BurningTreeIcon } from "@/components/common/BurningTreeIcon";
import { EmptyState } from "@/components/common/EmptyState";
import { Panel } from "@/components/common/Panel";
import { SegmentedTabs } from "@/components/common/SegmentedTabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import {
  AI_SESSION_SOURCE_OPTIONS,
  AI_SESSION_WINDOWS,
  aiSessionArchiveActionLabel,
  aiSessionCommand,
  aiSessionCanArchive,
  aiSessionProviderBadgeClass,
  aiSessionProviderFilterEnabled,
  aiSessionProviderLabel,
  aiSessionPreferredOpenTarget,
  aiSessionRelativeTime,
  aiSessionSourceLabel,
  aiSessionState,
  aiSessionSourcesDisabled,
  aiSessionTreeState,
  aiSessionTreeWaitingForInput,
  aiSessionViewFilters,
  aiSessionViewFiltersDisabled,
  aiSessionWindowCounts,
  archivedAiSessionWindowCounts,
  filterAiSessions,
  filterArchivedAiSessionsByWindow,
  filterAiSessionsByWindow,
  formatAiSessionLastRefreshed,
  normalizeAiSessionSettings,
  sortArchivedAiSessions,
  sortAiSessions,
} from "@/lib/aiSessions";
import { workspaceTabsApi } from "@/lib/workspaceTabs";
import { cn } from "@/lib/utils";

async function openSessionInTerminal(session) {
  let createdTabId = null;
  const readyTabs = new Set();
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  const unlisten = await listen("terminal-startup-ready", ({ payload }) => {
    readyTabs.add(payload.tabId);
    if (payload.tabId === createdTabId) markReady();
  });
  try {
    const snapshot = await workspaceTabsApi.createTerminal(true, session.cwd || null);
    createdTabId = snapshot.activeTabId;
    if (readyTabs.has(createdTabId)) markReady();
    await ready;
    await workspaceTabsApi.completeTerminalStartupInput(createdTabId, aiSessionCommand(session));
  } finally {
    unlisten();
  }
}

export function AiAgentsView({
  settings,
  result,
  loading,
  activeViewRequestKey = 0,
  onRefresh,
  onNotice,
}) {
  const [hours, setHours] = useState(24);
  const [sessionView, setSessionView] = useState("active");
  const [sourceFilters, setSourceFilters] = useState(() => aiSessionViewFilters(settings));
  const [displayNow, setDisplayNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(() => new Set());
  const [busySessionKey, setBusySessionKey] = useState(null);
  const normalizedSettings = useMemo(() => normalizeAiSessionSettings(settings), [settings]);

  useEffect(() => {
    setSourceFilters(aiSessionViewFilters(settings));
  }, [settings]);

  useEffect(() => {
    if (activeViewRequestKey > 0) setSessionView("active");
  }, [activeViewRequestKey]);

  useEffect(() => {
    const interval = window.setInterval(() => setDisplayNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    setDisplayNow(result.loadedAt);
  }, [result.loadedAt]);

  const sourceFilteredSessions = useMemo(
    () => filterAiSessions(result.sessions, sourceFilters),
    [result.sessions, sourceFilters],
  );
  const sessions = useMemo(
    () => sortAiSessions(filterAiSessionsByWindow(
      sourceFilteredSessions,
      hours,
      result.loadedAt,
    )),
    [hours, result.loadedAt, sourceFilteredSessions],
  );
  const sourceFilteredArchivedSessions = useMemo(
    () => filterAiSessions(result.archivedSessions, sourceFilters),
    [result.archivedSessions, sourceFilters],
  );
  const archivedSessions = useMemo(
    () => sortArchivedAiSessions(filterArchivedAiSessionsByWindow(
      sourceFilteredArchivedSessions,
      hours,
      result.loadedAt,
    )),
    [hours, result.loadedAt, sourceFilteredArchivedSessions],
  );
  const activeWindowCounts = useMemo(
    () => aiSessionWindowCounts(result.sessions, sourceFilters, result.loadedAt),
    [result.loadedAt, result.sessions, sourceFilters],
  );
  const archivedWindowCounts = useMemo(
    () => archivedAiSessionWindowCounts(result.archivedSessions, sourceFilters, result.loadedAt),
    [result.archivedSessions, result.loadedAt, sourceFilters],
  );
  const windowCounts = sessionView === "archived" ? archivedWindowCounts : activeWindowCounts;
  const warnings = useMemo(
    () => result.warnings.filter((warning) => (
      aiSessionProviderFilterEnabled(warning.provider, sourceFilters)
    )),
    [result.warnings, sourceFilters],
  );
  const timeTabs = useMemo(() => AI_SESSION_WINDOWS.map((option) => ({
    id: String(option.value),
    label: option.label,
    count: windowCounts[option.value],
    icon: option.value === 24
      ? Clock3
      : option.value === 24 * 7
        ? CalendarRange
        : CalendarDays,
  })), [windowCounts]);
  const timeWindowLabel = AI_SESSION_WINDOWS.find((option) => option.value === hours)?.label || "selected period";
  const lastRefreshedText = formatAiSessionLastRefreshed(result.lastRefreshedAt);
  const visibleSessions = sessionView === "archived" ? archivedSessions : sessions;
  const sessionViewTabs = [
    { id: "active", label: "Active", count: sourceFilteredSessions.length, icon: Bot },
    { id: "archived", label: "Archived", count: sourceFilteredArchivedSessions.length, icon: Archive },
  ];

  async function resume(session, target) {
    const key = `${session.provider}:${session.id}`;
    setBusySessionKey(key);
    try {
      if (session.archivedAt) {
        await api.restoreAiSession({ provider: session.provider, sessionId: session.id });
        await onRefresh({ quiet: true });
      }
      if (target === "desktop") await api.openAiSessionDesktop({ provider: session.provider, sessionId: session.id });
      else await openSessionInTerminal(session);
    } catch (error) {
      onNotice(error?.message || String(error));
    } finally {
      setBusySessionKey(null);
    }
  }

  async function archiveSession(session) {
    const key = `${session.provider}:${session.id}`;
    setBusySessionKey(key);
    try {
      await api.archiveAiSession({ session });
      await onRefresh({ quiet: true });
    } catch (error) {
      onNotice(error?.message || String(error));
    } finally {
      setBusySessionKey(null);
    }
  }

  async function restoreSession(session) {
    const key = `${session.provider}:${session.id}`;
    setBusySessionKey(key);
    try {
      await api.restoreAiSession({ provider: session.provider, sessionId: session.id });
      await onRefresh({ quiet: true });
    } catch (error) {
      onNotice(error?.message || String(error));
    } finally {
      setBusySessionKey(null);
    }
  }

  return (
    <div className="grid flex-1 gap-6 overflow-y-auto p-6 [scrollbar-gutter:stable] lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="flex min-w-0 flex-col gap-6">
        {warnings.map((warning) => (
          <div key={warning.provider} className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span><strong>{aiSessionProviderLabel(warning.provider)}:</strong> {warning.message}</span>
          </div>
        ))}

        <Panel title="Sessions" icon={Bot}>
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <SegmentedTabs
                  tabs={sessionViewTabs}
                  value={sessionView}
                  onValueChange={setSessionView}
                  ariaLabel="AI session view"
                />
                <SegmentedTabs
                  tabs={timeTabs}
                  value={String(hours)}
                  onValueChange={(value) => setHours(Number(value))}
                  ariaLabel={`${sessionView === "archived" ? "Archived AI session" : "AI session"} time window`}
                />
              </div>
              <div className="flex items-center gap-2">
                {lastRefreshedText && (
                  <span className="text-xs text-muted-foreground">{lastRefreshedText}</span>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      aria-label="Refresh AI sessions"
                      disabled={loading}
                      onClick={() => onRefresh()}
                    >
                      <RefreshCw className={cn(loading && "animate-spin")} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Refresh AI sessions</TooltipContent>
                </Tooltip>
              </div>
            </div>

            {aiSessionSourcesDisabled(settings) ? (
              <EmptyState text="All AI session sources are disabled. Enable a source in AI Sessions settings to display sessions." />
            ) : aiSessionViewFiltersDisabled(sourceFilters) ? (
              <EmptyState text="No AI session sources are selected. Select at least one source to display sessions." />
            ) : loading && visibleSessions.length === 0 ? (
              <div className="flex min-h-56 items-center justify-center text-muted-foreground">
                <LoaderCircle className="mr-2 animate-spin" /> Loading AI sessions…
              </div>
            ) : visibleSessions.length === 0 ? (
              <EmptyState text={sessionView === "archived"
                ? result.archivedSessions.length === 0
                  ? "No AI sessions have been archived in Station yet."
                  : sourceFilteredArchivedSessions.length === 0
                    ? "No archived AI sessions match the selected sources."
                    : `No AI sessions were archived in the last ${timeWindowLabel}.`
                : `No AI sessions match the selected sources in the last ${timeWindowLabel}.`} />
            ) : (
              <div className="overflow-hidden rounded-md border">
                {visibleSessions.map((session) => (
                  <SessionRow
                    key={`${session.provider}:${session.id}`}
                    session={session}
                    now={displayNow}
                    expanded={expanded.has(session.id)}
                    archived={sessionView === "archived"}
                    busy={busySessionKey === `${session.provider}:${session.id}`}
                    onToggle={() => setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(session.id)) next.delete(session.id); else next.add(session.id);
                      return next;
                    })}
                    onResume={(target) => resume(session, target)}
                    onArchive={() => archiveSession(session)}
                    onRestore={() => restoreSession(session)}
                  />
                ))}
              </div>
            )}
          </div>
        </Panel>
      </section>

      <aside className="min-w-0">
        <Panel title="Filters" icon={ListFilter}>
          <AiSessionFilters
            settings={normalizedSettings}
            filters={sourceFilters}
            onChange={setSourceFilters}
          />
        </Panel>
      </aside>
    </div>
  );
}

function AiSessionFilters({ settings, filters, onChange }) {
  const enabledOptions = AI_SESSION_SOURCE_OPTIONS.filter(({ key }) => settings[key]);
  const selectedCount = enabledOptions.filter(({ key }) => filters[key]).length;
  const hasActiveFilters = selectedCount < enabledOptions.length;

  function reset() {
    onChange(aiSessionViewFilters(settings));
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Sources</p>
          <p className="text-xs text-muted-foreground">
            {selectedCount} of {enabledOptions.length} selected
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!hasActiveFilters}
          onClick={reset}
        >
          Reset
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {AI_SESSION_SOURCE_OPTIONS.map((option) => {
          const globallyEnabled = settings[option.key];
          const provider = aiSessionProviderLabel(option.provider);
          return (
            <CheckboxFilterCard
              key={option.key}
              label={option.label}
              description={globallyEnabled
                ? provider
                : `${provider} · Disabled in AI Sessions settings`}
              checked={globallyEnabled && filters[option.key] === true}
              disabled={!globallyEnabled}
              onCheckedChange={(checked) => onChange((current) => ({
                ...current,
                [option.key]: checked === true,
              }))}
            />
          );
        })}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  now,
  expanded,
  archived,
  busy,
  onToggle,
  onResume,
  onArchive,
  onRestore,
}) {
  const hasChildren = session.children?.length > 0;
  const waitingForInput = aiSessionTreeWaitingForInput(session);
  const state = aiSessionTreeState(session, now);
  const providerSyncedArchive = session.archiveScope === "provider";
  const actionLabel = aiSessionArchiveActionLabel(session, archived);
  const preferredOpenTarget = aiSessionPreferredOpenTarget(session);
  const hasBothOpenTargets = session.openTargets?.includes("terminal")
    && session.openTargets.includes("desktop");
  return (
    <div className="border-b last:border-b-0">
      <div className="flex min-w-0 items-center gap-3 p-4">
        {hasChildren && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={expanded ? "Hide subagents" : "Show subagents"}
            title={expanded ? "Hide subagents" : "Show subagents"}
            onClick={onToggle}
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </Button>
        )}
        <SessionStateRobot state={state} className="size-5" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate font-medium">{session.title}</p>
            <Badge
              variant="outline"
              className={cn("shrink-0", aiSessionProviderBadgeClass(session.provider))}
            >
              {aiSessionSourceLabel(session)}
            </Badge>
            {archived && !providerSyncedArchive && (
              <Badge variant="outline" className="shrink-0 text-muted-foreground">
                Station only
              </Badge>
            )}
            {waitingForInput && <WaitingForInputBadge />}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={session.cwd || undefined}>
            {session.cwd || "Unknown working directory"} · {aiSessionRelativeTime(session.updatedAt)}
            {archived && session.archivedAt ? ` · Archived ${aiSessionRelativeTime(session.archivedAt)}` : ""}
            {hasChildren ? ` · ${session.children.length} subagent${session.children.length === 1 ? "" : "s"}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {archived ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={actionLabel}
                  disabled={busy}
                  onClick={onRestore}
                >
                  {busy ? <LoaderCircle className="animate-spin" /> : <ArchiveRestore />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{actionLabel}</TooltipContent>
            </Tooltip>
          ) : aiSessionCanArchive(session, now) ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={actionLabel}
                  disabled={busy}
                  onClick={onArchive}
                >
                  {busy ? <LoaderCircle className="animate-spin" /> : <Archive />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{actionLabel}</TooltipContent>
            </Tooltip>
          ) : null}
          {hasBothOpenTargets && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  aria-label="Choose resume destination"
                  disabled={busy}
                >
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {session.openTargets.includes("terminal") && (
                  <DropdownMenuItem onSelect={() => onResume("terminal")}>
                    <SquareTerminal />
                    Resume in CLI
                  </DropdownMenuItem>
                )}
                {session.openTargets.includes("desktop") && (
                  <DropdownMenuItem onSelect={() => onResume("desktop")}>
                    <ExternalLink />
                    Resume in Desktop
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {preferredOpenTarget && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onResume(preferredOpenTarget)}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : null}
              Resume
            </Button>
          )}
        </div>
      </div>
      {expanded && hasChildren && (
        <div className="border-t bg-muted/20 py-1 pl-12 pr-4">
          {session.children.map((child) => (
            <div key={child.id} className="flex min-w-0 items-center gap-3 border-b py-3 last:border-b-0">
              <SessionStateRobot state={aiSessionState(child, now)} className="size-4" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <p className="truncate text-sm font-medium">{child.title}</p>
                  {child.waitingForInput && <WaitingForInputBadge />}
                </div>
                <p className="truncate text-xs text-muted-foreground">Subagent · {aiSessionRelativeTime(child.updatedAt)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionStateRobot({ state, className }) {
  if (state === "running") {
    return <RunningSessionIcon className={className} />;
  }

  const statePresentation = {
    waiting: {
      label: "Waiting for you",
      className: "text-amber-600 dark:text-amber-400",
    },
    done: {
      label: "Done",
      className: "text-green-600 dark:text-green-400",
    },
    idle: {
      label: "Idle",
      className: "text-muted-foreground",
    },
  }[state];

  return (
    <Bot
      role="img"
      aria-label={statePresentation.label}
      className={cn("shrink-0", className, statePresentation.className)}
    />
  );
}

function RunningSessionIcon({ className }) {
  return (
    <span
      role="img"
      aria-label="Running"
      className={cn("relative inline-block shrink-0", className)}
    >
      <span
        aria-hidden="true"
        className="running-session-icon__robot absolute inset-0"
      >
        <Bot className="size-full animate-spin text-blue-600 dark:text-blue-400" />
      </span>
      <span
        aria-hidden="true"
        className="running-session-icon__tree absolute inset-0"
      >
        <BurningTreeIcon className="size-full" />
      </span>
    </span>
  );
}

function WaitingForInputBadge() {
  return (
    <Badge
      variant="outline"
      className="shrink-0 border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    >
      Waiting for you
    </Badge>
  );
}
