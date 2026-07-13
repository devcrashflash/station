import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FolderOpen,
  GitPullRequest,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Modal } from "@/components/common/Modal";
import { Panel } from "@/components/common/Panel";
import { SelectControl } from "@/components/common/SelectControl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { LocalResourceList } from "@/features/resources/LocalResourcesPanel";
import { AttachmentLink, ResourceLink, taskLinkMeta } from "@/features/tasks/AttachmentLink";
import { TaskDescriptionMarkdown } from "@/features/tasks/TaskDescriptionMarkdown";
import { TaskEditDialog } from "@/features/tasks/TaskEditDialog";
import { isPullRequestResource } from "@/lib/api";
import { shortcutModifier } from "@/lib/keyboardShortcut";
import { parseSmartInput } from "@/lib/smartInputParser";
import { taskStatusBadgeLabel } from "@/lib/taskStatus";

const relationTypeOptions = [
  { value: "related", label: "Related" },
  { value: "sub_task", label: "Sub Task" },
];
const EXTERNAL_REFRESH_STALE_MS = 60 * 1000;

function formatLastSyncedAt(value) {
  if (!value) return "Not synced yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not synced yet";

  return `Last synced ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)}`;
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}

function externalFetchedAtMs(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) {
    return numericValue;
  }

  const parsedValue = Date.parse(value);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

function shouldRefreshStaleExternalDetails(link) {
  if (!link?.url) return false;

  const fetchedAt = externalFetchedAtMs(link.fetchedAt);
  return fetchedAt === null || Date.now() - fetchedAt > EXTERNAL_REFRESH_STALE_MS;
}

function formatFileBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? size.toFixed(0) : size.toFixed(size >= 10 ? 1 : 2);
  return `${rounded.replace(/\.0+$/, "")} ${units[unitIndex]}`;
}

function taskFileMeta(file) {
  const sourceLabels = {
    trello: "Trello",
    local: "Local",
  };
  return [
    sourceLabels[file.source] || file.source || "File",
    file.contentType,
    formatFileBytes(file.bytes),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function TaskDetailView({
  task,
  project,
  onRefreshExternalDetails,
  onLoadLinks,
  onLoadRelations,
  onLoadLocalResources,
  onChooseLocalResourceDirectory,
  onSaveLocalResource,
  onCheckoutPullRequestForReview,
  onLoadReviewDiff,
  onLoadReviewDiffFile,
  onSaveRelation,
  onDeleteRelation,
  onLoadProjectTasks,
  onOpenTask,
  onSave,
  onDeleteTask,
}) {
  const [links, setLinks] = useState([]);
  const [relations, setRelations] = useState([]);
  const [projectTasks, setProjectTasks] = useState([]);
  const [relationType, setRelationType] = useState("related");
  const [targetTaskId, setTargetTaskId] = useState("");
  const [showEdit, setShowEdit] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isExternalRefreshing, setIsExternalRefreshing] = useState(false);
  const shortcutKey = shortcutModifier();
  const [externalRefreshState, setExternalRefreshState] = useState({
    connectionRequired: false,
    notice: "",
  });
  const externalRefreshTokenRef = useRef(0);

  useEffect(() => {
    function handleKeyDown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "e") {
        event.preventDefault();
        setShowEdit(true);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timeoutId = null;

    externalRefreshTokenRef.current += 1;
    setIsExternalRefreshing(false);
    setExternalRefreshState({
      connectionRequired: false,
      notice: "",
    });
    setLinks([]);

    const animationId = requestAnimationFrame(() => {
      timeoutId = window.setTimeout(() => {
        if (onLoadLinks) {
          onLoadLinks(task.id)
            .then((items) => {
              if (!cancelled) {
                setLinks(items);
                if (onRefreshExternalDetails && shouldRefreshStaleExternalDetails(items[0])) {
                  refreshExternalDetails();
                }
              }
            })
            .catch(() => {
              if (!cancelled) {
                setLinks([]);
              }
            });
        } else {
          setLinks([]);
        }
      }, 0);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationId);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [task.id]);

  async function refreshExternalDetails() {
    if (!onRefreshExternalDetails || isExternalRefreshing) return;

    const refreshToken = externalRefreshTokenRef.current + 1;
    externalRefreshTokenRef.current = refreshToken;
    setIsExternalRefreshing(true);
    setExternalRefreshState({
      connectionRequired: false,
      notice: "",
    });
    await waitForNextPaint();
    if (externalRefreshTokenRef.current !== refreshToken) return;

    try {
      const result = await onRefreshExternalDetails(task.id);
      if (externalRefreshTokenRef.current === refreshToken) {
        setLinks(result.links || []);
        setExternalRefreshState({
          connectionRequired: result.connectionRequired === true,
          notice: result.notice || "",
        });
      }
    } catch (error) {
      if (externalRefreshTokenRef.current === refreshToken) {
        setExternalRefreshState({
          connectionRequired: false,
          notice: "Could not sync external details. Check the connection and try again.",
        });
      }
    } finally {
      if (externalRefreshTokenRef.current === refreshToken) {
        setIsExternalRefreshing(false);
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    setRelations([]);

    if (!onLoadRelations) {
      return () => {
        cancelled = true;
      };
    }

    let timeoutId = null;
    const animationId = requestAnimationFrame(() => {
      timeoutId = window.setTimeout(() => {
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
      }, 0);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationId);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [task.id, onLoadRelations]);

  useEffect(() => {
    let cancelled = false;
    setProjectTasks([]);
    setTargetTaskId("");

    if (!task.projectId || !onLoadProjectTasks) {
      return () => {
        cancelled = true;
      };
    }

    let timeoutId = null;
    const animationId = requestAnimationFrame(() => {
      timeoutId = window.setTimeout(() => {
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
      }, 0);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationId);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
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

  async function confirmDelete() {
    if (!onDeleteTask || isDeleting) return;
    setIsDeleting(true);
    try {
      await onDeleteTask(task);
    } catch {
      setIsDeleting(false);
    }
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
      fetchedAt: null,
    }
    : null);
  const taskFiles = (links[0]?.files || []).filter((file) => file?.url);
  const reviewParsed = isPullRequestResource(taskResource) ? parseSmartInput(taskResource.url || "") : null;
  const statusBadgeLabel = taskStatusBadgeLabel(task);
  const canReviewResource = Boolean(
    task.projectId &&
    reviewParsed?.repoUrl &&
    onLoadLocalResources &&
    onChooseLocalResourceDirectory &&
    onSaveLocalResource &&
    onCheckoutPullRequestForReview &&
    onLoadReviewDiff &&
    onLoadReviewDiffFile,
  );
  const lastSyncedLabel = taskResource ? formatLastSyncedAt(taskResource.fetchedAt) : "";

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase text-muted-foreground">
            {project?.name || "Task"}
          </p>
          <h2 className="mt-1 break-words text-3xl font-semibold">{task.title}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge variant="secondary">{statusBadgeLabel}</Badge>
            {taskResource && <Badge variant="secondary">Has resource</Badge>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            title={`Edit task with ${shortcutKey} E`}
            onClick={() => setShowEdit(true)}
          >
            Edit task
            <Kbd className="bg-primary-foreground/15 text-primary-foreground">{shortcutKey} E</Kbd>
          </Button>
          <div className="relative">
            <Button
              type="button"
              variant="outline"
              size="icon"
              title="Task actions"
              aria-label="Task actions"
              aria-expanded={showActions}
              onClick={() => setShowActions((current) => !current)}
            >
              <MoreHorizontal className="size-4" />
            </Button>
            {showActions && (
              <div className="absolute right-0 top-full z-20 mt-2 w-44 rounded-md border bg-popover p-1 text-sm shadow-md">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-destructive hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
                  disabled={!onDeleteTask}
                  onClick={() => {
                    setShowActions(false);
                    setShowDeleteConfirm(true);
                  }}
                >
                  <Trash2 className="size-4" />
                  Delete task
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid min-w-0 gap-6">
          <Panel title="Description" icon={ClipboardList}>
            {externalRefreshState.connectionRequired && (
              <div className="mb-4 flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p>{externalRefreshState.notice || "Please add a connection to this project."}</p>
              </div>
            )}
            {task.body ? (
              <TaskDescriptionMarkdown>{task.body}</TaskDescriptionMarkdown>
            ) : (
              <EmptyState text="No description yet." />
            )}
          </Panel>

          {taskFiles.length > 0 && (
            <Panel title="Files" icon={Paperclip}>
              <div className="grid gap-2">
                {taskFiles.map((file) => (
                  <AttachmentLink
                    key={file.id || file.url}
                    label={file.name || file.url}
                    url={file.url}
                    meta={taskFileMeta(file)}
                  />
                ))}
              </div>
            </Panel>
          )}
        </div>

        <div className="grid min-w-0 gap-6">
          <Panel title="Resource" icon={Link2}>
            <div className="grid gap-2">
              {!taskResource ? (
                <EmptyState text="No external resource attached." />
              ) : (
                <>
                  <ResourceLink
                    label={taskResource.kind.replaceAll("_", " ")}
                    url={taskResource.url}
                    meta={taskLinkMeta(taskResource)}
                  />
                  {onRefreshExternalDetails && (
                    <Button
                      className="w-full"
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-busy={isExternalRefreshing}
                      disabled={isExternalRefreshing}
                      onClick={refreshExternalDetails}
                    >
                      {isExternalRefreshing ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="size-4" />
                      )}
                      {isExternalRefreshing ? "Syncing..." : "Sync external"}
                    </Button>
                  )}
                  {canReviewResource && (
                    <Button
                      className="w-full"
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setShowReview(true)}
                    >
                      <GitPullRequest className="size-4" />
                      Review
                    </Button>
                  )}
                  {lastSyncedLabel && (
                    <p className="text-xs text-muted-foreground">{lastSyncedLabel}</p>
                  )}
                  {!externalRefreshState.connectionRequired && externalRefreshState.notice && (
                    <p className="text-xs text-muted-foreground">{externalRefreshState.notice}</p>
                  )}
                </>
              )}
            </div>
          </Panel>

          <Panel title="Related tasks" icon={ClipboardList}>
            <div className="grid gap-4">
              {task.projectId && relationTaskOptions.length > 0 && (
                <form className="grid gap-3" onSubmit={addRelation}>
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
                  <Button className="w-full" type="submit" disabled={!targetTaskId}>
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
        </div>
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

      {showReview && canReviewResource && (
        <ReviewCheckoutDialog
          task={task}
          resource={taskResource}
          parsed={reviewParsed}
          onClose={() => setShowReview(false)}
          onLoadLocalResources={onLoadLocalResources}
          onChooseLocalResourceDirectory={onChooseLocalResourceDirectory}
          onSaveLocalResource={onSaveLocalResource}
          onCheckoutPullRequestForReview={onCheckoutPullRequestForReview}
          onLoadReviewDiff={onLoadReviewDiff}
          onLoadReviewDiffFile={onLoadReviewDiffFile}
        />
      )}

      {showDeleteConfirm && (
        <Modal title="Delete task" onClose={() => !isDeleting && setShowDeleteConfirm(false)}>
          <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">
              This will permanently delete "{task.title}" and remove its resource link and related task links.
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={isDeleting}
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancel
              </Button>
              <Button type="button" variant="destructive" disabled={isDeleting} onClick={confirmDelete}>
                <Trash2 className="size-4" />
                {isDeleting ? "Deleting..." : "Delete task"}
              </Button>
            </div>
          </div>
        </Modal>
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
          <Badge variant="secondary">{taskStatusBadgeLabel(relatedTask)}</Badge>
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

function ReviewCheckoutDialog({
  task,
  resource,
  parsed,
  onClose,
  onLoadLocalResources,
  onChooseLocalResourceDirectory,
  onSaveLocalResource,
  onCheckoutPullRequestForReview,
  onLoadReviewDiff,
  onLoadReviewDiffFile,
}) {
  const [localResources, setLocalResources] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isChoosing, setIsChoosing] = useState(false);
  const [checkoutResourceId, setCheckoutResourceId] = useState("");
  const [reviewSession, setReviewSession] = useState(null);
  const [notice, setNotice] = useState("");

  async function loadLocalResources() {
    setIsLoading(true);
    setNotice("");
    try {
      const items = await onLoadLocalResources({
        projectId: task.projectId,
        repoUrl: parsed.repoUrl,
      });
      setLocalResources(items);
    } catch (error) {
      setLocalResources([]);
      setNotice(error?.message || String(error));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadLocalResources();
  }, [task.projectId, parsed.repoUrl]);

  async function chooseDirectory() {
    setIsChoosing(true);
    setNotice("");
    try {
      const path = await onChooseLocalResourceDirectory();
      if (!path) return;
      const saved = await onSaveLocalResource({
        projectId: task.projectId,
        path,
        expectedProvider: parsed.provider,
        expectedRepoUrl: parsed.repoUrl,
      });
      setLocalResources((current) => [
        saved,
        ...current.filter((item) => item.id !== saved.id),
      ]);
      setNotice("Local resource linked.");
    } catch (error) {
      setNotice(error?.message || String(error));
    } finally {
      setIsChoosing(false);
    }
  }

  async function checkout(localResource) {
    if (checkoutResourceId) return;
    setCheckoutResourceId(localResource.id);
    setNotice("");
    try {
      const result = await onCheckoutPullRequestForReview({
        localResourceId: localResource.id,
        provider: parsed.provider,
        prUrl: resource.url,
      });
      setReviewSession({
        localResourceId: localResource.id,
        branch: result.remoteRef || result.branch,
        baseRef: result.baseRef || null,
        path: result.path,
      });
    } catch (error) {
      setNotice(error?.message || String(error));
    } finally {
      setCheckoutResourceId("");
    }
  }

  if (reviewSession) {
    return (
      <ReviewDiffOverlay
        session={reviewSession}
        onClose={onClose}
        onLoadReviewDiff={onLoadReviewDiff}
        onLoadReviewDiffFile={onLoadReviewDiffFile}
      />
    );
  }

  return (
    <Modal title="Review pull request" onClose={onClose}>
      <div className="grid gap-4">
        <div className="min-w-0 max-w-full overflow-hidden rounded-md border bg-muted/30 p-3">
          <p className="min-w-0 truncate font-medium">{parsed.title}</p>
          <p className="mt-1 min-w-0 truncate text-xs text-muted-foreground">{parsed.repoUrl}</p>
        </div>

        <Button type="button" variant="outline" disabled={isChoosing} onClick={chooseDirectory}>
          <FolderOpen className="size-4" />
          {isChoosing ? "Choosing..." : "Choose another directory"}
        </Button>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading local resources...</p>
        ) : localResources.length === 0 ? (
          <EmptyState text="No matching local repositories linked." />
        ) : (
          <LocalResourceList
            localResources={localResources}
            editable={false}
            onSelectLocalResource={checkout}
          />
        )}

        {checkoutResourceId && (
          <p className="text-sm text-muted-foreground">Checking out review branch...</p>
        )}
        {notice && <p className="break-words text-sm text-muted-foreground">{notice}</p>}
      </div>
    </Modal>
  );
}

function ReviewDiffOverlay({ session, onClose, onLoadReviewDiff, onLoadReviewDiffFile }) {
  const [isLoading, setIsLoading] = useState(true);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [reviewDiff, setReviewDiff] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentFile, setCurrentFile] = useState(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setNotice("");
    setReviewDiff(null);
    setCurrentFile(null);
    setCurrentIndex(0);

    onLoadReviewDiff({
      localResourceId: session.localResourceId,
      branch: session.branch,
      baseRef: session.baseRef,
    })
      .then((result) => {
        if (cancelled) return;
        setReviewDiff(result);
        setCurrentFile(result.currentFile || null);
      })
      .catch((error) => {
        if (cancelled) return;
        setNotice(error?.message || String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [session.localResourceId, session.branch, onLoadReviewDiff]);

  async function showFile(index) {
    if (!reviewDiff || isFileLoading || index < 0 || index >= reviewDiff.files.length) return;
    const path = reviewDiff.files[index];
    setIsFileLoading(true);
    setNotice("");
    try {
      const file = await onLoadReviewDiffFile({
        localResourceId: session.localResourceId,
        baseRef: reviewDiff.baseRef,
        branch: reviewDiff.branch,
        path,
      });
      setCurrentIndex(index);
      setCurrentFile(file);
    } catch (error) {
      setNotice(error?.message || String(error));
    } finally {
      setIsFileLoading(false);
    }
  }

  const files = reviewDiff?.files || [];
  const hasFiles = files.length > 0;
  const currentPath = currentFile?.path || files[currentIndex] || "";

  return (
    <Modal
      title="Review diff"
      onClose={onClose}
      contentClassName="h-[calc(100vh-3rem)] max-h-[calc(100vh-3rem)] w-[calc(100vw-3rem)] max-w-[calc(100vw-3rem)] sm:max-w-[calc(100vw-3rem)]"
    >
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden">
        <div className="grid gap-4">
          <div className="min-w-0 max-w-full overflow-hidden rounded-md border bg-muted/30 p-3">
            <p className="min-w-0 truncate font-medium">{currentPath || session.branch}</p>
            <p className="mt-1 min-w-0 truncate text-xs text-muted-foreground">
              {reviewDiff ? `${reviewDiff.baseRef} -> ${reviewDiff.branch}` : session.path}
            </p>
          </div>

          {hasFiles && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {currentIndex + 1} / {files.length}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={currentIndex === 0 || isFileLoading}
                  onClick={() => showFile(currentIndex - 1)}
                >
                  <ChevronLeft className="size-4" />
                  Prev
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={currentIndex >= files.length - 1 || isFileLoading}
                  onClick={() => showFile(currentIndex + 1)}
                >
                  Next
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="min-h-0 overflow-hidden">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading diff...</p>
          ) : !hasFiles ? (
            <EmptyState text="No changed files found." />
          ) : (
            <pre className="h-full overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {isFileLoading ? "Loading file diff..." : currentFile?.diff || "No diff for this file."}
            </pre>
          )}
        </div>

        {notice && <p className="break-words text-sm text-muted-foreground">{notice}</p>}
      </div>
    </Modal>
  );
}
