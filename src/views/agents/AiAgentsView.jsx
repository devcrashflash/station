import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Bot, ChevronDown, ChevronRight, ExternalLink, LoaderCircle, RefreshCw, SquareTerminal, TriangleAlert } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import {
  AI_SESSION_WINDOWS,
  aiSessionCommand,
  aiSessionProviderLabel,
  aiSessionRelativeTime,
  sortAiSessions,
} from "@/lib/aiSessions";
import { workspaceTabsApi } from "@/lib/workspaceTabs";
import { cn } from "@/lib/utils";

const REFRESH_INTERVAL_MS = 30_000;

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

export function AiAgentsView({ onNotice }) {
  const [hours, setHours] = useState(24);
  const [result, setResult] = useState({ sessions: [], warnings: [] });
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(() => new Set());
  const [choosingSessionId, setChoosingSessionId] = useState(null);
  const activeRun = useRef(0);

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    const run = activeRun.current + 1;
    activeRun.current = run;
    if (!quiet) setLoading(true);
    try {
      const next = await api.listAiSessions({ since: Date.now() - hours * 3_600_000 });
      if (activeRun.current === run) setResult(next);
    } catch (error) {
      if (activeRun.current === run) onNotice(error?.message || String(error));
    } finally {
      if (activeRun.current === run) setLoading(false);
    }
  }, [hours, onNotice]);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(() => refresh({ quiet: true }), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const sessions = useMemo(() => sortAiSessions(result.sessions), [result.sessions]);

  async function resume(session, target) {
    setChoosingSessionId(null);
    try {
      if (target === "desktop") await api.openAiSessionDesktop({ provider: session.provider, sessionId: session.id });
      else await openSessionInTerminal(session);
    } catch (error) {
      onNotice(error?.message || String(error));
    }
  }

  function requestResume(session) {
    if (session.openTargets.length === 1) {
      resume(session, session.openTargets[0]);
    } else {
      setChoosingSessionId((current) => current === session.id ? null : session.id);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto grid max-w-5xl gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {AI_SESSION_WINDOWS.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={hours === option.value ? "secondary" : "ghost"}
                onClick={() => setHours(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => refresh()}>
            <RefreshCw className={cn(loading && "animate-spin")} />
            Refresh
          </Button>
        </div>

        {result.warnings.map((warning) => (
          <div key={warning.provider} className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span><strong>{aiSessionProviderLabel(warning.provider)}:</strong> {warning.message}</span>
          </div>
        ))}

        {loading && sessions.length === 0 ? (
          <div className="flex min-h-56 items-center justify-center text-muted-foreground">
            <LoaderCircle className="mr-2 animate-spin" /> Loading AI sessions…
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState text={`No Codex or Claude sessions were updated in the last ${hours === 24 ? "24 hours" : `${hours / 24} days`}.`} />
        ) : (
          <div className="overflow-hidden rounded-md border">
            {sessions.map((session) => (
              <SessionRow
                key={`${session.provider}:${session.id}`}
                session={session}
                expanded={expanded.has(session.id)}
                choosing={choosingSessionId === session.id}
                onToggle={() => setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(session.id)) next.delete(session.id); else next.add(session.id);
                  return next;
                })}
                onRequestResume={() => requestResume(session)}
                onResume={(target) => resume(session, target)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionRow({ session, expanded, choosing, onToggle, onRequestResume, onResume }) {
  const hasChildren = session.children?.length > 0;
  return (
    <div className="border-b last:border-b-0">
      <div className="flex min-w-0 items-center gap-3 p-4">
        <Button type="button" size="icon-sm" variant="ghost" disabled={!hasChildren} title={hasChildren ? "Show subagents" : "No subagents"} onClick={onToggle}>
          {hasChildren ? expanded ? <ChevronDown /> : <ChevronRight /> : <span className="size-4" />}
        </Button>
        <Bot className={cn("size-5 shrink-0", session.provider === "claude" ? "text-orange-600" : "text-emerald-600")} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate font-medium">{session.title}</p>
            <Badge variant="secondary">{aiSessionProviderLabel(session.provider)}</Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={session.cwd || undefined}>
            {session.cwd || "Unknown working directory"} · {aiSessionRelativeTime(session.updatedAt)}
            {hasChildren ? ` · ${session.children.length} subagent${session.children.length === 1 ? "" : "s"}` : ""}
          </p>
        </div>
        {session.openTargets?.length > 0 && (
          <div className="relative">
            <Button type="button" size="sm" variant="outline" onClick={onRequestResume}>Resume</Button>
            {choosing && (
              <div className="absolute right-0 top-full z-20 mt-1 grid w-44 gap-1 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                {session.openTargets.includes("terminal") && <Button type="button" size="sm" variant="ghost" className="justify-start" onClick={() => onResume("terminal")}><SquareTerminal /> Terminal</Button>}
                {session.openTargets.includes("desktop") && <Button type="button" size="sm" variant="ghost" className="justify-start" onClick={() => onResume("desktop")}><ExternalLink /> Desktop app</Button>}
              </div>
            )}
          </div>
        )}
      </div>
      {expanded && hasChildren && (
        <div className="border-t bg-muted/20 py-1 pl-16 pr-4">
          {session.children.map((child) => (
            <div key={child.id} className="flex min-w-0 items-center gap-3 border-b py-3 last:border-b-0">
              <Bot className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{child.title}</p>
                <p className="truncate text-xs text-muted-foreground">Subagent · {aiSessionRelativeTime(child.updatedAt)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
