import { Activity, Bot, Plus, Settings, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { shortcutModifier } from "@/lib/keyboardShortcut";
import { getProjectInitial, normalizeProjectColor } from "@/lib/projectAvatar";
import { cn } from "@/lib/utils";

export function ProjectRail({
  projects,
  selectedProjectId,
  isActivitySelected,
  isAgentsSelected,
  hasWaitingAiSession,
  onSelectProject,
  onShowProjectSwitcher,
  onShowInbox,
  onAddProject,
  onShowActivity,
  onShowAgents,
  onShowSettings,
}) {
  const modifier = shortcutModifier();
  const smartInboxShortcut = modifier === "⌘" ? "⌘I" : `${modifier}+I`;
  const aiSessionsShortcut = modifier === "⌘" ? "⌘B" : `${modifier}+B`;
  const projectSwitcherShortcut = modifier === "⌘" ? "⌘P" : `${modifier}+P`;

  return (
    <aside className="flex h-full w-20 shrink-0 flex-col items-center overflow-hidden border-r bg-sidebar py-4">
      <Button
        className={cn("relative mb-4 shrink-0", !selectedProjectId && !isActivitySelected && !isAgentsSelected && "bg-sidebar-accent")}
        size="icon"
        variant="ghost"
        type="button"
        title={`Smart inbox (${smartInboxShortcut})`}
        onClick={onShowInbox}
      >
        <Sparkles />
        <span
          className="absolute -bottom-1 -right-1 rounded-sm border border-sidebar-border bg-sidebar px-0.5 text-[8px] font-medium leading-3 text-muted-foreground shadow-xs"
          aria-hidden="true"
        >
          {smartInboxShortcut}
        </span>
      </Button>

      <div className="min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto py-1">
        <div className="flex min-h-full flex-col gap-3">
          {projects.length > 0 && (
            <div className="relative flex flex-col gap-3">
              <span
                className="pointer-events-none absolute bottom-6 left-2 top-6 w-px bg-sidebar-border"
                aria-hidden="true"
              />
              <button
                className="absolute left-2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 -rotate-90 rounded-sm border border-sidebar-border bg-sidebar px-1 py-0.5 text-[8px] font-semibold leading-none text-muted-foreground shadow-xs transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
                title={`Switch projects (${projectSwitcherShortcut})`}
                aria-label={`Switch projects (${projectSwitcherShortcut})`}
                onClick={onShowProjectSwitcher}
              >
                {projectSwitcherShortcut}
              </button>

              {projects.map((project) => {
                const isSelected = selectedProjectId === project.id;

                return (
                  <div key={project.id} className="relative flex w-full shrink-0 justify-center">
                    <span
                      className="pointer-events-none absolute left-2 top-1/2 h-px w-2 bg-sidebar-border"
                      aria-hidden="true"
                    />
                    <Button
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
                      title={isSelected ? `${project.name} — switch projects (${projectSwitcherShortcut})` : project.name}
                      onClick={() => onSelectProject(project.id)}
                    >
                      {getProjectInitial(project.name)}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex w-full shrink-0 justify-center">
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
        </div>
      </div>

      <Button
        className={cn("relative mt-4 shrink-0", isAgentsSelected && "bg-sidebar-accent")}
        size="icon"
        variant="ghost"
        type="button"
        title={hasWaitingAiSession
          ? `AI Agents — waiting for you (${aiSessionsShortcut})`
          : `AI Agents (${aiSessionsShortcut})`}
        onClick={onShowAgents}
      >
        <Bot />
        {hasWaitingAiSession && (
          <>
            <span
              className="absolute right-1 top-1 size-2 rounded-full bg-orange-500 ring-2 ring-sidebar"
              aria-hidden="true"
            />
            <span className="sr-only">Waiting for you</span>
          </>
        )}
        <span
          className="absolute -bottom-1 -right-1 rounded-sm border border-sidebar-border bg-sidebar px-0.5 text-[8px] font-medium leading-3 text-muted-foreground shadow-xs"
          aria-hidden="true"
        >
          {aiSessionsShortcut}
        </span>
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
