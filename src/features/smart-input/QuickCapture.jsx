import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppWindow,
  Bot,
  CheckCircle2,
  LoaderCircle,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";

import { AiSessionStateIcon, WaitingForInputBadge } from "@/features/ai-sessions/AiSessionStateIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import {
  aiSessionPreferredOpenTarget,
  aiSessionProviderBadgeClass,
  aiSessionRelativeTime,
  aiSessionSourceLabel,
  aiSessionSourcesDisabled,
  aiSessionTreeState,
  aiSessionTreeWaitingForInput,
  normalizeAiSessionSettings,
} from "@/lib/aiSessions";
import {
  AI_SESSION_WAITING_STATUS_EVENT,
  AI_SESSION_WAITING_STATUS_REQUEST_EVENT,
  aiSessionWaitingStatusFromPayload,
} from "@/lib/aiSessionEvents";
import { isWorkspaceShortcut } from "@/lib/workspaceTabs";
import { shortcutModifier } from "@/lib/keyboardShortcut";
import { quickCaptureTitle } from "@/lib/quickCapture";
import {
  filterPrograms,
  highlightedProgramId as resolvedHighlightedProgramId,
  movedProgramId,
  numberedProgram,
} from "@/lib/programs";
import {
  SMART_OVERLAY_AGENT_WINDOW_HOURS,
  smartOverlayAgentSessions,
  smartOverlayHighlightedId,
  smartOverlayMovedId,
  smartOverlayNumberSession,
  smartOverlaySessionKey,
} from "@/lib/smartOverlay";
import { cn } from "@/lib/utils";

const EMPTY_AGENT_RESULT = { sessions: [], loadedAt: Date.now() };

export function QuickCapture() {
  const [activeTab, setActiveTab] = useState("inbox");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [agentSettings, setAgentSettings] = useState(null);
  const [agentResult, setAgentResult] = useState(EMPTY_AGENT_RESULT);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentSearchQuery, setAgentSearchQuery] = useState("");
  const [highlightedAgentId, setHighlightedAgentId] = useState(null);
  const [busyAgentId, setBusyAgentId] = useState(null);
  const [programs, setPrograms] = useState([]);
  const [programsLoading, setProgramsLoading] = useState(false);
  const [programSearchQuery, setProgramSearchQuery] = useState("");
  const [highlightedProgramId, setHighlightedProgramId] = useState(null);
  const [busyProgramId, setBusyProgramId] = useState(null);
  const [hasWaitingAiSession, setHasWaitingAiSession] = useState(false);
  const inputRef = useRef(null);
  const agentSearchInputRef = useRef(null);
  const programSearchInputRef = useRef(null);
  const optionRefs = useRef(new Map());
  const programOptionRefs = useRef(new Map());
  const agentLoadRun = useRef(0);
  const programLoadRun = useRef(0);
  const canSubmit = value.trim().length > 0 && !isSaving;
  const modifier = shortcutModifier();

  const visibleAgents = useMemo(() => smartOverlayAgentSessions(
    agentResult.sessions,
    agentSettings,
    agentSearchQuery,
    agentResult.loadedAt,
  ), [agentResult, agentSettings, agentSearchQuery]);
  const visiblePrograms = useMemo(
    () => filterPrograms(programs, programSearchQuery),
    [programSearchQuery, programs],
  );

  const loadAgents = useCallback(async () => {
    const run = agentLoadRun.current + 1;
    agentLoadRun.current = run;
    setAgentsLoading(true);
    try {
      const settings = normalizeAiSessionSettings(await api.listAiSessionSettings());
      const requestedAt = Date.now();
      const result = await api.listAiSessions({
        since: requestedAt - SMART_OVERLAY_AGENT_WINDOW_HOURS * 3_600_000,
        settings,
      });
      if (agentLoadRun.current !== run) return;
      setAgentSettings(settings);
      setAgentResult({ ...result, loadedAt: Date.now() });
    } catch (loadError) {
      if (agentLoadRun.current === run) setError(loadError?.message || String(loadError));
    } finally {
      if (agentLoadRun.current === run) setAgentsLoading(false);
    }
  }, []);

  const loadPrograms = useCallback(async () => {
    const run = programLoadRun.current + 1;
    programLoadRun.current = run;
    setProgramsLoading(true);
    try {
      const result = await api.listPrograms();
      if (programLoadRun.current === run) setPrograms(result);
    } catch (loadError) {
      if (programLoadRun.current === run) setError(loadError?.message || String(loadError));
    } finally {
      if (programLoadRun.current === run) setProgramsLoading(false);
    }
  }, []);

  const activateTab = useCallback((tab, { refresh = true } = {}) => {
    setActiveTab(tab);
    setError("");
    if (tab === "agents") {
      setAgentSearchQuery("");
      if (refresh) loadAgents();
    } else if (tab === "programs") {
      setProgramSearchQuery("");
      if (refresh) loadPrograms();
    }
    api.resizeQuickCapture({ surface: tab }).catch((resizeError) => {
      setError(resizeError?.message || String(resizeError));
    });
    window.requestAnimationFrame(() => {
      const target = tab === "inbox"
        ? inputRef
        : tab === "agents" ? agentSearchInputRef : programSearchInputRef;
      target.current?.focus({ preventScroll: true });
    });
  }, [loadAgents, loadPrograms]);

  useEffect(() => {
    const currentWindow = getCurrentWindow();
    let active = true;
    const unlisteners = [];

    function handleFocusChanged(focused) {
      if (focused) {
        activateTab("inbox", { refresh: false });
        const focusInput = () => inputRef.current?.focus({ preventScroll: true });
        window.requestAnimationFrame(focusInput);
        window.setTimeout(focusInput, 50);
      } else {
        setActiveTab("inbox");
        setError("");
        agentLoadRun.current += 1;
        programLoadRun.current += 1;
      }
    }

    currentWindow.onFocusChanged(({ payload: focused }) => handleFocusChanged(focused))
      .then((cleanup) => {
        if (!active) cleanup(); else unlisteners.push(cleanup);
      })
      .catch((focusError) => {
        if (active) setError(focusError?.message || String(focusError));
      });

    currentWindow.listen("quick-capture-focus-changed", ({ payload: focused }) => {
      handleFocusChanged(Boolean(focused));
    }).then((cleanup) => {
      if (!active) cleanup(); else unlisteners.push(cleanup);
    }).catch((focusError) => {
      if (active) setError(focusError?.message || String(focusError));
    });

    activateTab("inbox", { refresh: false });
    return () => {
      active = false;
      unlisteners.forEach((cleanup) => cleanup());
    };
  }, [activateTab]);

  useEffect(() => {
    setHighlightedAgentId((currentId) => smartOverlayHighlightedId(visibleAgents, currentId));
  }, [visibleAgents]);

  useEffect(() => {
    optionRefs.current.get(highlightedAgentId)?.scrollIntoView({ block: "nearest" });
  }, [highlightedAgentId]);

  useEffect(() => {
    setHighlightedProgramId((currentId) => resolvedHighlightedProgramId(visiblePrograms, currentId));
  }, [visiblePrograms]);

  useEffect(() => {
    programOptionRefs.current.get(highlightedProgramId)?.scrollIntoView({ block: "nearest" });
  }, [highlightedProgramId]);

  useEffect(() => {
    let disposed = false;
    let unlisten = null;
    listen(AI_SESSION_WAITING_STATUS_EVENT, ({ payload }) => {
      if (!disposed) {
        setHasWaitingAiSession(aiSessionWaitingStatusFromPayload(payload));
      }
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;
      emit(AI_SESSION_WAITING_STATUS_REQUEST_EVENT).catch(console.error);
    }).catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    function handleWindowKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        api.hideQuickCapture({ restoreFocus: true }).catch((hideError) => {
          setError(hideError?.message || String(hideError));
        });
      } else if (isWorkspaceShortcut(event, "i")) {
        event.preventDefault();
        activateTab("inbox", { refresh: false });
      } else if (isWorkspaceShortcut(event, "b")) {
        event.preventDefault();
        activateTab("agents");
      } else if (isWorkspaceShortcut(event, "s")) {
        event.preventDefault();
        activateTab("programs");
      }
    }

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [activateTab]);

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

  function handleInboxKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function resumeAgent(session) {
    const target = aiSessionPreferredOpenTarget(session);
    if (!target) {
      setError("This AI agent cannot be opened from Station.");
      return;
    }

    setError("");
    setBusyAgentId(smartOverlaySessionKey(session));
    try {
      if (target === "desktop") {
        await api.openAiSessionDesktop({ provider: session.provider, sessionId: session.id });
      } else {
        await api.openAiSessionTerminal({
          provider: session.provider,
          sessionId: session.id,
          cwd: session.cwd || null,
        });
      }
      await hide(false);
    } catch (resumeError) {
      setError(resumeError?.message || String(resumeError));
    } finally {
      setBusyAgentId(null);
    }
  }

  function selectHighlightedAgent() {
    const session = visibleAgents.find((agent) => (
      smartOverlaySessionKey(agent) === highlightedAgentId
    ));
    if (session) resumeAgent(session);
  }

  function handleAgentKeyDown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedAgentId((currentId) => smartOverlayMovedId(
        visibleAgents,
        currentId,
        event.key === "ArrowUp" ? -1 : 1,
      ));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      selectHighlightedAgent();
      return;
    }
    const numberedSession = smartOverlayNumberSession(visibleAgents, event.key, agentSearchQuery);
    if (numberedSession && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      resumeAgent(numberedSession);
    }
  }

  async function openProgram(program) {
    setError("");
    setBusyProgramId(program.id);
    try {
      await api.launchProgram({ id: program.id });
      await hide(false);
    } catch (launchError) {
      setError(launchError?.message || String(launchError));
    } finally {
      setBusyProgramId(null);
    }
  }

  function selectHighlightedProgram() {
    const program = visiblePrograms.find(({ id }) => id === highlightedProgramId);
    if (program) openProgram(program);
  }

  function handleProgramKeyDown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedProgramId((currentId) => movedProgramId(
        visiblePrograms,
        currentId,
        event.key === "ArrowUp" ? -1 : 1,
      ));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      selectHighlightedProgram();
      return;
    }
    const selected = numberedProgram(visiblePrograms, event.key, programSearchQuery);
    if (selected && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      openProgram(selected);
    }
  }

  return (
    <main className="flex h-screen items-center overflow-hidden bg-transparent px-6 py-3 text-foreground">
      <section className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border/80 bg-background/95 shadow-[0_3px_10px_-4px_rgba(0,0,0,0.32),0_10px_28px_-14px_rgba(0,0,0,0.28)] backdrop-blur-xl">
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-2" role="tablist" aria-label="Smart overlay">
          <OverlayTab
            active={activeTab === "inbox"}
            icon={Sparkles}
            label="Inbox"
            shortcut={`${modifier}I`}
            onClick={() => activateTab("inbox", { refresh: false })}
          />
          <OverlayTab
            active={activeTab === "agents"}
            icon={Bot}
            label="AI Agents"
            shortcut={`${modifier}B`}
            waitingForInput={hasWaitingAiSession}
            onClick={() => activateTab("agents")}
          />
          <OverlayTab
            active={activeTab === "programs"}
            icon={AppWindow}
            label="Programs"
            shortcut={`${modifier}S`}
            onClick={() => activateTab("programs")}
          />
        </div>

        {activeTab === "inbox" ? (
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
            <div className="flex min-h-0 flex-1 items-start gap-3 px-4 py-3">
              {isSaved ? (
                <div className="flex flex-1 items-center justify-center gap-2 self-stretch text-sm font-medium">
                  <CheckCircle2 className="size-5 text-emerald-600" aria-hidden="true" />
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
                    onKeyDown={handleInboxKeyDown}
                  />
                  <Button className="mt-1" type="submit" size="icon" disabled={!canSubmit} aria-label="Add to Smart Inbox">
                    {isSaving ? <LoaderCircle className="animate-spin" /> : <Plus />}
                  </Button>
                </>
              )}
            </div>
            <OverlayFooter error={error} hint="Shift+Enter for a new line" />
          </form>
        ) : activeTab === "agents" ? (
          <div className="flex min-h-0 flex-1 flex-col" role="tabpanel" aria-label="AI Agents">
            <div className="relative shrink-0 px-3 py-3">
              <Search className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={agentSearchInputRef}
                className="h-10 pl-9"
                type="search"
                value={agentSearchQuery}
                placeholder="Search AI agents"
                aria-label="Search AI agents"
                aria-controls="smart-overlay-agent-list"
                aria-activedescendant={highlightedAgentId ? `smart-overlay-agent-${highlightedAgentId}` : undefined}
                onChange={(event) => setAgentSearchQuery(event.target.value)}
                onKeyDown={handleAgentKeyDown}
              />
            </div>
            <div id="smart-overlay-agent-list" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" role="listbox" aria-label="AI agents updated in the last 24 hours">
              <AgentList
                sessions={visibleAgents}
                allSessionCount={agentResult.sessions.length}
                settings={agentSettings}
                loading={agentsLoading}
                query={agentSearchQuery}
                highlightedId={highlightedAgentId}
                busyId={busyAgentId}
                optionRefs={optionRefs}
                onHighlight={setHighlightedAgentId}
                onSelect={resumeAgent}
              />
            </div>
            <OverlayFooter error={error} hint="↑ ↓ navigate · Enter open · 1–9 select" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col" role="tabpanel" aria-label="Programs">
            <div className="relative shrink-0 px-3 py-3">
              <Search className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={programSearchInputRef}
                className="h-10 pl-9"
                type="search"
                value={programSearchQuery}
                placeholder="Search programs"
                aria-label="Search programs"
                aria-controls="quick-overlay-program-list"
                aria-activedescendant={highlightedProgramId ? `quick-overlay-program-${highlightedProgramId}` : undefined}
                onChange={(event) => setProgramSearchQuery(event.target.value)}
                onKeyDown={handleProgramKeyDown}
              />
            </div>
            <div id="quick-overlay-program-list" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" role="listbox" aria-label="Installed programs">
              <ProgramList
                programs={visiblePrograms}
                allProgramCount={programs.length}
                loading={programsLoading}
                query={programSearchQuery}
                highlightedId={highlightedProgramId}
                busyId={busyProgramId}
                optionRefs={programOptionRefs}
                onHighlight={setHighlightedProgramId}
                onSelect={openProgram}
              />
            </div>
            <OverlayFooter error={error} hint="↑ ↓ navigate · Enter open · 1–9 select" />
          </div>
        )}
      </section>
    </main>
  );
}

function OverlayTab({ active, icon: Icon, label, shortcut, waitingForInput = false, onClick }) {
  return (
    <button
      className={cn(
        "flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors",
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
      type="button"
      role="tab"
      aria-selected={active}
      title={waitingForInput ? `${label} — waiting for you` : undefined}
      onClick={onClick}
    >
      <Icon className="size-4" />
      {label}
      {waitingForInput && (
        <>
          <span className="size-1.5 shrink-0 rounded-full bg-orange-500" aria-hidden="true" />
          <span className="sr-only">Waiting for you</span>
        </>
      )}
      <Kbd>{shortcut}</Kbd>
    </button>
  );
}

function AgentList({
  sessions,
  allSessionCount,
  settings,
  loading,
  query,
  highlightedId,
  busyId,
  optionRefs,
  onHighlight,
  onSelect,
}) {
  if (loading && allSessionCount === 0) {
    return <AgentEmpty><LoaderCircle className="size-5 animate-spin" /> Loading AI agents…</AgentEmpty>;
  }
  if (settings && aiSessionSourcesDisabled(settings)) {
    return <AgentEmpty>All AI agent sources are disabled in Settings.</AgentEmpty>;
  }
  if (sessions.length === 0) {
    return <AgentEmpty>{query ? "No AI agents match your search." : "No AI agents were active in the last 24 hours."}</AgentEmpty>;
  }

  return (
    <div className="overflow-hidden rounded-md border">
      {sessions.map((session, index) => {
        const sessionKey = smartOverlaySessionKey(session);
        const highlighted = sessionKey === highlightedId;
        const waiting = aiSessionTreeWaitingForInput(session);
        return (
          <button
            id={`smart-overlay-agent-${sessionKey}`}
            key={sessionKey}
            ref={(element) => {
              if (element) optionRefs.current.set(sessionKey, element);
              else optionRefs.current.delete(sessionKey);
            }}
            className={cn(
              "flex w-full items-center gap-3 border-b px-3 py-2.5 text-left outline-none last:border-b-0",
              highlighted ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
            )}
            type="button"
            role="option"
            aria-selected={highlighted}
            disabled={busyId === sessionKey}
            onClick={() => onSelect(session)}
            onMouseMove={() => onHighlight(sessionKey)}
          >
            {busyId === sessionKey
              ? <LoaderCircle className="size-5 shrink-0 animate-spin" />
              : <AiSessionStateIcon state={aiSessionTreeState(session)} className="size-5" />}
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">{session.title}</span>
                <Badge variant="outline" className={cn("shrink-0 text-[10px]", aiSessionProviderBadgeClass(session.provider))}>
                  {aiSessionSourceLabel(session)}
                </Badge>
                {waiting && <WaitingForInputBadge />}
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={session.cwd || undefined}>
                {session.cwd || "Unknown working directory"} · {aiSessionRelativeTime(session.updatedAt)}
                {session.children?.length ? ` · ${session.children.length} subagent${session.children.length === 1 ? "" : "s"}` : ""}
              </span>
            </span>
            {index < 9 && <Kbd>{index + 1}</Kbd>}
          </button>
        );
      })}
    </div>
  );
}

function AgentEmpty({ children }) {
  return <div className="flex min-h-48 items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">{children}</div>;
}

function ProgramList({
  programs,
  allProgramCount,
  loading,
  query,
  highlightedId,
  busyId,
  optionRefs,
  onHighlight,
  onSelect,
}) {
  if (loading && allProgramCount === 0) {
    return <AgentEmpty><LoaderCircle className="size-5 animate-spin" /> Loading programs…</AgentEmpty>;
  }
  if (programs.length === 0) {
    return <AgentEmpty>{query ? "No programs match your search." : "No installed programs were found."}</AgentEmpty>;
  }
  return (
    <div className="overflow-hidden rounded-md border">
      {programs.map((program, index) => {
        const highlighted = program.id === highlightedId;
        return (
          <button
            id={`quick-overlay-program-${program.id}`}
            key={program.id}
            ref={(element) => {
              if (element) optionRefs.current.set(program.id, element);
              else optionRefs.current.delete(program.id);
            }}
            className={cn(
              "flex w-full items-center gap-3 border-b px-3 py-2.5 text-left outline-none last:border-b-0",
              highlighted ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
            )}
            type="button"
            role="option"
            aria-selected={highlighted}
            disabled={busyId === program.id}
            onClick={() => onSelect(program)}
            onMouseMove={() => onHighlight(program.id)}
          >
            {busyId === program.id
              ? <LoaderCircle className="size-8 shrink-0 animate-spin p-1.5" />
              : <ProgramIcon program={program} />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{program.name}</span>
              {program.description && (
                <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={program.description}>
                  {program.description}
                </span>
              )}
            </span>
            {index < 9 && <Kbd>{index + 1}</Kbd>}
          </button>
        );
      })}
    </div>
  );
}

function ProgramIcon({ program }) {
  const containerRef = useRef(null);
  const [icon, setIcon] = useState(program.icon || null);

  useEffect(() => {
    setIcon(program.icon || null);
    if (program.icon) return undefined;
    const element = containerRef.current;
    if (!element) return undefined;
    let disposed = false;
    const load = () => {
      api.programIcon({ id: program.id })
        .then((result) => {
          if (!disposed && result) setIcon(result);
        })
        .catch(() => {});
    };
    if (typeof IntersectionObserver === "undefined") {
      load();
      return () => { disposed = true; };
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        load();
      }
    }, { rootMargin: "80px" });
    observer.observe(element);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [program.icon, program.id]);

  return (
    <span ref={containerRef} className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-md bg-muted">
      {icon
        ? <img className="size-8 object-contain" src={icon} alt="" />
        : <AppWindow className="size-5 text-muted-foreground" aria-hidden="true" />}
    </span>
  );
}

function OverlayFooter({ error, hint }) {
  return (
    <div className="flex min-h-8 shrink-0 items-center justify-between border-t border-border/60 px-4 text-xs text-muted-foreground">
      {error ? <p className="truncate text-destructive" role="alert">{error}</p> : <span>{hint}</span>}
      <span className="ml-auto flex items-center gap-1.5"><Kbd>Esc</Kbd> close</span>
    </div>
  );
}
