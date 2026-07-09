import { useState } from "react";
import { ClipboardList } from "lucide-react";

import { Panel } from "@/components/common/Panel";
import { Button } from "@/components/ui/button";
import {
  LocalResourcesPanel,
  ProjectLocalResourcesDialog,
} from "@/features/resources/LocalResourcesPanel";
import {
  ProjectConnectionsDialog,
  ProjectEditDialog,
  ProjectSettingsPanel,
} from "@/features/projects/ProjectSettingsPanel";
import { ProjectResourcesDialog, ResourcesPanel } from "@/features/resources/ResourcesPanel";
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
  onConnectResource,
  onDisconnectResource,
  onChooseLocalResourceDirectory,
  onSaveLocalResource,
  onDeleteLocalResource,
  onUpdateTask,
  onOpenTask,
}) {
  const [activeOverlay, setActiveOverlay] = useState(null);

  return (
    <>
      <div className="grid flex-1 gap-6 overflow-y-auto p-6 xl:grid-cols-[minmax(0,1fr)_360px]">
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
            onEditProject={() => setActiveOverlay("project")}
            onManageConnections={() => setActiveOverlay("connections")}
          />
          <ResourcesPanel
            resources={resources}
            connections={connections}
            onManageResources={() => setActiveOverlay("resources")}
          />
          <LocalResourcesPanel
            localResources={localResources}
            onManageLocalResources={() => setActiveOverlay("local-resources")}
          />
          <Button type="button" variant="outline" onClick={onRefresh}>
            Refresh project
          </Button>
        </div>
      </div>

      {activeOverlay === "project" && (
        <ProjectEditDialog
          project={project}
          onClose={() => setActiveOverlay(null)}
          onSave={async (payload) => {
            await onUpdateProject(payload);
            setActiveOverlay(null);
          }}
        />
      )}

      {activeOverlay === "connections" && (
        <ProjectConnectionsDialog
          connections={connections}
          projectConnectionIds={projectConnectionIds}
          onClose={() => setActiveOverlay(null)}
          onSave={async (connectionIds) => {
            await onUpdateProjectConnections(connectionIds);
            setActiveOverlay(null);
          }}
        />
      )}

      {activeOverlay === "resources" && (
        <ProjectResourcesDialog
          project={project}
          resources={resources}
          connections={connections}
          projectConnectionIds={projectConnectionIds}
          onClose={() => setActiveOverlay(null)}
          onConnectResource={onConnectResource}
          onDisconnectResource={onDisconnectResource}
        />
      )}

      {activeOverlay === "local-resources" && (
        <ProjectLocalResourcesDialog
          project={project}
          localResources={localResources}
          onClose={() => setActiveOverlay(null)}
          onChooseDirectory={onChooseLocalResourceDirectory}
          onSaveLocalResource={onSaveLocalResource}
          onDeleteLocalResource={onDeleteLocalResource}
        />
      )}
    </>
  );
}
