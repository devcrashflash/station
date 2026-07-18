import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
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
  SquareKanban,
  Trash2,
  X,
} from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { Modal } from "@/components/common/Modal";
import { Panel } from "@/components/common/Panel";
import { SelectControl } from "@/components/common/SelectControl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { ReviewDiff } from "@/features/pull-requests/ReviewDiff";
import { LocalResourceList } from "@/features/resources/LocalResourcesPanel";
import { AttachmentLink, ResourceLink, taskLinkMeta } from "@/features/tasks/AttachmentLink";
import { TaskDescriptionMarkdown } from "@/features/tasks/TaskDescriptionMarkdown";
import { TaskCommentsPanel } from "@/features/tasks/TaskCommentsPanel";
import { TaskEditDialog } from "@/features/tasks/TaskEditDialog";
import { AiPromptWizard } from "@/features/tasks/AiPromptWizard";
import { TrelloTicketWizard } from "@/features/tasks/TrelloTicketWizard";
import { isPullRequestResource } from "@/lib/api";
import { aiPromptIconFor } from "@/lib/aiPromptIcons";
import { externalLabelStyle } from "@/lib/externalLabels";
import { shortcutModifier } from "@/lib/keyboardShortcut";
import { parseSmartInput } from "@/lib/smartInputParser";
import {
  createLatestRequestGuard,
  isClosedReviewState,
  normalizeReviewDiffFile,
  normalizeReviewDiffResult,
  normalizeReviewDrafts,
} from "@/lib/reviewSession";
import { taskStatusBadgeLabel, taskStatusBadgeStyle } from "@/lib/taskStatus";
import { canCreateTrelloTicket } from "@/lib/trelloTicket";

const relationTypeOptions = [
  { value: "related", label: "Related" },
  { value: "sub_task", label: "Sub Task" },
];

const aiAgentLabels = {
  codex: "Codex",
  claude: "Claude",
};
const EXTERNAL_REFRESH_STALE_MS = 60 * 1000;

function waitForPaint() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

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

function ExternalLabels({ labels }) {
  if (!Array.isArray(labels) || labels.length === 0) return null;

  return (
    <div className="mt-3 grid gap-1.5" aria-label="External labels">
      <p className="text-xs font-medium text-muted-foreground">Labels</p>
      <div className="flex flex-wrap gap-1.5">
        {labels.map((label) => {
          const style = externalLabelStyle(label.color);
          return (
            <Badge
              key={label.name}
              variant={style ? "outline" : "secondary"}
              className={style ? "border-transparent" : undefined}
              style={style}
              title={label.name}
            >
              {label.name}
            </Badge>
          );
        })}
      </div>
    </div>
  );
}

export function TaskDetailView({
  task,
  project,
  aiPrompts = [],
  localResources = [],
  onOpenAiPromptThread,
  onRefreshExternalDetails,
  onLoadLinks,
  onLoadRelations,
  onLoadLocalResources,
  onChooseLocalResourceDirectory,
  onSaveLocalResource,
  onCheckoutPullRequestForReview,
  onLoadReviewDiff,
  onLoadReviewDiffFile,
  onListReviewCommentDrafts,
  onSaveReviewCommentDraft,
  onDeleteReviewCommentDraft,
  onSubmitReviewComments,
  onSaveRelation,
  onDeleteRelation,
  onLoadProjectTasks,
  onOpenTask,
  onSave,
  onDeleteTask,
  onLoadTrelloBoards,
  onLoadTrelloTemplates,
  onConvertToTrelloTicket,
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
  const [showTrelloWizard, setShowTrelloWizard] = useState(false);
  const [activeAiPromptId, setActiveAiPromptId] = useState("");
  const [trelloBoards, setTrelloBoards] = useState([]);
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

  useEffect(() => {
    let cancelled = false;
    setTrelloBoards([]);
    if (!task.projectId || !onLoadTrelloBoards) return () => {};

    onLoadTrelloBoards(task.id)
      .then((items) => {
        if (!cancelled) setTrelloBoards(items || []);
      })
      .catch(() => {
        if (!cancelled) setTrelloBoards([]);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, task.projectId]);

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
  const supportsComments = Boolean(
    taskResource && (
      (taskResource.provider === "trello" && taskResource.kind === "trello_card") ||
      (taskResource.provider === "github" && taskResource.kind === "pull_request") ||
      (taskResource.provider === "gitlab" && taskResource.kind === "merge_request")
    ),
  );
  const reviewParsed = isPullRequestResource(taskResource) ? parseSmartInput(taskResource.url || "") : null;
  const isReviewRequestClosed = isClosedReviewState(taskResource?.externalState);
  const statusBadgeLabel = taskStatusBadgeLabel(task);
  const statusBadgeStyle = taskStatusBadgeStyle(task);
  const canReviewResource = Boolean(
    task.projectId &&
    !isReviewRequestClosed &&
    reviewParsed?.repoUrl &&
    onLoadLocalResources &&
    onChooseLocalResourceDirectory &&
    onSaveLocalResource &&
    onCheckoutPullRequestForReview &&
    onLoadReviewDiff &&
    onLoadReviewDiffFile &&
    onListReviewCommentDrafts &&
    onSaveReviewCommentDraft &&
    onDeleteReviewCommentDraft &&
    onSubmitReviewComments,
  );
  const lastSyncedLabel = taskResource ? formatLastSyncedAt(taskResource.fetchedAt) : "";
  const canConvertToTrello = !taskResource && canCreateTrelloTicket(task, trelloBoards);

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6 [scrollbar-gutter:stable]">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase text-muted-foreground">
            {project?.name || "Task"}
          </p>
          <h2 className="mt-1 break-words text-3xl font-semibold">{task.title}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge
              variant={statusBadgeStyle ? "outline" : "secondary"}
              className={statusBadgeStyle ? "border-transparent" : undefined}
              style={statusBadgeStyle}
            >
              {statusBadgeLabel}
            </Badge>
            {taskResource && <Badge variant="secondary">Has resource</Badge>}
          </div>
          <ExternalLabels labels={taskResource?.labels} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {canConvertToTrello && (
            <Button type="button" variant="outline" onClick={() => setShowTrelloWizard(true)}>
              <SquareKanban className="size-4" />
              Create Trello ticket
            </Button>
          )}
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
              <div className="mb-4 flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
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

          {supportsComments && <TaskCommentsPanel comments={taskResource.comments || []} />}

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

          <Panel title="AI Prompts" icon={Bot}>
            <div className="grid gap-2">
              {aiPrompts.length === 0 ? (
                <EmptyState text="No AI Prompts configured." />
              ) : (
                aiPrompts.map((prompt) => {
                  const PromptIcon = aiPromptIconFor(prompt.icon);
                  return (
                    <Button
                      key={prompt.id}
                      className="w-full justify-start"
                      type="button"
                      variant="outline"
                      onClick={() => setActiveAiPromptId(prompt.id)}
                    >
                      <PromptIcon className="size-4" />
                      <span className="min-w-0 flex-1 truncate text-left">{prompt.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {aiAgentLabels[prompt.agentType] || prompt.agentType}
                      </span>
                    </Button>
                  );
                })
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

      {showTrelloWizard && canConvertToTrello && (
        <TrelloTicketWizard
          task={task}
          boards={trelloBoards}
          onClose={() => setShowTrelloWizard(false)}
          onLoadTemplates={onLoadTrelloTemplates}
          onConvert={async (payload) => {
            const result = await onConvertToTrelloTicket(payload);
            setLinks(result.link ? [result.link] : []);
            setShowTrelloWizard(false);
          }}
        />
      )}

      {activeAiPromptId && (
        <AiPromptWizard
          key={activeAiPromptId}
          task={task}
          prompts={aiPrompts}
          initialPromptId={activeAiPromptId}
          localResources={localResources}
          onClose={() => setActiveAiPromptId("")}
          onStart={onOpenAiPromptThread}
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
          onListReviewCommentDrafts={onListReviewCommentDrafts}
          onSaveReviewCommentDraft={onSaveReviewCommentDraft}
          onDeleteReviewCommentDraft={onDeleteReviewCommentDraft}
          onSubmitReviewComments={onSubmitReviewComments}
          onSubmitted={(link) => link && setLinks([link])}
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
  const statusBadgeStyle = taskStatusBadgeStyle(relatedTask);
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
          <Badge
            variant={statusBadgeStyle ? "outline" : "secondary"}
            className={statusBadgeStyle ? "border-transparent" : undefined}
            style={statusBadgeStyle}
          >
            {taskStatusBadgeLabel(relatedTask)}
          </Badge>
        </div>
        {relatedTask.sourceUrl && (
          <span className="mt-2 block min-w-0 max-w-full truncate text-xs text-blue-700 dark:text-blue-300">
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
  onListReviewCommentDrafts,
  onSaveReviewCommentDraft,
  onDeleteReviewCommentDraft,
  onSubmitReviewComments,
  onSubmitted,
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
    await waitForPaint();
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
      <ErrorBoundary
        resetKeys={[task.id, reviewSession.localResourceId, reviewSession.branch]}
        fallback={({ error, reset }) => (
          <Modal title="Review could not be displayed" onClose={onClose}>
            <div className="grid gap-4">
              <p className="text-sm text-muted-foreground">
                The checked-out branch and saved review drafts are unchanged.
              </p>
              <p className="break-words rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
                {error?.message || String(error)}
              </p>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={onClose}>Close</Button>
                <Button type="button" onClick={reset}>Retry review</Button>
              </div>
            </div>
          </Modal>
        )}
      >
        <ReviewDiffOverlay
          taskId={task.id}
          session={reviewSession}
          onClose={onClose}
          onLoadReviewDiff={onLoadReviewDiff}
          onLoadReviewDiffFile={onLoadReviewDiffFile}
          onListReviewCommentDrafts={onListReviewCommentDrafts}
          onSaveReviewCommentDraft={onSaveReviewCommentDraft}
          onDeleteReviewCommentDraft={onDeleteReviewCommentDraft}
          onSubmitReviewComments={onSubmitReviewComments}
          onSubmitted={onSubmitted}
        />
      </ErrorBoundary>
    );
  }

  const checkoutResource = localResources.find((item) => item.id === checkoutResourceId);

  return (
    <Modal title="Review pull request" onClose={onClose}>
      <div className="grid gap-4">
        <ResourceLink
          label={parsed.title}
          url={resource.url}
          meta={parsed.repoUrl}
        />

        {checkoutResourceId ? (
          <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-4" role="status" aria-live="polite">
            <LoaderCircle className="size-5 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
            <div className="min-w-0">
              <p className="font-medium">Preparing review branch</p>
              <p className="text-sm text-muted-foreground">
                The branch is being checked out and updated{checkoutResource?.name ? ` in ${checkoutResource.name}` : ""}. This may take a moment.
              </p>
            </div>
          </div>
        ) : (
          <>
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
          </>
        )}
        {notice && (
          <div className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <p className="break-words text-sm text-destructive">{notice}</p>
            <a className="break-all text-sm text-blue-700 underline dark:text-blue-300" href={resource.url} target="_blank" rel="noreferrer">
              Open {parsed.provider === "github" ? "pull request" : "merge request"}
            </a>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ReviewDiffOverlay({
  taskId,
  session,
  onClose,
  onLoadReviewDiff,
  onLoadReviewDiffFile,
  onListReviewCommentDrafts,
  onSaveReviewCommentDraft,
  onDeleteReviewCommentDraft,
  onSubmitReviewComments,
  onSubmitted,
}) {
  const [isLoading, setIsLoading] = useState(true);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [reviewDiff, setReviewDiff] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentFile, setCurrentFile] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [overallBody, setOverallBody] = useState("");
  const [isDraftsLoading, setIsDraftsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const draftRequestGuardRef = useRef(null);
  const diffRequestGuardRef = useRef(null);
  const fileRequestGuardRef = useRef(null);
  const loadedSessionKeyRef = useRef("");
  const reviewDiffRef = useRef(null);
  if (!draftRequestGuardRef.current) draftRequestGuardRef.current = createLatestRequestGuard();
  if (!diffRequestGuardRef.current) diffRequestGuardRef.current = createLatestRequestGuard();
  if (!fileRequestGuardRef.current) fileRequestGuardRef.current = createLatestRequestGuard();

  useEffect(() => () => {
    fileRequestGuardRef.current.invalidate();
  }, []);

  useEffect(() => {
    const guard = draftRequestGuardRef.current;
    const request = guard.begin();
    setIsDraftsLoading(true);
    onListReviewCommentDrafts({ taskId })
      .then((items) => {
        if (!guard.isCurrent(request)) return;
        const normalizedDrafts = normalizeReviewDrafts(items);
        setDrafts(normalizedDrafts);
        setOverallBody(normalizedDrafts.find((draft) => draft.kind === "overall")?.body || "");
      })
      .catch((error) => {
        if (guard.isCurrent(request)) setNotice(error?.message || String(error));
      })
      .finally(() => {
        if (guard.isCurrent(request)) setIsDraftsLoading(false);
      });
    return () => {
      guard.invalidate();
    };
  }, [onListReviewCommentDrafts, taskId]);

  useEffect(() => {
    const guard = diffRequestGuardRef.current;
    const request = guard.begin();
    const sessionKey = [session.localResourceId, session.branch, session.baseRef || ""].join("\n");
    if (loadedSessionKeyRef.current !== sessionKey) {
      loadedSessionKeyRef.current = sessionKey;
      setReviewDiff(null);
      setCurrentFile(null);
      setCurrentIndex(0);
    }
    setIsLoading(true);
    setNotice("");
    setLoadError("");

    onLoadReviewDiff({
      localResourceId: session.localResourceId,
      branch: session.branch,
      baseRef: session.baseRef,
    })
      .then((result) => {
        if (!guard.isCurrent(request)) return;
        const normalizedResult = normalizeReviewDiffResult(result);
        setReviewDiff(normalizedResult);
        setCurrentFile(normalizedResult.currentFile);
        setCurrentIndex(0);
      })
      .catch((error) => {
        if (!guard.isCurrent(request)) return;
        const message = error?.message || String(error);
        setLoadError(message);
        setNotice(message);
      })
      .finally(() => {
        if (guard.isCurrent(request)) {
          setIsLoading(false);
        }
      });

    return () => {
      guard.invalidate();
    };
  }, [loadAttempt, onLoadReviewDiff, session.baseRef, session.branch, session.localResourceId]);

  const showFile = useCallback(async (index) => {
    if (!reviewDiff || isFileLoading || index < 0 || index >= reviewDiff.files.length) return;
    const path = reviewDiff.files[index];
    const guard = fileRequestGuardRef.current;
    const request = guard.begin();
    setIsFileLoading(true);
    setNotice("");
    try {
      const result = await onLoadReviewDiffFile({
        localResourceId: session.localResourceId,
        baseRef: reviewDiff.baseRef,
        branch: reviewDiff.branch,
        path,
      });
      if (!guard.isCurrent(request)) return;
      const file = normalizeReviewDiffFile(result, path);
      setCurrentIndex(index);
      setCurrentFile(file);
    } catch (error) {
      if (guard.isCurrent(request)) setNotice(error?.message || String(error));
    } finally {
      if (guard.isCurrent(request)) setIsFileLoading(false);
    }
  }, [isFileLoading, onLoadReviewDiffFile, reviewDiff, session.localResourceId]);

  const files = reviewDiff?.files || [];
  const hasFiles = files.length > 0;
  const currentPath = currentFile?.path || files[currentIndex] || "";
  const baseRef = reviewDiff?.baseRef || session.baseRef;
  const branch = reviewDiff?.branch || session.branch;
  const inlineDrafts = drafts.filter((draft) => draft.kind === "inline");
  const overallDraft = drafts.find((draft) => draft.kind === "overall");
  const currentFileDraftCount = inlineDrafts.filter((draft) => draft.path === currentPath).length;
  const staleDrafts = reviewDiff?.headSha ? inlineDrafts.filter(
    (draft) => draft.headSha && draft.headSha !== reviewDiff.headSha,
  ) : [];
  const hasStaleDrafts = staleDrafts.length > 0;

  async function saveDraft(input) {
    setNotice("");
    try {
      const saved = await onSaveReviewCommentDraft({ ...input, taskId });
      setDrafts((current) => [saved, ...current.filter((draft) => draft.id !== saved.id)]);
      return saved;
    } catch (error) {
      setNotice(error?.message || String(error));
      throw error;
    }
  }

  async function deleteDraft(id) {
    setNotice("");
    try {
      await onDeleteReviewCommentDraft({ id });
      setDrafts((current) => current.filter((draft) => draft.id !== id));
    } catch (error) {
      setNotice(error?.message || String(error));
    }
  }

  async function submitReview() {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setNotice("");
    try {
      const result = await onSubmitReviewComments({ taskId, overallBody });
      setDrafts(result.remainingDrafts || []);
      setNotice(result.notice || "Review comments published.");
      onSubmitted?.(result.link);
      if ((result.failures || []).length === 0) {
        setOverallBody("");
        setShowSubmitConfirm(false);
      }
    } catch (error) {
      setNotice(error?.message || String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }

      if (event.key === "ArrowLeft" && currentIndex > 0) {
        event.preventDefault();
        showFile(currentIndex - 1);
      } else if (event.key === "ArrowRight" && currentIndex < files.length - 1) {
        event.preventDefault();
        showFile(currentIndex + 1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentIndex, files.length, showFile]);

  function handleEscapeKeyDown(event) {
    if (reviewDiffRef.current?.cancelInteraction()) {
      event.preventDefault();
    }
  }

  return (
    <Modal
      title={(
        <span className="flex min-w-0 items-baseline gap-2 pr-8">
          <span className="shrink-0">Review diff</span>
          {(baseRef || branch) && (
            <span className="truncate text-xs font-normal text-muted-foreground">
              {baseRef && branch ? `${baseRef} → ${branch}` : branch || baseRef}
            </span>
          )}
        </span>
      )}
      onClose={onClose}
      onEscapeKeyDown={handleEscapeKeyDown}
      contentClassName="h-[calc(100dvh-3rem)] w-[calc(100vw-3rem)] max-w-[calc(100vw-3rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-[calc(100vw-3rem)]"
    >
      <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden">
        {hasFiles ? (
          <div className="flex min-w-0 items-center justify-between gap-3">
            <p className="flex min-w-0 items-baseline gap-2 text-sm">
              <span className="shrink-0 text-muted-foreground">
                {currentIndex + 1} / {files.length}
              </span>
              <span className="truncate font-medium" title={currentPath}>{currentPath}</span>
              {currentFileDraftCount > 0 && <Badge variant="outline">{currentFileDraftCount} draft{currentFileDraftCount === 1 ? "" : "s"}</Badge>}
            </p>
            <div className="flex shrink-0 items-center gap-2">
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
        ) : (
          <span />
        )}

        <div className="min-h-0 overflow-hidden">
          {isLoading && !reviewDiff ? (
            <p className="text-sm text-muted-foreground">Loading diff...</p>
          ) : loadError && !reviewDiff ? (
            <div className="grid place-items-center gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-6 text-center">
              <p className="max-w-xl break-words text-sm text-destructive">{loadError}</p>
              <Button type="button" variant="outline" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
                <RefreshCw className="size-4" />
                Retry loading review
              </Button>
            </div>
          ) : !hasFiles ? (
            <EmptyState text="No changed files found." />
          ) : isFileLoading ? (
            <pre className="max-h-full overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              Loading file diff...
            </pre>
          ) : currentFile?.diff ? (
            <ReviewDiff
              ref={reviewDiffRef}
              key={currentPath}
              path={currentPath}
              oldPath={currentFile.oldPath}
              newPath={currentFile.newPath}
              diff={currentFile.diff}
              drafts={inlineDrafts}
              headSha={reviewDiff.headSha}
              disabled={isSubmitting}
              onSaveDraft={saveDraft}
              onDeleteDraft={deleteDraft}
            />
          ) : (
            <pre className="max-h-full overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              No diff for this file.
            </pre>
          )}
        </div>

        <div className="grid gap-3 border-t pt-3">
          {hasStaleDrafts && (
            <div className="grid gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <p>Some inline drafts belong to an older revision. Re-anchor or delete them before submitting.</p>
              {staleDrafts.map((draft) => (
                <div key={draft.id} className="flex items-start gap-2 rounded border border-amber-300/70 bg-white/60 p-2 dark:border-amber-900/70 dark:bg-black/20">
                  <p className="min-w-0 flex-1">
                    <span className="font-mono text-xs">{draft.path}:{draft.side === "LEFT" ? draft.oldLine : draft.newLine}</span>
                    <span className="ml-2 break-words">{draft.body}</span>
                  </p>
                  <Button type="button" variant="ghost" size="sm" disabled={isSubmitting} onClick={() => deleteDraft(draft.id)}>Delete</Button>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {inlineDrafts.length} inline draft{inlineDrafts.length === 1 ? "" : "s"}
            </p>
            <Button type="button" disabled={hasStaleDrafts || isSubmitting || isDraftsLoading} onClick={() => setShowSubmitConfirm(true)}>
              Submit review
            </Button>
          </div>
          {overallDraft?.lastError && <p className="text-xs text-destructive">{overallDraft.lastError}</p>}
          {notice && <p className="break-words text-sm text-muted-foreground">{notice}</p>}
        </div>
      </div>
      {showSubmitConfirm && (
        <Modal title="Submit review" onClose={() => !isSubmitting && setShowSubmitConfirm(false)} contentClassName="sm:max-w-xl">
          <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">
              {inlineDrafts.length} inline comment{inlineDrafts.length === 1 ? "" : "s"} will be published.
            </p>
            <Textarea
              autoFocus
              className="min-h-28"
              value={overallBody}
              placeholder="Overall comment (optional)"
              disabled={isSubmitting}
              onChange={(event) => setOverallBody(event.target.value)}
            />
            {notice && <p className="break-words text-sm text-destructive">{notice}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={isSubmitting} onClick={() => setShowSubmitConfirm(false)}>Cancel</Button>
              <Button type="button" disabled={isSubmitting || (inlineDrafts.length === 0 && !overallBody.trim())} onClick={submitReview}>
                {isSubmitting ? "Publishing…" : "Publish review"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
