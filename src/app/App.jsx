import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LoaderCircle } from "lucide-react";

import { Modal } from "@/components/common/Modal";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ProjectDialog } from "@/features/projects/ProjectDialog";
import { ProjectPickerDialog } from "@/features/projects/ProjectPickerDialog";
import { ProjectSwitcherDialog } from "@/features/projects/ProjectSwitcherDialog";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { useCalendarData } from "@/features/calendar/useCalendarData";
import { useAiSessionMonitor } from "@/features/ai-sessions/useAiSessionMonitor";
import { TodoEditDialog } from "@/features/smart-input/TodoEditDialog";
import { UpdateDialog } from "@/features/updates/UpdateDialog";
import { useAppUpdater } from "@/features/updates/useAppUpdater";
import { api, toParsedPayload } from "@/lib/api";
import {
  activityLocation,
  agentsLocation,
  appHistoryShortcutDirection,
  createNavigationHistory,
  inboxLocation,
  moveNavigationHistory,
  projectLocation,
  pushNavigationHistory,
  replaceNavigationHistory,
  taskLocation,
  unavailableTaskFallback,
} from "@/lib/appHistory";
import {
  AI_SESSIONS_DESTINATION,
  APP_NAVIGATION_REQUEST_EVENT,
  PROJECT_SWITCHER_DESTINATION,
  SMART_INBOX_DESTINATION,
  appNavigationDestination,
  appNavigationReturnTabId,
  preserveProjectSwitcherReturnTabId,
} from "@/lib/appNavigation";
import { formatLocalDate } from "@/lib/activity";
import { DEFAULT_AI_SESSION_SETTINGS } from "@/lib/aiSessions";
import {
  EMAIL_DESKTOP_REQUIRED_MESSAGE,
  isDesktopApp,
  isSupportedOcrFile,
  OCR_DESKTOP_REQUIRED_MESSAGE,
  ocrTaskTitle,
  smartFileDropKind,
  textParsedPayload,
  UNSUPPORTED_OCR_FILE_MESSAGE,
} from "@/lib/ocr";
import { DEFAULT_PROJECT_COLOR } from "@/lib/projectAvatar";
import { quickCaptureTitle } from "@/lib/quickCapture";
import { parseSmartInboxTodo, parseSmartInput } from "@/lib/smartInputParser";
import { DEFAULT_TERMINAL_SHORTCUTS } from "@/lib/terminalShortcuts";
import { useTheme } from "@/lib/theme";
import { isWorkspaceShortcut, workspaceTabsApi } from "@/lib/workspaceTabs";
import { InboxView } from "@/views/inbox/InboxView";
import { ActivityView, useActivityData } from "@/views/activity/ActivityView";
import { ProjectWorkspaceView } from "@/views/projects/ProjectWorkspaceView";
import { TaskDetailView } from "@/views/tasks/TaskDetailView";
import { AiAgentsView } from "@/views/agents/AiAgentsView";
import { AppShell } from "./AppShell";

function dedupeProjects(projects) {
  return Array.from(new Map(projects.map((project) => [project.id, project])).values());
}

function upsertProject(projects, project) {
  return dedupeProjects([
    ...projects.filter((item) => item.id !== project.id),
    project,
  ]);
}

function fileDropName(fileDrop) {
  return fileDrop?.name || fileDrop?.file?.name || fileDrop?.path?.split(/[\\/]/).filter(Boolean).at(-1) || "file";
}

function filePathFromTodo(todo) {
  return todo?.filePath || "";
}

function fileDropFromTodo(todo) {
  const path = filePathFromTodo(todo);
  const isAppleMailMessage = path.trim().startsWith("message:");
  return {
    path: isAppleMailMessage ? null : path || null,
    messageUri: isAppleMailMessage ? path.trim() : null,
    name: todo.fileName || fileDropName({ path }) || "file",
    mimeType: todo.mimeType || "",
  };
}

function unsupportedFileTodoInput(todo) {
  const name = todo.fileName || fileDropName({ path: todo.filePath }) || "File";
  const detail = [todo.filePath, todo.mimeType].filter(Boolean).join("\n");
  return {
    input: detail || name,
    parsed: textParsedPayload(name),
  };
}

function FileDropPreview({ fileDrop }) {
  const [objectUrl, setObjectUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const name = fileDropName(fileDrop);
  const canPreview = isSupportedOcrFile({
    name: name || fileDrop?.path || "",
    mimeType: fileDrop?.mimeType || fileDrop?.file?.type || "",
  });

  useEffect(() => {
    setFailed(false);
  }, [fileDrop]);

  useEffect(() => {
    if (!fileDrop?.file || !canPreview) {
      setObjectUrl("");
      return undefined;
    }

    const nextObjectUrl = URL.createObjectURL(fileDrop.file);
    setObjectUrl(nextObjectUrl);
    return () => URL.revokeObjectURL(nextObjectUrl);
  }, [fileDrop, canPreview]);

  const src = fileDrop?.file ? objectUrl : fileDrop?.path ? convertFileSrc(fileDrop.path) : "";

  if (!canPreview || !src || failed) {
    return null;
  }

  return (
    <div className="overflow-hidden rounded-md border bg-muted/30">
      <img
        className="max-h-[55vh] w-full object-contain"
        src={src}
        alt={`Preview of ${name}`}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function App() {
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();
  const appUpdater = useAppUpdater();
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [resources, setResources] = useState([]);
  const [localResources, setLocalResources] = useState([]);
  const [connections, setConnections] = useState([]);
  const [shellReady, setShellReady] = useState(false);
  const [calendarAccounts, setCalendarAccounts] = useState([]);
  const [aiPrompts, setAiPrompts] = useState([]);
  const [directories, setDirectories] = useState([]);
  const [browserSettings, setBrowserSettings] = useState({
    detectedBrowserBundleId: null,
    browserBundleId: null,
  });
  const [commandSettings, setCommandSettings] = useState({
    reviewEnabled: true,
  });
  const [aiSessionSettings, setAiSessionSettings] = useState({
    ...DEFAULT_AI_SESSION_SETTINGS,
  });
  const [aiSessionSettingsReady, setAiSessionSettingsReady] = useState(false);
  const [terminalSettings, setTerminalSettings] = useState({
    newTabDirectory: null,
    newPaneDirectory: null,
    inactivePaneOpacity: 0.65,
    closeTerminalsOnAppExit: false,
    copyOnSelection: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontFace: null,
    fontWeight: 400,
    fontStyle: "normal",
    fontSize: 13,
    lineHeight: 100,
    horizontalSpacing: 100,
    scrollbackLines: 10_000,
    shortcuts: { ...DEFAULT_TERMINAL_SHORTCUTS },
    profileDirectory: "~",
  });
  const [terminalFonts, setTerminalFonts] = useState([]);
  const [terminalShellIntegration, setTerminalShellIntegration] = useState(null);
  const [quickCaptureSettings, setQuickCaptureSettings] = useState({
    enabled: true,
    shortcut: "CommandOrControl+Shift+Space",
    defaultShortcut: "CommandOrControl+Shift+Space",
    supported: false,
    registered: false,
    error: null,
  });
  const [recentDirectoryFiles, setRecentDirectoryFiles] = useState([]);
  const [smartInboxTodos, setSmartInboxTodos] = useState([]);
  const [editingSmartInboxTodo, setEditingSmartInboxTodo] = useState(null);
  const [projectConnectionIds, setProjectConnectionIds] = useState([]);
  const [selectedTask, setSelectedTask] = useState(null);
  const [pendingInput, setPendingInput] = useState(null);
  const [pendingOcrDrop, setPendingOcrDrop] = useState(null);
  const [isOcrRunning, setIsOcrRunning] = useState(false);
  const [pendingTaskReview, setPendingTaskReview] = useState(null);
  const [isEmailReading, setIsEmailReading] = useState(false);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false);
  const [projectSwitcherCycleRequestKey, setProjectSwitcherCycleRequestKey] = useState(0);
  const [projectSwitcherReturnTabId, setProjectSwitcherReturnTabId] = useState(null);
  const [taskSearchFocusRequestKey, setTaskSearchFocusRequestKey] = useState(0);
  const [smartInboxFocusRequestKey, setSmartInboxFocusRequestKey] = useState(0);
  const [aiSessionsActiveViewRequestKey, setAiSessionsActiveViewRequestKey] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState("accounts");
  const [utilityPage, setUtilityPage] = useState(null);
  const showActivity = utilityPage === "activity";
  const showAiAgents = utilityPage === "agents";
  const [activityDate, setActivityDate] = useState(() => formatLocalDate());
  const [notice, setNotice] = useState("");
  const [noticeKey, setNoticeKey] = useState(0);
  const activeOcrRunRef = useRef(0);
  const navigationHistoryRef = useRef(createNavigationHistory());
  const historyTraversalPendingRef = useRef(false);
  const navigationRunRef = useRef(0);
  const navigationContextRef = useRef(null);
  navigationContextRef.current = {
    activityDate,
    projects,
    selectedProjectId,
    selectedTask,
    utilityPage,
  };

  const showNotice = useCallback((message) => {
    const nextNotice = message || "";
    setNotice(nextNotice);
    if (nextNotice) {
      setNoticeKey((current) => current + 1);
    }
  }, []);

  const clearNotice = useCallback(() => {
    setNotice("");
  }, []);

  function currentAppLocation() {
    const {
      activityDate: currentActivityDate,
      selectedProjectId: currentProjectId,
      selectedTask: currentTask,
      utilityPage: currentUtilityPage,
    } = navigationContextRef.current;
    if (currentTask) return taskLocation(currentTask);
    if (currentUtilityPage === "activity") return activityLocation(currentActivityDate);
    if (currentUtilityPage === "agents") return agentsLocation();
    if (currentProjectId) return projectLocation(currentProjectId);
    return inboxLocation();
  }

  function applyAppLocation(location, task = null) {
    if (location.kind === "task" && task) {
      navigationContextRef.current = {
        ...navigationContextRef.current,
        selectedProjectId: task.projectId || null,
        selectedTask: task,
        utilityPage: null,
      };
      setUtilityPage(null);
      setSelectedProjectId(task.projectId || null);
      setSelectedTask(task);
      return;
    }

    navigationContextRef.current = {
      ...navigationContextRef.current,
      activityDate: location.kind === "activity"
        ? location.date || formatLocalDate()
        : navigationContextRef.current.activityDate,
      selectedProjectId: location.kind === "project" ? location.projectId : null,
      selectedTask: null,
      utilityPage: location.kind === "activity" || location.kind === "agents"
        ? location.kind
        : null,
    };
    setSelectedTask(null);
    if (location.kind === "project") {
      setUtilityPage(null);
      setSelectedProjectId(location.projectId);
    } else if (location.kind === "activity") {
      setSelectedProjectId(null);
      setActivityDate(location.date || formatLocalDate());
      setUtilityPage("activity");
    } else if (location.kind === "agents") {
      setSelectedProjectId(null);
      setUtilityPage("agents");
    } else {
      setSelectedProjectId(null);
      setUtilityPage(null);
    }
  }

  function navigateToLocation(location, { replace = false, task = null } = {}) {
    navigationRunRef.current += 1;
    historyTraversalPendingRef.current = false;
    navigationHistoryRef.current = replaceNavigationHistory(
      navigationHistoryRef.current,
      currentAppLocation(),
    );
    navigationHistoryRef.current = replace
      ? replaceNavigationHistory(navigationHistoryRef.current, location)
      : pushNavigationHistory(navigationHistoryRef.current, location);
    applyAppLocation(location, task);
  }

  async function restoreHistoryLocation(location, runId) {
    if (location.kind === "task") {
      const taskList = await api.listTasks({ projectId: null });
      if (navigationRunRef.current !== runId) return;
      const task = taskList.find((item) => item.id === location.taskId);
      if (task) {
        applyAppLocation(location, task);
        return;
      }

      const fallback = unavailableTaskFallback(
        location,
        navigationContextRef.current.projects,
      );
      navigationHistoryRef.current = replaceNavigationHistory(
        navigationHistoryRef.current,
        fallback,
      );
      applyAppLocation(fallback);
      showNotice("That task no longer exists.");
      return;
    }

    if (
      location.kind === "project"
      && !navigationContextRef.current.projects.some(
        (project) => project.id === location.projectId,
      )
    ) {
      const fallback = inboxLocation();
      navigationHistoryRef.current = replaceNavigationHistory(
        navigationHistoryRef.current,
        fallback,
      );
      applyAppLocation(fallback);
      showNotice("That project no longer exists.");
      return;
    }

    applyAppLocation(location);
  }

  function traverseAppHistory(direction) {
    if (historyTraversalPendingRef.current) return false;
    navigationHistoryRef.current = replaceNavigationHistory(
      navigationHistoryRef.current,
      currentAppLocation(),
    );
    const movement = moveNavigationHistory(navigationHistoryRef.current, direction);
    if (!movement.location) return false;

    const previousHistory = navigationHistoryRef.current;
    navigationHistoryRef.current = movement.history;
    historyTraversalPendingRef.current = true;
    const runId = navigationRunRef.current + 1;
    navigationRunRef.current = runId;
    restoreHistoryLocation(movement.location, runId)
      .catch((error) => {
        if (navigationRunRef.current === runId) {
          navigationHistoryRef.current = previousHistory;
          reportError(error);
        }
      })
      .finally(() => {
        if (navigationRunRef.current === runId) {
          historyTraversalPendingRef.current = false;
        }
      });
    return true;
  }

  const requestProjectSwitcher = useCallback((returnTabId = null) => {
    const anotherDialogIsOpen = Boolean(document.querySelector('[data-slot="dialog-content"]'))
      && !showProjectSwitcher;
    if (anotherDialogIsOpen) return false;
    setProjectSwitcherReturnTabId((current) =>
      preserveProjectSwitcherReturnTabId(current, returnTabId, showProjectSwitcher));
    setShowProjectSwitcher(true);
    setProjectSwitcherCycleRequestKey((current) => current + 1);
    return true;
  }, [showProjectSwitcher]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  );
  const selectedTaskProject = useMemo(
    () => projects.find((project) => project.id === selectedTask?.projectId) || null,
    [projects, selectedTask],
  );
  const aiSessionMonitor = useAiSessionMonitor({
    settings: aiSessionSettings,
    settingsReady: aiSessionSettingsReady,
    foreground: showAiAgents,
    onNotice: showNotice,
  });
  const activityData = useActivityData({
    date: activityDate,
    connections,
    enabled: showActivity,
    onError: reportError,
    startupSyncEnabled: shellReady && isDesktopApp(),
  });
  const hasCalendarAccounts = calendarAccounts.some((account) => account.calendarEnabled !== false && (account.calendars || []).some((calendar) => account.provider !== "google" || calendar.enabled));
  const isInboxVisible = !selectedTask && !utilityPage && !selectedProject;
  const todayCalendarData = useCalendarData({
    date: formatLocalDate(),
    enabled: isInboxVisible,
    hasAccounts: hasCalendarAccounts,
    onError: reportError,
  });
  const activityCalendarData = useCalendarData({
    date: activityDate,
    enabled: showActivity,
    hasAccounts: hasCalendarAccounts,
    onError: reportError,
  });

  async function reconnectGoogleCalendarAccount(accountId) {
    const account = await api.connectGoogleAccount({ accountId });
    setCalendarAccounts(await api.listCalendarAccounts());
    await todayCalendarData.refresh();
    if (showActivity) await activityCalendarData.refresh();
    showNotice(`${account.name} connected.`);
    return account;
  }

  useEffect(() => {
    refreshShell()
      .then(() => setShellReady(true))
      .catch(reportError);
  }, []);

  useEffect(() => {
    if (!isDesktopApp()) return undefined;

    let active = true;
    let unlisten = null;
    listen("smart-inbox-updated", async () => {
        try {
          const todos = await api.listSmartInboxTodos();
          if (active) setSmartInboxTodos(todos);
        } catch (error) {
          if (active) showNotice(error?.message || String(error));
        }
      })
      .then((cleanup) => {
        if (!active) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch((error) => {
        if (active) showNotice(error?.message || String(error));
      });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [showNotice]);

  useEffect(() => {
    if (!isDesktopApp()) return undefined;
    let active = true;
    let unlisten = null;
    listen(APP_NAVIGATION_REQUEST_EVENT, async ({ payload }) => {
      if (!active) return;
      const destination = appNavigationDestination(payload);
      if (!destination) return;
      try {
        if (destination === PROJECT_SWITCHER_DESTINATION) {
          let shouldOpen = false;
          flushSync(() => {
            shouldOpen = requestProjectSwitcher(appNavigationReturnTabId(payload));
          });
          if (shouldOpen) await workspaceTabsApi.activate("main");
          return;
        }
        flushSync(() => {
          if (destination === AI_SESSIONS_DESTINATION) {
            navigateToLocation(agentsLocation());
            setAiSessionsActiveViewRequestKey((current) => current + 1);
          } else if (destination === SMART_INBOX_DESTINATION) {
            navigateToLocation(inboxLocation());
            setSmartInboxFocusRequestKey((current) => current + 1);
          }
        });
        await workspaceTabsApi.activate("main");
      } catch (error) {
        if (active) showNotice(error?.message || String(error));
      }
    }).then((cleanup) => {
      if (active) unlisten = cleanup;
      else cleanup();
    }).catch((error) => {
      if (active) showNotice(error?.message || String(error));
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [requestProjectSwitcher, showNotice]);

  useEffect(() => {
    function handleKeyDown(event) {
      const historyDirection = appHistoryShortcutDirection(event);
      if (historyDirection && traverseAppHistory(historyDirection)) {
        event.preventDefault();
      } else if (isWorkspaceShortcut(event, "i")) {
        event.preventDefault();
        navigateToLocation(inboxLocation());
        setSmartInboxFocusRequestKey((current) => current + 1);
      } else if (isWorkspaceShortcut(event, "b")) {
        event.preventDefault();
        navigateToLocation(agentsLocation());
        setAiSessionsActiveViewRequestKey((current) => current + 1);
      } else if (isWorkspaceShortcut(event, "p")) {
        event.preventDefault();
        requestProjectSwitcher();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [requestProjectSwitcher]);

  useEffect(() => {
    if (selectedProjectId) {
      refreshProject(selectedProjectId).catch(reportError);
    } else {
      setResources([]);
      setLocalResources([]);
      setProjectConnectionIds([]);
      api.listTasks({ projectId: null }).then(setTasks).catch(reportError);
      refreshSmartInboxTodos().catch(reportError);
      refreshRecentDirectoryFiles().catch(reportError);
    }
  }, [selectedProjectId]);

  async function refreshShell() {
    const [projectList, connectionList, calendarAccountList, aiPromptList, directoryList, browserSettingsResult, commandSettingsResult, aiSessionSettingsResult, terminalSettingsResult, terminalFontList, terminalShellIntegrationResult, quickCaptureSettingsResult, recentFileList, todoList] = await Promise.all([
      api.listProjects(),
      api.listConnections(),
      api.listCalendarAccounts(),
      api.listAiPrompts(),
      api.listDirectories(),
      api.listBrowserSettings(),
      api.listCommandSettings(),
      api.listAiSessionSettings(),
      api.listTerminalSettings(),
      api.listTerminalFonts(),
      api.terminalShellIntegrationStatus(),
      api.quickCaptureSettings(),
      api.listRecentDirectoryFiles(),
      api.listSmartInboxTodos(),
    ]);
    setProjects(dedupeProjects(projectList));
    setConnections(connectionList);
    setCalendarAccounts(calendarAccountList);
    setAiPrompts(aiPromptList);
    setDirectories(directoryList);
    setBrowserSettings(browserSettingsResult);
    setCommandSettings(commandSettingsResult);
    setAiSessionSettings(aiSessionSettingsResult);
    setAiSessionSettingsReady(true);
    setTerminalSettings(terminalSettingsResult);
    setTerminalFonts(terminalFontList);
    setTerminalShellIntegration(terminalShellIntegrationResult);
    setQuickCaptureSettings(quickCaptureSettingsResult);
    if (quickCaptureSettingsResult.error) showNotice(quickCaptureSettingsResult.error);
    setRecentDirectoryFiles(recentFileList);
    setSmartInboxTodos(todoList);
    await api.listTasks({ projectId: selectedProjectId }).then(setTasks);
  }

  async function refreshRecentDirectoryFiles() {
    setRecentDirectoryFiles(await api.listRecentDirectoryFiles());
  }

  async function refreshSmartInboxTodos() {
    setSmartInboxTodos(await api.listSmartInboxTodos());
  }

  async function refreshAllSmartInboxItems() {
    const results = await Promise.allSettled([
      refreshSmartInboxTodos(),
      api.listTasks({ projectId: null }).then(setTasks),
      refreshRecentDirectoryFiles(),
    ]);

    for (const result of results) {
      if (result.status === "rejected") reportError(result.reason);
    }
  }

  async function refreshProject(projectId = selectedProjectId) {
    if (!projectId) return;
    const [taskList, resourceList, localResourceList, connectionIds] = await Promise.all([
      api.listTasks({ projectId }),
      api.listProjectResources({ projectId }),
      api.listLocalResources({ projectId }),
      api.listProjectConnections({ projectId }),
    ]);
    setTasks(taskList);
    setResources(resourceList);
    setLocalResources(localResourceList);
    setProjectConnectionIds(connectionIds);
  }

  async function createProject(name, color = DEFAULT_PROJECT_COLOR) {
    const project = await api.createProject({ name, color });
    setProjects((current) => upsertProject(current, project));
    navigateToLocation(projectLocation(project.id));
    setShowProjectForm(false);
    return project;
  }

  async function submitSmartInput(input, projectId = null, parsedOverride = null, sourceTodoId = null) {
    const parsedPayload = parsedOverride || toParsedPayload(parseSmartInput(input));
    const targetProjectId = projectId || selectedProjectId || null;

    const result = await api.createTaskFromInput({
      input,
      parsed: parsedPayload,
      projectId: targetProjectId,
    });

    if (result.projectRequired) {
      setPendingInput({ input, parsed: parsedPayload, todoId: sourceTodoId });
      return;
    }

    const resultProjectId = result.task?.projectId || result.resource?.projectId || targetProjectId;
    showNotice(result.notice || (result.created ? "Task created." : "Existing task opened."));
    if (result.task) {
      openTask(result.task);
    }
    if (resultProjectId) {
      if (!result.task) {
        navigateToLocation(projectLocation(resultProjectId));
      }
      await refreshProject(resultProjectId);
    } else {
      setTasks(await api.listTasks({ projectId: null }));
    }
    if (sourceTodoId) {
      await api.deleteSmartInboxTodo({ id: sourceTodoId });
      await refreshSmartInboxTodos();
    }
  }

  async function routePendingInput(projectId) {
    if (!pendingInput) return;
    const { input, parsed, todoId } = pendingInput;
    setPendingInput(null);
    await submitSmartInput(input, projectId, parsed, todoId);
  }

  async function captureSmartInboxText(input) {
    await api.createSmartInboxTodo({
      kind: "text",
      title: quickCaptureTitle(input),
      rawText: input,
      filePath: null,
      fileName: null,
      mimeType: null,
    });
    await refreshSmartInboxTodos();
    showNotice("Todo captured.");
  }

  async function captureSmartInboxFile(fileDrop) {
    const path = fileDrop.messageUri || fileDrop.path || "";
    await api.createSmartInboxTodo({
      kind: "file",
      title: fileDropName(fileDrop),
      rawText: null,
      filePath: path || null,
      fileName: fileDropName(fileDrop),
      mimeType: fileDrop.mimeType || fileDrop.file?.type || null,
    });
    await refreshSmartInboxTodos();
    showNotice("Todo captured.");
    return null;
  }

  async function deleteSmartInboxTodo(todo) {
    await api.deleteSmartInboxTodo({ id: todo.id });
    await refreshSmartInboxTodos();
    showNotice("Todo removed.");
  }

  async function updateSmartInboxTodo(payload) {
    await api.updateSmartInboxTodo(payload);
    await refreshSmartInboxTodos();
    setEditingSmartInboxTodo(null);
    showNotice("Todo updated.");
  }

  async function promoteSmartInboxTodo(todo) {
    if (todo.kind !== "file") {
      const input = todo.rawText || todo.title;
      await submitSmartInput(
        input,
        null,
        toParsedPayload(parseSmartInboxTodo(todo)),
        todo.id,
      );
      return;
    }

    const latestTodos = await api.listSmartInboxTodos();
    setSmartInboxTodos(latestTodos);
    const latestTodo = latestTodos.find((item) => item.id === todo.id) || todo;
    if (latestTodo.fileMissing) {
      showNotice("File is missing. Delete this todo or drop the file again.");
      return;
    }

    const fileDrop = fileDropFromTodo(latestTodo);
    const dropKind = smartFileDropKind(fileDrop);
    if (dropKind) {
      const result = await handleSmartFileDrop(fileDrop, latestTodo.id);
      if (typeof result === "string" && result.trim()) {
        showNotice(result);
      }
      return;
    }

    const { input, parsed } = unsupportedFileTodoInput(latestTodo);
    setPendingInput({ input, parsed, todoId: latestTodo.id });
  }

  const readEmailDrop = useCallback(async (fileDrop, sourceTodoId = null) => {
    if (isEmailReading) return "Already reading an email drop.";
    setIsEmailReading(true);
    try {
      const result = fileDrop.messageUri
        ? await api.readAppleMailMessage({
            messageUri: fileDrop.messageUri,
          })
        : fileDrop.file
        ? await api.readEmailBytes({
            bytes: Array.from(new Uint8Array(await fileDrop.file.arrayBuffer())),
          })
        : await api.readEmailFile({
            path: fileDrop.path,
            mimeType: fileDrop.mimeType || null,
          });
      const subject = result.subject?.trim() || "Email task";
      const body = result.body?.trim() || "";
      if (!body) {
        return "No readable body was found in the email.";
      }
      setPendingTaskReview({ title: subject, description: body, todoId: sourceTodoId });
    } catch (error) {
      return error?.message || String(error);
    } finally {
      setIsEmailReading(false);
    }
  }, [isEmailReading]);

  const handleSmartFileDrop = useCallback(async (fileDrop, sourceTodoId = null) => {
    const dropKind = smartFileDropKind(fileDrop);
    if (!dropKind) {
      return UNSUPPORTED_OCR_FILE_MESSAGE;
    }

    if (!isDesktopApp() || (!fileDrop.path && !fileDrop.file && !fileDrop.messageUri)) {
      return dropKind === "email" ? EMAIL_DESKTOP_REQUIRED_MESSAGE : OCR_DESKTOP_REQUIRED_MESSAGE;
    }

    if (dropKind === "email") {
      return readEmailDrop(fileDrop, sourceTodoId);
    }

    setPendingOcrDrop({ ...fileDrop, todoId: sourceTodoId });
  }, [readEmailDrop]);

  const openRecentDirectoryFile = useCallback(async (file) => {
    const result = await handleSmartFileDrop({
      path: file.path,
      name: file.name,
      mimeType: "",
    });
    if (typeof result === "string" && result.trim()) {
      showNotice(result);
    }
  }, [handleSmartFileDrop, showNotice]);

  function cancelOcrDrop() {
    activeOcrRunRef.current += 1;
    setIsOcrRunning(false);
    setPendingOcrDrop(null);
  }

  async function confirmOcrDrop() {
    if (!pendingOcrDrop || isOcrRunning) return;
    const ocrDrop = pendingOcrDrop;
    const ocrRunId = activeOcrRunRef.current + 1;
    activeOcrRunRef.current = ocrRunId;
    setIsOcrRunning(true);
    try {
      const result = ocrDrop.file
        ? await api.ocrImageBytes({
            bytes: Array.from(new Uint8Array(await ocrDrop.file.arrayBuffer())),
            name: ocrDrop.name || null,
            mimeType: ocrDrop.mimeType || null,
          })
        : await api.ocrImageFile({
            path: ocrDrop.path,
            mimeType: ocrDrop.mimeType || null,
          });
      if (activeOcrRunRef.current !== ocrRunId) return;

      const text = result.text?.trim() || "";
      setPendingOcrDrop(null);
      if (!text) {
        showNotice("No text was detected in the image.");
        return;
      }
      setPendingTaskReview({ title: ocrTaskTitle(text), description: text, todoId: ocrDrop.todoId || null });
    } catch (error) {
      if (activeOcrRunRef.current === ocrRunId) {
        reportError(error);
      }
    } finally {
      if (activeOcrRunRef.current === ocrRunId) {
        activeOcrRunRef.current = 0;
        setIsOcrRunning(false);
      }
    }
  }

  function confirmTaskReview() {
    if (!pendingTaskReview) return;
    const title = pendingTaskReview.title.trim() || "New task";
    const description = pendingTaskReview.description.trim();
    if (!description) return;
    const todoId = pendingTaskReview.todoId || null;
    setPendingTaskReview(null);
    setPendingInput({ input: description, parsed: textParsedPayload(title), todoId });
  }

  function openTask(task) {
    navigateToLocation(taskLocation(task), { task });
  }

  function selectProject(projectId) {
    navigateToLocation(projectLocation(projectId));
    setTaskSearchFocusRequestKey((current) => current + 1);
  }

  function closeProjectSwitcher() {
    setShowProjectSwitcher(false);
    setProjectSwitcherReturnTabId(null);
  }

  async function escapeProjectSwitcher() {
    const returnTabId = projectSwitcherReturnTabId;
    closeProjectSwitcher();
    if (!returnTabId) return;
    try {
      await workspaceTabsApi.activate(returnTabId);
    } catch (error) {
      reportError(error);
    }
  }

  function showDashboard() {
    navigateToLocation(inboxLocation());
  }

  function showSmartInbox() {
    showDashboard();
    setSmartInboxFocusRequestKey((current) => current + 1);
  }

  function showActivityView() {
    navigateToLocation(activityLocation(formatLocalDate()));
  }

  function showAiAgentsView() {
    navigateToLocation(agentsLocation());
  }

  function showProjectFromBreadcrumb() {
    if (selectedTask?.projectId) {
      navigateToLocation(projectLocation(selectedTask.projectId));
    }
  }

  function reportError(error) {
    showNotice(error?.message || String(error));
  }

  const checkoutPullRequestForReview = useCallback(async (payload) => {
    const result = await api.checkoutPullRequestForReview(payload);
    showNotice(result.message);
    return result;
  }, [showNotice]);

  return (
    <AppShell
      projects={projects}
      selectedProjectId={selectedProjectId}
      selectedProject={selectedProject}
      selectedTask={selectedTask}
      selectedTaskProject={selectedTaskProject}
      title={showAiAgents ? "AI Agents" : showActivity ? "Activity" : undefined}
      breadcrumbPage={showAiAgents ? "AI Agents" : showActivity ? "Activity" : undefined}
      isActivitySelected={showActivity}
      isAgentsSelected={showAiAgents}
      hasWaitingAiSession={aiSessionMonitor.hasWaitingAiSession}
      notice={notice}
      noticeKey={noticeKey}
      onClearNotice={clearNotice}
      onSelectProject={selectProject}
      onShowProjectSwitcher={() => requestProjectSwitcher()}
      onShowInbox={showDashboard}
      onShowProject={showProjectFromBreadcrumb}
      onAddProject={() => setShowProjectForm(true)}
      onShowActivity={showActivityView}
      onShowAgents={showAiAgentsView}
      onShowSettings={() => {
        setSettingsInitialSection("accounts");
        setShowSettings(true);
      }}
      onShowSmartInbox={showSmartInbox}
    >
      {selectedTask ? (
        <TaskDetailView
          task={selectedTask}
          project={selectedTaskProject}
          aiPrompts={aiPrompts}
          aiSessionSettings={aiSessionSettings}
          commandSettings={commandSettings}
          localResources={localResources}
          homeDirectory={terminalSettings.profileDirectory}
          onInspectAiPromptBranches={(payload) => api.inspectAiPromptBranches(payload)}
          onOpenAiPromptThread={async (payload) => {
            const taskToKeep = selectedTask;
            try {
              const launchResult = await api.openAiPromptThread(payload);
              const prompt = aiPrompts.find((item) => item.id === payload.aiPromptId);
              setSelectedTask((current) => current || taskToKeep);
              setTasks((current) => (
                taskToKeep && !current.some((item) => item.id === taskToKeep.id)
                  ? [taskToKeep, ...current]
                  : current
              ));
              showNotice(`Opening ${prompt?.name || "AI Prompt"}. This task remains open here.`);
              return launchResult;
            } catch (error) {
              reportError(error);
              throw error;
            }
          }}
          onRefreshExternalDetails={async (taskId) => {
            const result = await api.refreshTaskExternalDetails({ taskId });
            setSelectedTask((current) => (current?.id === result.task.id ? result.task : current));
            setTasks((current) => current.map((task) => (task.id === result.task.id ? result.task : task)));
            if (result.notice && !result.connectionRequired) {
              showNotice(result.notice);
            }
            return result;
          }}
          onLoadLinks={(taskId) => api.listTaskLinks({ taskId })}
          onLoadRelations={(taskId) => api.listTaskRelations({ taskId })}
          onLoadTrelloBoards={(taskId) => api.listTaskTrelloBoards({ taskId })}
          onLoadTrelloTemplates={(payload) => api.listTrelloBoardTemplates(payload)}
          onConvertToTrelloTicket={async (payload) => {
            const result = await api.convertTaskToTrelloTicket(payload);
            setSelectedTask(result.task);
            setTasks((current) => current.map((task) => (
              task.id === result.task.id ? result.task : task
            )));
            if (result.task.projectId) {
              await refreshProject(result.task.projectId);
            }
            showNotice("Trello ticket created.");
            return result;
          }}
          onLoadLocalResources={(payload) => api.listLocalResources(payload)}
          onChooseLocalResourceDirectory={() => api.chooseLocalResourceDirectory()}
          onSaveLocalResource={async (payload) => {
            const resource = await api.saveLocalResource(payload);
            if (payload.projectId) {
              setLocalResources(await api.listLocalResources({ projectId: payload.projectId }));
            }
            return resource;
          }}
          onCheckoutPullRequestForReview={checkoutPullRequestForReview}
          onLoadReviewDiff={api.loadReviewDiff}
          onLoadReviewDiffFile={api.loadReviewDiffFile}
          onListReviewCommentDrafts={api.listReviewCommentDrafts}
          onSaveReviewCommentDraft={api.saveReviewCommentDraft}
          onDeleteReviewCommentDraft={api.deleteReviewCommentDraft}
          onSubmitReviewComments={api.submitReviewComments}
          onSaveRelation={async (payload) => api.saveTaskRelation(payload)}
          onDeleteRelation={async (id) => api.deleteTaskRelation({ id })}
          onLoadProjectTasks={(projectId) => api.listTasks({ projectId })}
          onOpenTask={openTask}
          onSave={async (payload) => {
            const task = await api.updateTask(payload);
            setSelectedTask(task);
            if (task.projectId) {
              await refreshProject(task.projectId);
            } else {
              setTasks(await api.listTasks({ projectId: null }));
            }
          }}
          onDeleteTask={async (task) => {
            try {
              await api.deleteTask({ id: task.id });
              navigateToLocation(
                task.projectId ? projectLocation(task.projectId) : inboxLocation(),
                { replace: true },
              );
              if (task.projectId) {
                await refreshProject(task.projectId);
              } else {
                setTasks(await api.listTasks({ projectId: null }));
              }
              showNotice("Task deleted.");
            } catch (error) {
              reportError(error);
              throw error;
            }
          }}
        />
      ) : showAiAgents ? (
        <AiAgentsView
          settings={aiSessionSettings}
          result={aiSessionMonitor.result}
          loading={aiSessionMonitor.loading}
          activeViewRequestKey={aiSessionsActiveViewRequestKey}
          onRefresh={aiSessionMonitor.refresh}
          onNotice={showNotice}
        />
      ) : showActivity ? (
        <ActivityView
          date={activityDate}
          projects={projects}
          activities={activityData.activities}
          syncRuns={activityData.syncRuns}
          isSyncing={activityData.isSyncing}
          calendarEvents={activityCalendarData.events}
          calendarSyncRuns={activityCalendarData.syncRuns}
          isCalendarSyncing={activityCalendarData.isSyncing}
          onDateChange={setActivityDate}
          onNotice={showNotice}
          onRefresh={() => Promise.all([activityData.refresh(), activityCalendarData.refresh()])}
        />
      ) : selectedProject ? (
        <ProjectWorkspaceView
          project={selectedProject}
          taskSearchFocusRequestKey={taskSearchFocusRequestKey}
          tasks={tasks}
          resources={resources}
          localResources={localResources}
          connections={connections}
          projectConnectionIds={projectConnectionIds}
          onRefresh={() => refreshProject(selectedProject.id).catch(reportError)}
          onUpdateProject={async (payload) => {
            const project = await api.updateProject(payload);
            setProjects((current) => upsertProject(current, project));
          }}
          onUpdateProjectConnections={async (connectionIds) => {
            const updated = await api.setProjectConnections({
              projectId: selectedProject.id,
              connectionIds,
            });
            setProjectConnectionIds(updated);
            await refreshProject(selectedProject.id);
          }}
          onConnectResource={async (payload) => {
            await api.connectResource(payload);
            await refreshProject(selectedProject.id);
          }}
          onDisconnectResource={async (id) => {
            await api.disconnectResource({ id });
            await refreshProject(selectedProject.id);
          }}
          onChooseLocalResourceDirectory={() => api.chooseLocalResourceDirectory()}
          onSaveLocalResource={async (payload) => {
            await api.saveLocalResource(payload);
            await refreshProject(selectedProject.id);
          }}
          onDeleteLocalResource={async (id) => {
            await api.deleteLocalResource({ id });
            await refreshProject(selectedProject.id);
          }}
          onUpdateTask={async (payload) => {
            const task = await api.updateTask(payload);
            setSelectedTask((current) => (current?.id === task.id ? task : current));
            await refreshProject(selectedProject.id);
          }}
          onOpenTask={openTask}
        />
      ) : (
        <InboxView
          tasks={tasks}
          projects={projects}
          smartInboxTodos={smartInboxTodos}
          recentDirectoryFiles={recentDirectoryFiles}
          smartInputFocusRequestKey={smartInboxFocusRequestKey}
          onSubmit={(input) => captureSmartInboxText(input).catch(reportError)}
          onFileDrop={
            pendingOcrDrop || pendingTaskReview || isEmailReading
              ? undefined
              : (fileDrop) => captureSmartInboxFile(fileDrop).catch(reportError)
          }
          onEditTodo={setEditingSmartInboxTodo}
          onOpenTodo={(todo) => promoteSmartInboxTodo(todo).catch(reportError)}
          onDeleteTodo={(todo) => deleteSmartInboxTodo(todo).catch(reportError)}
          onOpenRecentFile={
            pendingOcrDrop || pendingTaskReview || isEmailReading
              ? undefined
              : openRecentDirectoryFile
          }
          onRefreshAll={refreshAllSmartInboxItems}
          onRefreshRecentFiles={() => refreshRecentDirectoryFiles().catch(reportError)}
          onLoadProviderItems={(provider) => api.listSmartInboxProviderItems({ provider })}
          onSyncProviderItems={(provider) => api.syncSmartInboxProviderItems({ provider })}
          onLoadProviderSources={(provider) => api.listSmartInboxProviderSources({ provider })}
          onUpdateProviderSources={(provider, changes) => api.updateSmartInboxProviderSources({ provider, changes })}
          onOpenReviewRequest={(input) => submitSmartInput(input).catch(reportError)}
          onOpenTask={openTask}
          calendarEvents={todayCalendarData.events}
          calendarSyncRuns={todayCalendarData.syncRuns}
          isCalendarSyncing={todayCalendarData.isSyncing}
          hasCalendarAccounts={hasCalendarAccounts}
          onRefreshCalendar={todayCalendarData.refresh}
          onReconnectCalendarAccount={reconnectGoogleCalendarAccount}
          onShowCalendarSettings={() => {
            setSettingsInitialSection("accounts");
            setShowSettings(true);
          }}
        />
      )}

      {showProjectForm && (
        <ProjectDialog
          onClose={() => setShowProjectForm(false)}
          onCreate={(name, color) => createProject(name, color).catch(reportError)}
        />
      )}

      {showProjectSwitcher && (
        <ProjectSwitcherDialog
          projects={projects}
          selectedProjectId={selectedProjectId}
          cycleRequestKey={projectSwitcherCycleRequestKey}
          onClose={closeProjectSwitcher}
          onEscape={() => escapeProjectSwitcher()}
          onSelect={(projectId) => {
            closeProjectSwitcher();
            selectProject(projectId);
          }}
          onAddProject={() => {
            closeProjectSwitcher();
            setShowProjectForm(true);
          }}
        />
      )}

      {editingSmartInboxTodo && (
        <TodoEditDialog
          todo={editingSmartInboxTodo}
          onClose={() => setEditingSmartInboxTodo(null)}
          onSave={updateSmartInboxTodo}
        />
      )}

      {pendingInput && (
        <ProjectPickerDialog
          input={pendingInput.input}
          projects={projects}
          onClose={() => setPendingInput(null)}
          onPick={(projectId) => routePendingInput(projectId).catch(reportError)}
          onCreate={async (name) => {
            const project = await createProject(name);
            await routePendingInput(project.id);
          }}
        />
      )}

      {pendingOcrDrop && (
        <Modal title={`File: ${fileDropName(pendingOcrDrop)}`} onClose={cancelOcrDrop} contentClassName="sm:max-w-2xl">
          <FileDropPreview fileDrop={pendingOcrDrop} />
          <DialogDescription>
            Create a task from text detected in this file?
          </DialogDescription>
          {isOcrRunning && (
            <p className="text-sm text-muted-foreground">Reading text from image...</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={cancelOcrDrop}
            >
              Cancel
            </Button>
            <Button type="button" disabled={isOcrRunning} onClick={() => confirmOcrDrop()}>
              {isOcrRunning && <LoaderCircle className="animate-spin" />}
              {isOcrRunning ? "Running OCR..." : "OCR"}
            </Button>
          </DialogFooter>
        </Modal>
      )}

      {pendingTaskReview && (
        <Modal title="Review Task" onClose={() => setPendingTaskReview(null)}>
          <DialogDescription>
            Check the task title and description before choosing where to save it.
          </DialogDescription>
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="task-review-title">
              Title
            </label>
            <Input
              id="task-review-title"
              value={pendingTaskReview.title}
              onChange={(event) =>
                setPendingTaskReview((current) => current && ({
                  ...current,
                  title: event.target.value,
                }))
              }
            />
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="task-review-description">
              Description
            </label>
            <Textarea
              id="task-review-description"
              className="min-h-48 resize-y"
              value={pendingTaskReview.description}
              onChange={(event) =>
                setPendingTaskReview((current) => current && ({
                  ...current,
                  description: event.target.value,
                }))
              }
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingTaskReview(null)}>
              Cancel
            </Button>
            <Button type="button" disabled={!pendingTaskReview.description.trim()} onClick={confirmTaskReview}>
              Continue
            </Button>
          </DialogFooter>
        </Modal>
      )}

      {isEmailReading && (
        <Modal title="Reading email file" onClose={() => {}}>
          <DialogDescription>
            Reading subject and body from the dropped email file...
          </DialogDescription>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="animate-spin" />
            Reading email...
          </p>
        </Modal>
      )}

      {showSettings && (
        <SettingsDialog
          connections={connections}
          aiPrompts={aiPrompts}
          directories={directories}
          browserSettings={browserSettings}
          commandSettings={commandSettings}
          aiSessionSettings={aiSessionSettings}
          terminalSettings={terminalSettings}
          terminalFonts={terminalFonts}
          terminalShellIntegration={terminalShellIntegration}
          quickCaptureSettings={quickCaptureSettings}
          appUpdater={appUpdater}
          themePreference={themePreference}
          calendarAccounts={calendarAccounts}
          calendarSyncRuns={todayCalendarData.syncRuns}
          initialSection={settingsInitialSection}
          onClose={() => setShowSettings(false)}
          onThemePreferenceChange={setThemePreference}
          onSave={async (payload) => {
            await api.saveConnection(payload);
            setConnections(await api.listConnections());
            showNotice(payload.id ? "Connection updated." : "Connection saved.");
            if (selectedProjectId) {
              setProjectConnectionIds(await api.listProjectConnections({ projectId: selectedProjectId }));
            }
          }}
          onDelete={async (id) => {
            await api.deleteConnection({ id });
            setConnections(await api.listConnections());
            if (selectedProjectId) {
              setProjectConnectionIds(await api.listProjectConnections({ projectId: selectedProjectId }));
            }
          }}
          onTest={async (id) => {
            try {
              const result = await api.testConnection({ id });
              showNotice(result.message);
              return result;
            } catch (error) {
              reportError(error);
              return {
                ok: false,
                message: error?.message || String(error),
                accountName: null,
              };
            }
          }}
          onTestConnectionInput={(payload) => api.testConnectionInput(payload)}
          onSaveAiPrompt={async (payload) => {
            try {
              await api.saveAiPrompt(payload);
              setAiPrompts(await api.listAiPrompts());
              showNotice(payload.id ? "AI Prompt updated." : "AI Prompt saved.");
            } catch (error) {
              reportError(error);
              throw error;
            }
          }}
          onDeleteAiPrompt={async (id) => {
            try {
              await api.deleteAiPrompt({ id });
              setAiPrompts(await api.listAiPrompts());
              showNotice("AI Prompt removed.");
            } catch (error) {
              reportError(error);
              throw error;
            }
          }}
          onChooseDirectory={() => api.chooseDirectory()}
          onSaveDirectory={async (payload) => {
            await api.saveDirectory(payload);
            setDirectories(await api.listDirectories());
            await refreshRecentDirectoryFiles();
            showNotice("Directory saved.");
          }}
          onDeleteDirectory={async (id) => {
            await api.deleteDirectory({ id });
            setDirectories(await api.listDirectories());
            await refreshRecentDirectoryFiles();
            showNotice("Directory removed.");
          }}
          onSaveBrowserSettings={async (payload) => {
            const nextBrowserSettings = await api.saveBrowserSettings(payload);
            setBrowserSettings(nextBrowserSettings);
            showNotice("Browser settings saved.");
          }}
          onSaveCommandSettings={async (payload) => {
            try {
              const nextCommandSettings = await api.saveCommandSettings(payload);
              setCommandSettings(nextCommandSettings);
              showNotice("Command settings saved.");
              return nextCommandSettings;
            } catch (error) {
              reportError(error);
              throw error;
            }
          }}
          onSaveAiSessionSettings={async (payload) => {
            const nextAiSessionSettings = await api.saveAiSessionSettings(payload);
            setAiSessionSettings(nextAiSessionSettings);
            showNotice("AI session settings saved.");
            return nextAiSessionSettings;
          }}
          onSaveTerminalSettings={async (payload) => {
            const nextTerminalSettings = await api.saveTerminalSettings(payload);
            setTerminalSettings(nextTerminalSettings);
            showNotice("Terminal settings saved.");
            return nextTerminalSettings;
          }}
          onRefreshTerminalShellIntegration={async () => {
            const status = await api.terminalShellIntegrationStatus();
            setTerminalShellIntegration(status);
            return status;
          }}
          onInstallTerminalShellIntegration={async () => {
            const status = await api.installTerminalShellIntegration();
            setTerminalShellIntegration(status);
            showNotice("Shift+Enter shell integration installed.");
            return status;
          }}
          onUninstallTerminalShellIntegration={async () => {
            const status = await api.uninstallTerminalShellIntegration();
            setTerminalShellIntegration(status);
            showNotice("Shift+Enter shell integration removed.");
            return status;
          }}
          onSaveQuickCaptureSettings={async (payload) => {
            try {
              const settings = await api.saveQuickCaptureSettings(payload);
              setQuickCaptureSettings(settings);
              showNotice(payload.enabled ? "Quick capture settings saved." : "Quick capture disabled.");
              return settings;
            } catch (error) {
              setQuickCaptureSettings(await api.quickCaptureSettings());
              throw error;
            }
          }}
          onSaveCalendarSubscription={async (payload) => {
            const account = await api.saveCalendarSubscription(payload);
            setCalendarAccounts(await api.listCalendarAccounts());
            showNotice(payload.id ? "Calendar subscription updated." : "Calendar subscription added.");
            return account;
          }}
          onConnectGoogleAccount={reconnectGoogleCalendarAccount}
          onCancelGoogleAccount={() => api.cancelGoogleAccountConnection()}
          onUpdateCalendarService={async (accountId, enabled) => {
            const account = await api.updateCalendarService({ accountId, enabled });
            setCalendarAccounts(await api.listCalendarAccounts());
            await todayCalendarData.reload();
            if (showActivity) await activityCalendarData.reload();
            return account;
          }}
          onSaveCalDavAccount={async (payload) => {
            const account = await api.saveCalDavAccount(payload);
            setCalendarAccounts(await api.listCalendarAccounts());
            showNotice(payload.id ? "CalDAV account reconnected." : "CalDAV account connected.");
            return account;
          }}
          onRefreshCalendarCollections={async (accountId) => {
            const account = await api.refreshCalendarCollections({ accountId });
            setCalendarAccounts(await api.listCalendarAccounts());
            return account;
          }}
          onUpdateCalendarCollections={async (selections) => {
            const accounts = await api.updateCalendarCollections({ selections });
            setCalendarAccounts(accounts);
            if (isInboxVisible) await todayCalendarData.reload();
            if (showActivity) await activityCalendarData.reload();
            return accounts;
          }}
          onTestCalendarAccount={(accountId) => api.testCalendarAccount({ accountId })}
          onTestCalendarAccountInput={(payload) => api.testCalendarAccountInput(payload)}
          onDeleteCalendarAccount={async (accountId) => {
            await api.deleteCalendarAccount({ accountId });
            setCalendarAccounts(await api.listCalendarAccounts());
            showNotice("Calendar account removed.");
          }}
        />
      )}
      <UpdateDialog updater={appUpdater} />
    </AppShell>
  );
}

export default App;
