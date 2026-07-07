import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppBreadcrumb } from "@/features/navigation/AppBreadcrumb";
import { ProjectRail } from "@/features/projects/ProjectRail";

export function AppShell({
  projects,
  selectedProjectId,
  selectedProject,
  selectedTask,
  selectedTaskProject,
  notice,
  onClearNotice,
  onSelectProject,
  onShowInbox,
  onShowProject,
  onAddProject,
  onShowSettings,
  onShowSmartInbox,
  children,
}) {
  return (
    <TooltipProvider>
      <main className="flex min-h-screen bg-background text-foreground">
        <ProjectRail
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
          onShowInbox={onShowInbox}
          onAddProject={onAddProject}
          onShowSettings={onShowSettings}
        />

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 items-center justify-between border-b bg-background/95 px-6">
            <div className="min-w-0">
              <AppBreadcrumb
                project={selectedProject}
                task={selectedTask}
                taskProject={selectedTaskProject}
                onShowInbox={onShowInbox}
                onShowProject={onShowProject}
              />
              <h1 className="truncate text-xl font-semibold">
                {selectedTask ? selectedTask.title : selectedProject ? selectedProject.name : "Smart inbox"}
              </h1>
            </div>
            <div className="flex items-center gap-2">
              {notice && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={onClearNotice}
                >
                  {notice}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={onShowSmartInbox}
                title="Open smart inbox with Command K or Control K"
              >
                <Sparkles />
                Smart inbox
                <Kbd>⌘/Ctrl K</Kbd>
              </Button>
            </div>
          </header>

          {children}
        </section>
      </main>
    </TooltipProvider>
  );
}
