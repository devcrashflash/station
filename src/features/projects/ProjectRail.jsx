import { Plus, Settings, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getProjectInitial, normalizeProjectColor } from "@/lib/projectAvatar";
import { cn } from "@/lib/utils";

export function ProjectRail({
  projects,
  selectedProjectId,
  onSelectProject,
  onShowInbox,
  onAddProject,
  onShowSettings,
}) {
  return (
    <aside className="flex w-20 shrink-0 flex-col items-center border-r bg-sidebar py-4">
      <Button
        className={cn("mb-4", !selectedProjectId && "bg-sidebar-accent")}
        size="icon"
        variant="ghost"
        type="button"
        title="Smart inbox"
        onClick={onShowInbox}
      >
        <Sparkles />
      </Button>

      <div className="flex flex-1 flex-col items-center gap-3 overflow-y-auto px-2">
        {projects.map((project) => {
          return (
            <Button
              key={project.id}
              className={cn(
                "size-12 rounded-lg border text-sm font-semibold text-white shadow-sm",
                selectedProjectId === project.id && "border-primary ring-2 ring-ring ring-offset-2",
              )}
              style={{ backgroundColor: normalizeProjectColor(project.color) }}
              size="icon"
              variant="ghost"
              type="button"
              title={project.name}
              onClick={() => onSelectProject(project.id)}
            >
              {getProjectInitial(project.name)}
            </Button>
          );
        })}

        <Button
          className="size-12 rounded-lg border border-dashed"
          size="icon"
          variant="ghost"
          type="button"
          title="Add project"
          onClick={onAddProject}
        >
          <Plus />
        </Button>
      </div>

      <Button
        className="mt-4"
        size="icon"
        variant="ghost"
        type="button"
        title="Global settings"
        onClick={onShowSettings}
      >
        <Settings />
      </Button>
    </aside>
  );
}
