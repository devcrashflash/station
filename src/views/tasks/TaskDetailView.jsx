import { useEffect, useState } from "react";
import { ClipboardList, Link2 } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Panel } from "@/components/common/Panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AttachmentLink, taskLinkMeta } from "@/features/tasks/AttachmentLink";
import { TaskEditDialog } from "@/features/tasks/TaskEditDialog";

export function TaskDetailView({ task, project, onLoadLinks, onSave }) {
  const [links, setLinks] = useState([]);
  const [showEdit, setShowEdit] = useState(false);

  useEffect(() => {
    let cancelled = false;
    onLoadLinks(task.id)
      .then((items) => {
        if (!cancelled) {
          setLinks(items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinks([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [task.id, onLoadLinks]);

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase text-muted-foreground">
            {project?.name || "Task"}
          </p>
          <h2 className="mt-1 text-3xl font-semibold">{task.title}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge variant="secondary">{task.status}</Badge>
            {task.sourceUrl && <Badge variant="secondary">Has source link</Badge>}
          </div>
        </div>
        <Button type="button" onClick={() => setShowEdit(true)}>
          Edit task
        </Button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Notes" icon={ClipboardList}>
          {task.body ? (
            <p className="whitespace-pre-wrap text-sm leading-6">{task.body}</p>
          ) : (
            <EmptyState text="No notes yet." />
          )}
        </Panel>

        <Panel title="Attachments" icon={Link2}>
          <div className="grid gap-2">
            {task.sourceUrl && (
              <AttachmentLink
                label="Source"
                url={task.sourceUrl}
                meta="Captured with this task"
              />
            )}
            {links.length === 0 && !task.sourceUrl ? (
              <EmptyState text="No external links attached." />
            ) : (
              links.map((link) => (
                <AttachmentLink
                  key={`${link.provider}-${link.kind}-${link.externalId}`}
                  label={link.kind.replaceAll("_", " ")}
                  url={link.url}
                  meta={taskLinkMeta(link)}
                />
              ))
            )}
          </div>
        </Panel>
      </div>

      {showEdit && (
        <TaskEditDialog
          task={task}
          onClose={() => setShowEdit(false)}
          onSave={async (payload) => {
            await onSave(payload);
            setShowEdit(false);
          }}
        />
      )}
    </div>
  );
}
