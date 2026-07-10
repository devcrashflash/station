import { useEffect, useState } from "react";
import { GitPullRequest, Plus } from "lucide-react";

import { Modal } from "@/components/common/Modal";
import { SelectControl } from "@/components/common/SelectControl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { providerLabels } from "@/lib/domain";

export function PullRequestRoutingDialog({
  pending,
  projects,
  onClose,
  onCreateProject,
  onLoadTasks,
  onRoute,
}) {
  const [projectId, setProjectId] = useState(pending.projectId || projects[0]?.id || "");
  const [projectTasks, setProjectTasks] = useState([]);
  const [taskMode, setTaskMode] = useState("new");
  const [taskId, setTaskId] = useState("");
  const [taskTitle, setTaskTitle] = useState(pending.parsed.title);
  const [linkTask, setLinkTask] = useState(true);
  const [newProjectName, setNewProjectName] = useState("");

  const projectOptions = projects.map((project) => ({
    value: project.id,
    label: project.name,
  }));
  const taskModeOptions = [
    { value: "new", label: "Create a new task" },
    { value: "existing", label: "Link an existing task", disabled: projectTasks.length === 0 },
    { value: "none", label: "Track without task link" },
  ];
  const taskOptions = projectTasks.map((task) => ({
    value: task.id,
    label: task.title,
  }));

  useEffect(() => {
    if (!projectId && projects[0]?.id) {
      setProjectId(projects[0].id);
    }
  }, [projectId, projects]);

  useEffect(() => {
    if (!projectId) {
      setProjectTasks([]);
      setTaskId("");
      return;
    }

    let cancelled = false;
    onLoadTasks(projectId)
      .then((tasks) => {
        if (cancelled) return;
        setProjectTasks(tasks);
        setTaskId((current) => current || tasks[0]?.id || "");
      })
      .catch(() => {
        if (cancelled) return;
        setProjectTasks([]);
        setTaskId("");
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, onLoadTasks]);

  async function createProject(event) {
    event.preventDefault();
    if (!newProjectName.trim()) return;
    const project = await onCreateProject(newProjectName.trim());
    setProjectId(project.id);
    setNewProjectName("");
  }

  function submit(event) {
    event.preventDefault();
    if (!projectId) return;
    if (taskMode === "existing" && !taskId) return;

    onRoute({
      projectId,
      taskMode,
      taskId: taskMode === "existing" ? taskId : null,
      taskTitle,
      linkTask: taskMode !== "none" && linkTask,
    });
  }

  return (
    <Modal title="Route pull request" onClose={onClose}>
      <div className="mb-4 min-w-0 max-w-full overflow-hidden rounded-md border bg-muted/30 p-3">
        <p className="min-w-0 truncate font-medium">{pending.parsed.title}</p>
        <p className="mt-1 min-w-0 truncate text-xs text-muted-foreground">
          {providerLabels[pending.parsed.provider]} · {pending.parsed.url}
        </p>
      </div>

      {projects.length === 0 ? (
        <form className="grid min-w-0 gap-3" onSubmit={createProject}>
          <Input
            value={newProjectName}
            placeholder="Project name"
            onChange={(event) => setNewProjectName(event.target.value)}
          />
          <Button type="submit" disabled={!newProjectName.trim()}>
            <Plus />
            Create project
          </Button>
        </form>
      ) : (
        <form className="grid min-w-0 gap-4" onSubmit={submit}>
          <Field>
            <FieldLabel>Project</FieldLabel>
            <SelectControl value={projectId} onValueChange={setProjectId} options={projectOptions} />
          </Field>

          <Field>
            <FieldLabel>Task relation</FieldLabel>
            <SelectControl value={taskMode} onValueChange={setTaskMode} options={taskModeOptions} />
          </Field>

          {taskMode === "new" && (
            <Field>
              <FieldLabel>Task title</FieldLabel>
              <Input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} />
            </Field>
          )}

          {taskMode === "existing" && (
            <Field>
              <FieldLabel>Existing task</FieldLabel>
              <SelectControl value={taskId} onValueChange={setTaskId} options={taskOptions} />
            </Field>
          )}

          {taskMode !== "none" && (
            <label className="inline-flex items-center gap-2 text-sm">
              <Checkbox checked={linkTask} onCheckedChange={(checked) => setLinkTask(checked === true)} />
              Show this PR in the task detail
            </label>
          )}

          <Button type="submit" disabled={!projectId || (taskMode === "existing" && !taskId)}>
            <GitPullRequest />
            Track pull request
          </Button>
        </form>
      )}
    </Modal>
  );
}
