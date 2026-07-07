import { ClipboardList } from "lucide-react";

import { Panel } from "@/components/common/Panel";
import { Button } from "@/components/ui/button";
import { ProjectSettingsPanel } from "@/features/projects/ProjectSettingsPanel";
import { PullRequestPanel } from "@/features/pull-requests/PullRequestPanel";
import { ResourcesPanel } from "@/features/resources/ResourcesPanel";
import { TaskList } from "@/features/tasks/TaskList";

export function ProjectWorkspaceView({
  project,
  tasks,
  resources,
  pullRequests,
  connections,
  onRefresh,
  onUpdateProject,
  onConnectResource,
  onDisconnectResource,
  onUpdateTask,
  onOpenTask,
  onUpdatePullRequest,
}) {
  return (
    <div className="grid flex-1 gap-6 overflow-y-auto p-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-6">
        <Panel title="Tasks" icon={ClipboardList}>
          <TaskList tasks={tasks} onOpenTask={onOpenTask} onUpdateTask={onUpdateTask} />
        </Panel>

        <PullRequestPanel
          pullRequests={pullRequests}
          onUpdatePullRequest={onUpdatePullRequest}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <ProjectSettingsPanel project={project} onUpdateProject={onUpdateProject} />
        <ResourcesPanel
          project={project}
          resources={resources}
          connections={connections}
          onConnectResource={onConnectResource}
          onDisconnectResource={onDisconnectResource}
        />
        <Button type="button" variant="outline" onClick={onRefresh}>
          Refresh project
        </Button>
      </div>
    </div>
  );
}
