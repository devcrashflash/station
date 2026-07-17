import { useState } from "react";
import { ClipboardList } from "lucide-react";

import { Panel } from "@/components/common/Panel";
import { Button } from "@/components/ui/button";
import { LocalResourcesPanel } from "@/features/resources/LocalResourcesPanel";
import {
  ProjectEditorDialog,
  ProjectSettingsPanel,
} from "@/features/projects/ProjectSettingsPanel";
import { ResourcesPanel } from "@/features/resources/ResourcesPanel";
import { TaskList } from "@/features/tasks/TaskList";

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

  return (
    <>
      <div className="grid flex-1 gap-6 overflow-y-auto p-6 [scrollbar-gutter:stable] xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Tasks" icon={ClipboardList}>
            <TaskList tasks={tasks} onOpenTask={onOpenTask} onUpdateTask={onUpdateTask} />
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
