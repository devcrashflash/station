import { useEffect, useMemo, useState } from "react";

import "@/App.css";
import { Modal } from "@/components/common/Modal";
import { ProjectDialog } from "@/features/projects/ProjectDialog";
import { ProjectPickerDialog } from "@/features/projects/ProjectPickerDialog";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { SmartInput } from "@/features/smart-input/SmartInput";
import { api, toParsedPayload } from "@/lib/api";
import { DEFAULT_PROJECT_COLOR } from "@/lib/projectAvatar";
import { parseSmartInput } from "@/lib/smartInputParser";
import { InboxView } from "@/views/inbox/InboxView";
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

function App() {
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [resources, setResources] = useState([]);
  const [localResources, setLocalResources] = useState([]);
  const [connections, setConnections] = useState([]);
  const [projectConnectionIds, setProjectConnectionIds] = useState([]);
  const [selectedTask, setSelectedTask] = useState(null);
  const [pendingInput, setPendingInput] = useState(null);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showSmartInboxOverlay, setShowSmartInboxOverlay] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [notice, setNotice] = useState("");

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  );
  const selectedTaskProject = useMemo(
    () => projects.find((project) => project.id === selectedTask?.projectId) || null,
    [projects, selectedTask],
  );

  useEffect(() => {
    refreshShell().catch(reportError);
  }, []);

  useEffect(() => {
    function handleKeyDown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowSmartInboxOverlay(true);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      refreshProject(selectedProjectId).catch(reportError);
    } else {
      setResources([]);
      setLocalResources([]);
      setProjectConnectionIds([]);
      api.listTasks({ projectId: null }).then(setTasks).catch(reportError);
    }
  }, [selectedProjectId]);

  async function refreshShell() {
    const [projectList, connectionList] = await Promise.all([
      api.listProjects(),
      api.listConnections(),
    ]);
    setProjects(dedupeProjects(projectList));
    setConnections(connectionList);
    await api.listTasks({ projectId: selectedProjectId }).then(setTasks);
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

  async function submitSmartInput(input, projectId = null) {
    const parsed = parseSmartInput(input);
    const targetProjectId = projectId || selectedProjectId || null;

    const result = await api.createTaskFromInput({
      input,
      parsed: toParsedPayload(parsed),
      projectId: targetProjectId,
    });

    if (result.projectRequired) {
      setPendingInput(input);
      return;
    }

    const resultProjectId = result.task?.projectId || result.resource?.projectId || targetProjectId;
    setNotice(result.notice || (result.created ? "Task created." : "Existing task opened."));
    if (resultProjectId) {
      setSelectedProjectId(resultProjectId);
      await refreshProject(resultProjectId);
    } else {
      setTasks(await api.listTasks({ projectId: null }));
    }
  }

  async function routePendingInput(projectId) {
    if (!pendingInput) return;
    const input = pendingInput;
    setPendingInput(null);
    await submitSmartInput(input, projectId);
  }

  function openTask(task) {
    setSelectedTask(task);
    if (task.projectId) {
      setSelectedProjectId(task.projectId);
    }
  }

  function selectProject(projectId) {
    setSelectedTask(null);
    setSelectedProjectId(projectId);
  }

  function showDashboard() {
    setSelectedTask(null);
    setSelectedProjectId(null);
  }

  function showProjectFromBreadcrumb() {
    setSelectedTask(null);
    if (selectedTask?.projectId) {
      setSelectedProjectId(selectedTask.projectId);
    }
  }

  function reportError(error) {
    setNotice(error?.message || String(error));
  }

  return (
    <AppShell
      projects={projects}
      selectedProjectId={selectedProjectId}
      selectedProject={selectedProject}
      selectedTask={selectedTask}
      selectedTaskProject={selectedTaskProject}
      notice={notice}
      onClearNotice={() => setNotice("")}
      onSelectProject={selectProject}
      onShowInbox={showDashboard}
      onShowProject={showProjectFromBreadcrumb}
      onAddProject={() => setShowProjectForm(true)}
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
              setNotice(result.notice);
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
            setNotice(result.message);
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
              setNotice("Task deleted.");
            } catch (error) {
              reportError(error);
              throw error;
            }
          }}
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
          onSubmit={(input) => submitSmartInput(input, null).catch(reportError)}
          onOpenTask={openTask}
        />
      )}

      {showProjectForm && (
        <ProjectDialog
          onClose={() => setShowProjectForm(false)}
          onCreate={(name, color) => createProject(name, color).catch(reportError)}
        />
      )}

      {pendingInput && (
        <ProjectPickerDialog
          input={pendingInput}
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
            onSubmit={async (input) => {
              await submitSmartInput(input, null);
              setShowSmartInboxOverlay(false);
            }}
          />
        </Modal>
      )}

      {showSettings && (
        <SettingsDialog
          connections={connections}
          onClose={() => setShowSettings(false)}
          onSave={async (payload) => {
            await api.saveConnection(payload);
            setConnections(await api.listConnections());
            setNotice(payload.id ? "Connection updated." : "Connection saved.");
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
              setNotice(result.message);
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
        />
      )}
    </AppShell>
  );
}

export default App;
