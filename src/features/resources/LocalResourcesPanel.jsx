import { useState } from "react";
import { FolderGit2, FolderOpen, Trash2 } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Panel } from "@/components/common/Panel";
import { Button } from "@/components/ui/button";

export function LocalResourcesPanel({ localResources }) {
  return (
    <Panel title="Local resources" icon={FolderGit2}>
      <div className="grid gap-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Clone directories</p>
          <span className="text-xs text-muted-foreground">{localResources.length} linked</span>
        </div>

        {localResources.length === 0 ? (
          <EmptyState text="No local repositories linked." />
        ) : (
          <LocalResourceList localResources={localResources} editable={false} />
        )}
      </div>
    </Panel>
  );
}

export function ProjectLocalResourcesEditor({
  project,
  localResources,
  onChooseDirectory,
  onSaveLocalResource,
  onDeleteLocalResource,
}) {
  const [isChoosing, setIsChoosing] = useState(false);
  const [notice, setNotice] = useState("");

  async function chooseDirectory() {
    setIsChoosing(true);
    setNotice("");
    try {
      const path = await onChooseDirectory();
      if (!path) return;
      await onSaveLocalResource({ projectId: project.id, path });
      setNotice("Local resource linked.");
    } catch (error) {
      setNotice(error?.message || String(error));
    } finally {
      setIsChoosing(false);
    }
  }

  return (
    <div className="grid gap-4">
      <Button type="button" variant="outline" disabled={isChoosing} onClick={chooseDirectory}>
        <FolderOpen className="size-4" />
        {isChoosing ? "Choosing..." : "Add directory"}
      </Button>

      {notice && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}

      {localResources.length === 0 ? (
        <EmptyState text="No local repositories linked." />
      ) : (
        <LocalResourceList
          localResources={localResources}
          editable
          onDeleteLocalResource={async (id) => {
            try {
              await onDeleteLocalResource(id);
              setNotice("Local resource removed.");
            } catch (error) {
              setNotice(error?.message || String(error));
            }
          }}
        />
      )}
    </div>
  );
}

export function LocalResourceList({ localResources, editable, onDeleteLocalResource, onSelectLocalResource }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {localResources.map((resource) => {
        const content = (
          <>
            <div className="min-w-0 max-w-full flex-1 text-left">
              <p className="truncate text-sm font-medium">{resource.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {resource.provider} · {resource.repoUrl}
              </p>
              <p className="truncate text-xs text-blue-700 dark:text-blue-300">{resource.path}</p>
            </div>
            {editable && (
              <Button
                className="shrink-0"
                size="icon-xs"
                variant="ghost"
                type="button"
                title="Remove local resource"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteLocalResource(resource.id);
                }}
              >
                <Trash2 />
              </Button>
            )}
          </>
        );

        if (onSelectLocalResource) {
          return (
            <button
              key={resource.id}
              type="button"
              className="flex min-w-0 w-full items-center gap-2 overflow-hidden rounded-md border bg-card p-3 text-left hover:bg-accent"
              onClick={() => onSelectLocalResource(resource)}
            >
              {content}
            </button>
          );
        }

        return (
          <div key={resource.id} className="flex min-w-0 w-full items-center gap-2 overflow-hidden rounded-md border bg-card p-3">
            {content}
          </div>
        );
      })}
    </div>
  );
}
