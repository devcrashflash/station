import { useEffect, useMemo, useState } from "react";

import "@/App.css";
import { Modal } from "@/components/common/Modal";
import { PullRequestRoutingDialog } from "@/features/pull-requests/PullRequestRoutingDialog";
import { ProjectDialog } from "@/features/projects/ProjectDialog";
import { ProjectPickerDialog } from "@/features/projects/ProjectPickerDialog";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { SmartInput } from "@/features/smart-input/SmartInput";
import { api } from "@/lib/api";
import { isPullRequestInput, parseSmartInput } from "@/lib/smartInputParser";
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
  const [connections, setConnections] = useState([]);
  const [pullRequests, setPullRequests] = useState([]);
  const [selectedTask, setSelectedTask] = useState(null);
  const [pendingInput, setPendingInput] = useState(null);
  const [pendingPullRequest, setPendingPullRequest] = useState(null);
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
      setPullRequests([]);
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
    const [taskList, resourceList, pullRequestList] = await Promise.all([
      api.listTasks({ projectId }),
      api.listProjectResources({ projectId }),
      api.listPullRequests({ projectId }),
    ]);
    setTasks(taskList);
    setResources(resourceList);
    setPullRequests(pullRequestList);
  }

  async function createProject(name, icon = "FolderKanban") {
    const project = await api.createProject({ name, icon });
    setProjects((current) => upsertProject(current, project));
    setSelectedProjectId(project.id);
    setShowProjectForm(false);
    return project;
  }

  async function submitSmartInput(input, projectId = null) {
    const parsed = parseSmartInput(input);
    if (isPullRequestInput(parsed)) {
      setPendingPullRequest({
        input,
        parsed,
        projectId: projectId || selectedProjectId || null,
      });
      return;
    }

    const result = await api.createTaskFromInput({ input, projectId });

    if (result.projectRequired) {
      setPendingInput(input);
      return;
    }

    setNotice(result.created ? "Task created." : "Existing task opened.");
    if (projectId || result.task?.projectId) {
      setSelectedProjectId(result.task.projectId);
      await refreshProject(result.task.projectId);
    } else {
      setTasks(await api.listTasks({ projectId: null }));
    }
  }

  async function routePullRequest({ projectId, taskMode, taskId, taskTitle, linkTask }) {
    if (!pendingPullRequest) return;
    const { parsed } = pendingPullRequest;
    let linkedTaskId = taskId;

    if (taskMode === "new") {
      const taskResult = await api.createTaskFromInput({
        input: taskTitle?.trim() || parsed.title,
        projectId,
      });
      linkedTaskId = taskResult.task?.id || null;
    }

    await api.savePullRequest({
      id: null,
      projectId,
      provider: parsed.provider,
      repoUrl: parsed.repoUrl,
      prUrl: parsed.url,
      title: parsed.title,
      status: "reviewing",
      reviewNotes: "",
      testState: JSON.stringify({ checkout: false, review: false, tests: false }),
    });

    if (linkTask && linkedTaskId) {
      await api.linkTaskResource({
        taskId: linkedTaskId,
        provider: parsed.provider,
        kind: parsed.kind,
        externalId: parsed.externalId,
        url: parsed.url,
      });
    }

    setPendingPullRequest(null);
    setSelectedProjectId(projectId);
    setNotice(linkedTaskId ? "Pull request tracked and linked." : "Pull request tracked.");
    await refreshProject(projectId);
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
          onLoadLinks={(taskId) => api.listTaskLinks({ taskId })}
          onSave={async (payload) => {
            const task = await api.updateTask(payload);
            setSelectedTask(task);
            if (task.projectId) {
              await refreshProject(task.projectId);
            } else {
              setTasks(await api.listTasks({ projectId: null }));
            }
          }}
        />
      ) : selectedProject ? (
        <ProjectWorkspaceView
          project={selectedProject}
          tasks={tasks}
          resources={resources}
          pullRequests={pullRequests}
          connections={connections}
          onRefresh={() => refreshProject(selectedProject.id).catch(reportError)}
          onUpdateProject={async (payload) => {
            const project = await api.updateProject(payload);
            setProjects((current) => upsertProject(current, project));
          }}
          onConnectResource={async (payload) => {
            await api.connectResource(payload);
            await refreshProject(selectedProject.id);
          }}
          onDisconnectResource={async (id) => {
            await api.disconnectResource({ id });
            await refreshProject(selectedProject.id);
          }}
          onUpdateTask={async (payload) => {
            const task = await api.updateTask(payload);
            setSelectedTask((current) => (current?.id === task.id ? task : current));
            await refreshProject(selectedProject.id);
          }}
          onOpenTask={openTask}
          onUpdatePullRequest={async (payload) => {
            await api.updatePullRequestReviewState(payload);
            await refreshProject(selectedProject.id);
          }}
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
          onCreate={(name, icon) => createProject(name, icon).catch(reportError)}
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

      {pendingPullRequest && (
        <PullRequestRoutingDialog
          pending={pendingPullRequest}
          projects={projects}
          onClose={() => setPendingPullRequest(null)}
          onCreateProject={createProject}
          onLoadTasks={(projectId) => api.listTasks({ projectId })}
          onRoute={(payload) => routePullRequest(payload).catch(reportError)}
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
          }}
          onDelete={async (id) => {
            await api.deleteConnection({ id });
            setConnections(await api.listConnections());
          }}
        />
      )}
    </AppShell>
  );
}

export default App;
