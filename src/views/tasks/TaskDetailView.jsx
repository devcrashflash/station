import { useEffect, useState } from "react";
import { AlertTriangle, Check, ClipboardList, Link2, Pencil, Plus, Trash2, X } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Panel } from "@/components/common/Panel";
import { SelectControl } from "@/components/common/SelectControl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResourceLink, taskLinkMeta } from "@/features/tasks/AttachmentLink";
import { TaskEditDialog } from "@/features/tasks/TaskEditDialog";

const relationTypeOptions = [
  { value: "related", label: "Related" },
  { value: "sub_task", label: "Sub Task" },
];

export function TaskDetailView({
  task,
  project,
  onRefreshExternalDetails,
  onLoadLinks,
  onLoadRelations,
  onSaveRelation,
  onDeleteRelation,
  onLoadProjectTasks,
  onOpenTask,
  onSave,
}) {
  const [links, setLinks] = useState([]);
  const [relations, setRelations] = useState([]);
  const [projectTasks, setProjectTasks] = useState([]);
  const [relationType, setRelationType] = useState("related");
  const [targetTaskId, setTargetTaskId] = useState("");
  const [showEdit, setShowEdit] = useState(false);
  const [externalRefreshState, setExternalRefreshState] = useState({
    connectionRequired: false,
    notice: "",
  });

  useEffect(() => {
    let cancelled = false;

    setExternalRefreshState({
      connectionRequired: false,
      notice: "",
    });

    const loadLinks = () =>
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

    if (onRefreshExternalDetails) {
      onRefreshExternalDetails(task.id)
        .then((result) => {
          if (!cancelled) {
            setLinks(result.links || []);
            setExternalRefreshState({
              connectionRequired: result.connectionRequired === true,
              notice: result.notice || "",
            });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setExternalRefreshState({
              connectionRequired: false,
              notice: "",
            });
          }
          return loadLinks();
        });
    } else {
      loadLinks();
    }

    return () => {
      cancelled = true;
    };
  }, [task.id]);

  useEffect(() => {
    let cancelled = false;
    if (!onLoadRelations) {
      setRelations([]);
      return () => {
        cancelled = true;
      };
    }

    onLoadRelations(task.id)
      .then((items) => {
        if (!cancelled) {
          setRelations(items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRelations([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [task.id, onLoadRelations]);

  useEffect(() => {
    let cancelled = false;

    if (!task.projectId || !onLoadProjectTasks) {
      setProjectTasks([]);
      setTargetTaskId("");
      return () => {
        cancelled = true;
      };
    }

    onLoadProjectTasks(task.projectId)
      .then((items) => {
        if (!cancelled) {
          setProjectTasks(items.filter((item) => item.id !== task.id));
          setTargetTaskId((current) => (
            items.some((item) => item.id === current && item.id !== task.id) ? current : ""
          ));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectTasks([]);
          setTargetTaskId("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [task.id, task.projectId, onLoadProjectTasks]);

  function refreshRelations(cancelled = false) {
    if (!onLoadRelations) {
      setRelations([]);
      return Promise.resolve();
    }

    return onLoadRelations(task.id)
      .then((items) => {
        if (!cancelled) {
          setRelations(items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRelations([]);
        }
      });
  }

  async function addRelation(event) {
    event.preventDefault();
    if (!targetTaskId || !onSaveRelation) return;

    await onSaveRelation({
      sourceTaskId: task.id,
      targetTaskId,
      relationType,
    });
    setTargetTaskId("");
    await refreshRelations();
  }

  async function deleteRelation(id) {
    if (!onDeleteRelation) return;
    await onDeleteRelation(id);
    await refreshRelations();
  }

  async function updateRelationType(relation, relationType) {
    if (!onSaveRelation) return;
    await onSaveRelation({
      id: relation.id,
      sourceTaskId: relation.sourceTaskId,
      targetTaskId: relation.targetTaskId,
      relationType,
    });
    await refreshRelations();
  }

  const relationTaskOptions = projectTasks.map((item) => ({
    value: item.id,
    label: item.title,
  }));
  const taskResource = links[0] || (task.sourceUrl
    ? {
      kind: "source",
      url: task.sourceUrl,
      provider: "external",
      externalTitle: null,
      externalId: task.sourceUrl,
      externalState: null,
    }
    : null);

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
            {taskResource && <Badge variant="secondary">Has resource</Badge>}
          </div>
        </div>
        <Button type="button" onClick={() => setShowEdit(true)}>
          Edit task
        </Button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Notes" icon={ClipboardList}>
          {externalRefreshState.connectionRequired && (
            <div className="mb-4 flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>Please add a Trello connection to this project.</p>
            </div>
          )}
          {task.body ? (
            <p className="whitespace-pre-wrap text-sm leading-6">{task.body}</p>
          ) : (
            <EmptyState text="No notes yet." />
          )}
        </Panel>

        <Panel title="Resource" icon={Link2}>
          <div className="grid gap-2">
            {!taskResource ? (
              <EmptyState text="No external resource attached." />
            ) : (
              <ResourceLink
                label={taskResource.kind.replaceAll("_", " ")}
                url={taskResource.url}
                meta={taskLinkMeta(taskResource)}
              />
            )}
          </div>
        </Panel>
      </div>

      <Panel title="Related tasks" icon={ClipboardList}>
        <div className="grid gap-4">
          {task.projectId && relationTaskOptions.length > 0 && (
            <form className="grid gap-3 md:grid-cols-[160px_minmax(0,1fr)_auto]" onSubmit={addRelation}>
              <SelectControl
                value={relationType}
                onValueChange={setRelationType}
                options={relationTypeOptions}
              />
              <SelectControl
                value={targetTaskId}
                onValueChange={setTargetTaskId}
                options={relationTaskOptions}
                placeholder="Choose a task"
              />
              <Button type="submit" disabled={!targetTaskId}>
                <Plus className="size-4" />
                Add
              </Button>
            </form>
          )}

          {relations.length === 0 ? (
            <EmptyState text="No related tasks yet." />
          ) : (
            <div className="grid gap-2">
              {relations.map((relation) => (
                <RelationRow
                  key={relation.id}
                  relation={relation}
                  taskId={task.id}
                  onOpenTask={onOpenTask}
                  onUpdateRelationType={updateRelationType}
                  onDeleteRelation={deleteRelation}
                />
              ))}
            </div>
          )}
        </div>
      </Panel>

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

function RelationRow({ relation, taskId, onOpenTask, onUpdateRelationType, onDeleteRelation }) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftType, setDraftType] = useState(relation.relationType);
  const relatedTask = relation.relatedTask;
  const relationLabel = relationTypeLabel(relation, taskId);
  const directionLabel = relationDirectionLabel(relation, taskId);

  useEffect(() => {
    setDraftType(relation.relationType);
    setIsEditing(false);
  }, [relation.id, relation.relationType]);

  async function saveEdit() {
    await onUpdateRelationType(relation, draftType);
    setIsEditing(false);
  }

  async function removeRelation() {
    await onDeleteRelation(relation.id);
    setIsEditing(false);
  }

  return (
    <div className="flex min-w-0 items-start gap-3 rounded-md border bg-card p-3">
      <button
        className="min-w-0 flex-1 text-left"
        type="button"
        onClick={() => !isEditing && onOpenTask?.(relatedTask)}
        title="Open task detail"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="min-w-0 max-w-full truncate font-medium">{relatedTask.title}</p>
          <Badge variant="secondary">{relationLabel}</Badge>
          {directionLabel && <Badge variant="secondary">{directionLabel}</Badge>}
          <Badge variant="secondary">{relatedTask.status}</Badge>
        </div>
        {relatedTask.sourceUrl && (
          <span className="mt-2 block min-w-0 max-w-full truncate text-xs text-blue-700">
            {relatedTask.sourceUrl}
          </span>
        )}
      </button>

      {isEditing ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <SelectControl
            value={draftType}
            onValueChange={setDraftType}
            options={relationTypeOptions}
            triggerClassName="w-36"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="Save relation"
            onClick={saveEdit}
          >
            <Check className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="Cancel edit"
            onClick={() => {
              setDraftType(relation.relationType);
              setIsEditing(false);
            }}
          >
            <X className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="Remove relation"
            onClick={removeRelation}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ) : (
        <Button
          className="shrink-0"
          type="button"
          variant="ghost"
          size="icon"
          title="Edit relation"
          onClick={() => setIsEditing(true)}
        >
          <Pencil className="size-4" />
        </Button>
      )}
    </div>
  );
}

function relationTypeLabel(relation, taskId) {
  return relationTypeOptions.find((option) => option.value === relation.relationType)?.label || relation.relationType;
}

function relationDirectionLabel(relation, taskId) {
  if (relation.relationType !== "sub_task") return "";
  return relation.targetTaskId === taskId ? "Parent" : "Child";
}
