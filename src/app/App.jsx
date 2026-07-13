import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { LoaderCircle } from "lucide-react";

import "@/App.css";
import { Modal } from "@/components/common/Modal";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ProjectDialog } from "@/features/projects/ProjectDialog";
import { ProjectPickerDialog } from "@/features/projects/ProjectPickerDialog";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { SmartInput } from "@/features/smart-input/SmartInput";
import { TodoEditDialog } from "@/features/smart-input/TodoEditDialog";
import { api, toParsedPayload } from "@/lib/api";
import { formatLocalDate } from "@/lib/activity";
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
import { parseSmartInput } from "@/lib/smartInputParser";
import { InboxView, RecentDirectoryFilesList } from "@/views/inbox/InboxView";
import { ActivityView, useActivityData } from "@/views/activity/ActivityView";
import { ProjectWorkspaceView } from "@/views/projects/ProjectWorkspaceView";
import { TaskDetailView } from "@/views/tasks/TaskDetailView";
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

function titleFromRawInput(input) {
  return String(input || "").split(/\r?\n/).find((line) => line.trim())?.trim() || "Untitled todo";
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
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [resources, setResources] = useState([]);
  const [localResources, setLocalResources] = useState([]);
  const [connections, setConnections] = useState([]);
  const [directories, setDirectories] = useState([]);
  const [browserSettings, setBrowserSettings] = useState({
    detectedBrowserBundleId: null,
    browserBundleId: null,
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
  const [showSmartInboxOverlay, setShowSmartInboxOverlay] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [activityDate, setActivityDate] = useState(() => formatLocalDate());
  const [notice, setNotice] = useState("");
  const [noticeKey, setNoticeKey] = useState(0);
  const activeOcrRunRef = useRef(0);

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

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  );
  const selectedTaskProject = useMemo(
    () => projects.find((project) => project.id === selectedTask?.projectId) || null,
    [projects, selectedTask],
  );
  const activityData = useActivityData({
    date: activityDate,
    enabled: showActivity,
    onError: reportError,
  });

  useEffect(() => {
    refreshShell().catch(reportError);
  }, []);

  useEffect(() => {
    function handleKeyDown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowSmartInboxOverlay(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "t") {
        event.preventDefault();
        api.openBlankBrowserTab().catch(reportError);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [reportError]);

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
    const [projectList, connectionList, directoryList, browserSettingsResult, recentFileList, todoList] = await Promise.all([
      api.listProjects(),
      api.listConnections(),
      api.listDirectories(),
      api.listBrowserSettings(),
      api.listRecentDirectoryFiles(),
      api.listSmartInboxTodos(),
    ]);
    setProjects(dedupeProjects(projectList));
    setConnections(connectionList);
    setDirectories(directoryList);
    setBrowserSettings(browserSettingsResult);
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
    setSelectedProjectId(project.id);
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
    if (resultProjectId) {
      setSelectedProjectId(resultProjectId);
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
      title: titleFromRawInput(input),
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
      await submitSmartInput(todo.rawText || todo.title, null, null, todo.id);
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
    setShowSmartInboxOverlay(false);
    setPendingInput({ input: description, parsed: textParsedPayload(title), todoId });
  }

  function openTask(task) {
    setShowActivity(false);
    setSelectedTask(task);
    if (task.projectId) {
      setSelectedProjectId(task.projectId);
    }
  }

  function selectProject(projectId) {
    setShowActivity(false);
    setSelectedTask(null);
    setSelectedProjectId(projectId);
  }

  function showDashboard() {
    setShowActivity(false);
    setSelectedTask(null);
    setSelectedProjectId(null);
  }

  function showActivityView() {
    setSelectedTask(null);
    setSelectedProjectId(null);
    setShowActivity(true);
  }

  function showProjectFromBreadcrumb() {
    setSelectedTask(null);
    if (selectedTask?.projectId) {
      setSelectedProjectId(selectedTask.projectId);
    }
  }

  function reportError(error) {
    showNotice(error?.message || String(error));
  }

  return (
    <AppShell
      projects={projects}
      selectedProjectId={selectedProjectId}
      selectedProject={selectedProject}
      selectedTask={selectedTask}
      selectedTaskProject={selectedTaskProject}
      title={showActivity ? "Activity" : undefined}
      breadcrumbPage={showActivity ? "Activity" : undefined}
      isActivitySelected={showActivity}
      notice={notice}
      noticeKey={noticeKey}
      onClearNotice={clearNotice}
      onSelectProject={selectProject}
      onShowInbox={showDashboard}
      onShowProject={showProjectFromBreadcrumb}
      onAddProject={() => setShowProjectForm(true)}
      onShowActivity={showActivityView}
      onShowSettings={() => setShowSettings(true)}
      onShowSmartInbox={() => setShowSmartInboxOverlay(true)}
    >
      {selectedTask ? (
        <TaskDetailView
          task={selectedTask}
          project={selectedTaskProject}
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
          onLoadLocalResources={(payload) => api.listLocalResources(payload)}
          onChooseLocalResourceDirectory={() => api.chooseLocalResourceDirectory()}
          onSaveLocalResource={async (payload) => {
            const resource = await api.saveLocalResource(payload);
            if (payload.projectId) {
              setLocalResources(await api.listLocalResources({ projectId: payload.projectId }));
            }
            return resource;
          }}
          onCheckoutPullRequestForReview={async (payload) => {
            const result = await api.checkoutPullRequestForReview(payload);
            showNotice(result.message);
            return result;
          }}
          onLoadReviewDiff={(payload) => api.loadReviewDiff(payload)}
          onLoadReviewDiffFile={(payload) => api.loadReviewDiffFile(payload)}
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
              setSelectedTask(null);
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
      ) : showActivity ? (
        <ActivityView
          date={activityDate}
          activities={activityData.activities}
          syncRuns={activityData.syncRuns}
          isSyncing={activityData.isSyncing}
          onDateChange={setActivityDate}
          onRefresh={activityData.refresh}
        />
      ) : selectedProject ? (
        <ProjectWorkspaceView
          project={selectedProject}
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
          onSubmit={(input) => captureSmartInboxText(input).catch(reportError)}
          onFileDrop={
            showSmartInboxOverlay || pendingOcrDrop || pendingTaskReview || isEmailReading
              ? undefined
              : (fileDrop) => captureSmartInboxFile(fileDrop).catch(reportError)
          }
          onEditTodo={setEditingSmartInboxTodo}
          onOpenTodo={(todo) => promoteSmartInboxTodo(todo).catch(reportError)}
          onDeleteTodo={(todo) => deleteSmartInboxTodo(todo).catch(reportError)}
          onOpenRecentFile={
            showSmartInboxOverlay || pendingOcrDrop || pendingTaskReview || isEmailReading
              ? undefined
              : openRecentDirectoryFile
          }
          onRefreshRecentFiles={() => refreshRecentDirectoryFiles().catch(reportError)}
          onLoadProviderItems={(provider) => api.listSmartInboxProviderItems({ provider })}
          onSyncProviderItems={(provider) => api.syncSmartInboxProviderItems({ provider })}
          onLoadProviderSources={(provider) => api.listSmartInboxProviderSources({ provider })}
          onUpdateProviderSources={(provider, changes) => api.updateSmartInboxProviderSources({ provider, changes })}
          onOpenReviewRequest={(input) => submitSmartInput(input).catch(reportError)}
          onOpenTask={openTask}
        />
      )}

      {showProjectForm && (
        <ProjectDialog
          onClose={() => setShowProjectForm(false)}
          onCreate={(name, color) => createProject(name, color).catch(reportError)}
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

      {showSmartInboxOverlay && (
        <Modal title="Smart inbox" onClose={() => setShowSmartInboxOverlay(false)}>
          <SmartInput
            large
            onFileDrop={
              pendingOcrDrop || pendingTaskReview || isEmailReading
                ? undefined
                : async (fileDrop) => {
                    await captureSmartInboxFile(fileDrop);
                    setShowSmartInboxOverlay(false);
                    return null;
                  }
            }
            onSubmit={async (input) => {
              await captureSmartInboxText(input);
              setShowSmartInboxOverlay(false);
            }}
          />
          <RecentDirectoryFilesList
            files={recentDirectoryFiles}
            onOpenFile={
              pendingOcrDrop || pendingTaskReview || isEmailReading
                ? undefined
                : openRecentDirectoryFile
            }
            onRefresh={() => refreshRecentDirectoryFiles().catch(reportError)}
          />
        </Modal>
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
          directories={directories}
          browserSettings={browserSettings}
          onClose={() => setShowSettings(false)}
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
        />
      )}
    </AppShell>
  );
}

export default App;
