import { Activity, Bot, Plus, Settings, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getProjectInitial, normalizeProjectColor } from "@/lib/projectAvatar";
import { cn } from "@/lib/utils";

export function ProjectRail({
  projects,
  selectedProjectId,
  isActivitySelected,
  isAgentsSelected,
  onSelectProject,
  onShowInbox,
  onAddProject,
  onShowActivity,
  onShowAgents,
  onShowSettings,
}) {
  return (
    <aside className="flex h-full w-20 shrink-0 flex-col items-center overflow-hidden border-r bg-sidebar py-4">
      <Button
        className={cn("mb-4 shrink-0", !selectedProjectId && !isActivitySelected && !isAgentsSelected && "bg-sidebar-accent")}
        size="icon"
        variant="ghost"
        type="button"
        title="Smart inbox"
        onClick={onShowInbox}
      >
        <Sparkles />
      </Button>

      <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto px-3 py-1">
        {projects.map((project) => {
          const isSelected = selectedProjectId === project.id;

          return (
            <Button
              key={project.id}
              className={cn(
                "size-12 rounded-lg border-2 border-transparent p-0 text-sm font-semibold text-white shadow-sm transition-[border-color,opacity] focus-visible:ring-0 focus-visible:ring-offset-0",
                isSelected
                  ? "border-white/80 opacity-100 outline outline-2 outline-offset-2 outline-ring"
                  : "opacity-55 hover:opacity-90 focus-visible:opacity-100",
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
        className={cn("mt-4 shrink-0", isAgentsSelected && "bg-sidebar-accent")}
        size="icon"
        variant="ghost"
        type="button"
        title="AI Agents"
        onClick={onShowAgents}
      >
        <Bot />
      </Button>

      <Button
        className={cn("mt-2 shrink-0", isActivitySelected && "bg-sidebar-accent")}
        size="icon"
        variant="ghost"
        type="button"
        title="Activity"
        onClick={onShowActivity}
      >
        <Activity />
      </Button>

      <Button
        className="mt-2 shrink-0"
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
