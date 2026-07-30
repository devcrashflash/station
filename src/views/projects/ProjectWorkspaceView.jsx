import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardList, Search } from "lucide-react";

import { Panel } from "@/components/common/Panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { LocalResourcesPanel } from "@/features/resources/LocalResourcesPanel";
import {
  ProjectEditorDialog,
  ProjectSettingsPanel,
} from "@/features/projects/ProjectSettingsPanel";
import { ResourcesPanel } from "@/features/resources/ResourcesPanel";
import { TaskList } from "@/features/tasks/TaskList";
import { isPrimarySearchShortcut, shortcutModifier } from "@/lib/keyboardShortcut";
import { filterTasksByTitle } from "@/lib/taskSearch";

export function ProjectWorkspaceView({
  project,
  tasks,
  resources,
  localResources,
  connections,
  projectConnectionIds,
  onRefresh,
  onUpdateProject,
  onUpdateProjectConnections,
  onChooseLocalResourceDirectory,
  onSaveLocalResource,
  onDeleteLocalResource,
  onUpdateTask,
  onOpenTask,
}) {
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [taskSearchQuery, setTaskSearchQuery] = useState("");
  const taskSearchInputRef = useRef(null);
  const shortcutKey = shortcutModifier();
  const visibleTasks = useMemo(
    () => filterTasksByTitle(tasks, taskSearchQuery),
    [taskSearchQuery, tasks],
  );

  useEffect(() => {
    setTaskSearchQuery("");
  }, [project.id]);

  useEffect(() => {
    if (isEditorOpen) return undefined;

    function handleKeyDown(event) {
      if (!isPrimarySearchShortcut(event)) return;
      event.preventDefault();
      taskSearchInputRef.current?.focus();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isEditorOpen]);

  return (
    <>
      <div className="grid flex-1 gap-6 overflow-y-auto p-6 [scrollbar-gutter:stable] xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Tasks" icon={ClipboardList}>
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={taskSearchInputRef}
                className="pl-9 pr-16"
                type="search"
                value={taskSearchQuery}
                placeholder="Search tasks"
                aria-label="Search tasks"
                onChange={(event) => setTaskSearchQuery(event.target.value)}
              />
              <Kbd className="absolute right-3 top-1/2 -translate-y-1/2">{shortcutKey} F</Kbd>
            </div>
            <TaskList
              tasks={visibleTasks}
              onOpenTask={onOpenTask}
              onUpdateTask={onUpdateTask}
              emptyText={tasks.length ? "No tasks match your search." : "No tasks yet."}
            />
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <ProjectSettingsPanel
            project={project}
            connections={connections}
            projectConnectionIds={projectConnectionIds}
            onEdit={() => setIsEditorOpen(true)}
          />
          <ResourcesPanel
            resources={resources}
          />
          <LocalResourcesPanel localResources={localResources} />
          <Button type="button" variant="outline" onClick={onRefresh}>
            Refresh project
          </Button>
        </div>
      </div>

      {isEditorOpen && (
        <ProjectEditorDialog
          project={project}
          connections={connections}
          projectConnectionIds={projectConnectionIds}
          localResources={localResources}
          onClose={() => setIsEditorOpen(false)}
          onUpdateProject={onUpdateProject}
          onUpdateProjectConnections={onUpdateProjectConnections}
          onChooseLocalResourceDirectory={onChooseLocalResourceDirectory}
          onSaveLocalResource={onSaveLocalResource}
          onDeleteLocalResource={onDeleteLocalResource}
        />
      )}
    </>
  );
}
