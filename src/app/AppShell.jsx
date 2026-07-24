import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppBreadcrumb } from "@/features/navigation/AppBreadcrumb";
import { ProjectRail } from "@/features/projects/ProjectRail";
import { shortcutModifier } from "@/lib/keyboardShortcut";

const NOTICE_TIMEOUT_MS = 4000;

export function AppShell({
  projects,
  selectedProjectId,
  selectedProject,
  selectedTask,
  selectedTaskProject,
  title,
  breadcrumbPage,
  isActivitySelected,
  isAgentsSelected,
  hasWaitingAiSession,
  notice,
  noticeKey,
  onClearNotice,
  onSelectProject,
  onShowInbox,
  onShowProject,
  onAddProject,
  onShowActivity,
  onShowAgents,
  onShowSettings,
  onShowSmartInbox,
  children,
}) {
  const [isNoticeHeld, setIsNoticeHeld] = useState(false);
  const shortcutKey = shortcutModifier();

  useEffect(() => {
    if (!notice || isNoticeHeld) {
      return undefined;
    }

    const timeoutId = window.setTimeout(onClearNotice, NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [isNoticeHeld, notice, noticeKey, onClearNotice]);

  useEffect(() => {
    if (!notice) {
      setIsNoticeHeld(false);
    }
  }, [notice]);

  return (
    <TooltipProvider>
      <main className="flex h-screen overflow-hidden bg-background text-foreground">
        <ProjectRail
          projects={projects}
          selectedProjectId={selectedProjectId}
          isActivitySelected={isActivitySelected}
          isAgentsSelected={isAgentsSelected}
          hasWaitingAiSession={hasWaitingAiSession}
          onSelectProject={onSelectProject}
          onShowInbox={onShowInbox}
          onAddProject={onAddProject}
          onShowActivity={onShowActivity}
          onShowAgents={onShowAgents}
          onShowSettings={onShowSettings}
        />

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-16 shrink-0 items-center justify-between border-b bg-background/95 px-6">
            <div className="min-w-0">
              <AppBreadcrumb
                project={selectedProject}
                task={selectedTask}
                taskProject={selectedTaskProject}
                page={breadcrumbPage}
                onShowInbox={onShowInbox}
                onShowProject={onShowProject}
              />
              <h1 className="truncate text-xl font-semibold">
                {title || (selectedTask ? selectedTask.title : selectedProject ? selectedProject.name : "Smart inbox")}
              </h1>
            </div>
            <div className="flex items-center gap-2">
              {notice && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={onClearNotice}
                  onMouseEnter={() => setIsNoticeHeld(true)}
                  onMouseLeave={() => setIsNoticeHeld(false)}
                  onFocus={() => setIsNoticeHeld(true)}
                  onBlur={() => setIsNoticeHeld(false)}
                >
                  {notice}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={onShowSmartInbox}
                title={`Open smart inbox with ${shortcutKey} I`}
              >
                <Sparkles />
                Smart inbox
                <Kbd>{shortcutKey} I</Kbd>
              </Button>
            </div>
          </header>

          {children}
        </section>
      </main>
    </TooltipProvider>
  );
}
