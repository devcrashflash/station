import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FolderSearch, Plus, Search } from "lucide-react";

import { Modal } from "@/components/common/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { shortcutModifier } from "@/lib/keyboardShortcut";
import { getProjectInitial, normalizeProjectColor } from "@/lib/projectAvatar";
import {
  cycleProjectIndex,
  filterProjectChoices,
} from "@/lib/projectSwitcher";
import { cn } from "@/lib/utils";

export function ProjectSwitcherDialog({
  projects,
  selectedProjectId,
  cycleRequestKey,
  onClose,
  onEscape,
  onSelect,
  onAddProject,
}) {
  const [query, setQuery] = useState("");
  const visibleProjects = useMemo(
    () => filterProjectChoices(projects, query),
    [projects, query],
  );
  const [highlightedProjectId, setHighlightedProjectId] = useState(
    () => projects[0]?.id || null,
  );
  const previousCycleRequestKey = useRef(cycleRequestKey);
  const optionRefs = useRef(new Map());
  const shortcut = shortcutModifier() === "⌘" ? "⌘P" : "Ctrl+P";

  useEffect(() => {
    if (!visibleProjects.some((project) => project.id === highlightedProjectId)) {
      setHighlightedProjectId(visibleProjects[0]?.id || null);
    }
  }, [highlightedProjectId, visibleProjects]);

  useEffect(() => {
    if (previousCycleRequestKey.current === cycleRequestKey) return;
    previousCycleRequestKey.current = cycleRequestKey;
    setHighlightedProjectId((currentId) => {
      const currentIndex = visibleProjects.findIndex((project) => project.id === currentId);
      const nextIndex = cycleProjectIndex(currentIndex, visibleProjects.length);
      return visibleProjects[nextIndex]?.id || null;
    });
  }, [cycleRequestKey, visibleProjects]);

  useEffect(() => {
    optionRefs.current.get(highlightedProjectId)?.scrollIntoView({ block: "nearest" });
  }, [highlightedProjectId]);

  function selectHighlightedProject() {
    if (highlightedProjectId) onSelect(highlightedProjectId);
  }

  function handleKeyDown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const currentIndex = visibleProjects.findIndex((project) => project.id === highlightedProjectId);
      const nextIndex = cycleProjectIndex(
        currentIndex,
        visibleProjects.length,
        event.key === "ArrowUp" ? -1 : 1,
      );
      setHighlightedProjectId(visibleProjects[nextIndex]?.id || null);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      selectHighlightedProject();
      return;
    }
    if (
      !query
      && /^[1-9]$/.test(event.key)
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.shiftKey
    ) {
      const project = visibleProjects[Number(event.key) - 1];
      if (project) {
        event.preventDefault();
        onSelect(project.id);
      }
    }
  }

  return (
    <Modal
      title="Switch project"
      onClose={onClose}
      onEscapeKeyDown={(event) => {
        event.preventDefault();
        onEscape();
      }}
      contentClassName="sm:max-w-xl"
    >
      <div data-project-switcher="">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            className="h-11 pl-9 pr-16"
            value={query}
            placeholder="Search projects"
            aria-label="Search projects"
            aria-controls="project-switcher-list"
            aria-activedescendant={highlightedProjectId ? `project-switcher-${highlightedProjectId}` : undefined}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <Kbd className="absolute right-3 top-1/2 -translate-y-1/2">{shortcut}</Kbd>
        </div>

        <div
          id="project-switcher-list"
          className="mt-3 max-h-[min(24rem,55vh)] overflow-y-auto"
          role="listbox"
          aria-label="Projects"
        >
          {visibleProjects.map((project, index) => {
            const isHighlighted = highlightedProjectId === project.id;
            const isCurrent = selectedProjectId === project.id;
            return (
              <button
                id={`project-switcher-${project.id}`}
                key={project.id}
                ref={(element) => {
                  if (element) optionRefs.current.set(project.id, element);
                  else optionRefs.current.delete(project.id);
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm outline-none",
                  isHighlighted ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                )}
                type="button"
                role="option"
                aria-selected={isHighlighted}
                onClick={() => onSelect(project.id)}
                onMouseMove={() => setHighlightedProjectId(project.id)}
              >
                <span
                  className="grid size-8 shrink-0 place-items-center rounded-md text-xs font-semibold text-white"
                  style={{ backgroundColor: normalizeProjectColor(project.color) }}
                  aria-hidden="true"
                >
                  {getProjectInitial(project.name)}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
                {isCurrent && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Check className="size-3.5" />
                    Current
                  </span>
                )}
                {index < 9 && <Kbd>{index + 1}</Kbd>}
              </button>
            );
          })}

          {visibleProjects.length === 0 && (
            <div className="grid place-items-center gap-3 px-4 py-10 text-center">
              <FolderSearch className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {projects.length === 0 ? "No projects yet." : "No matching projects."}
              </p>
              {projects.length === 0 && (
                <Button type="button" size="sm" onClick={onAddProject}>
                  <Plus />
                  Add project
                </Button>
              )}
            </div>
          )}
        </div>

        {visibleProjects.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Use <Kbd>↑</Kbd> <Kbd>↓</Kbd> to navigate, <Kbd>Enter</Kbd> to open, and <Kbd>Esc</Kbd> to close.
          </p>
        )}
      </div>
    </Modal>
  );
}
