import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ClipboardList, Files, FileText, Inbox, Plus, RefreshCw, Trash2 } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Panel } from "@/components/common/Panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SmartInput } from "@/features/smart-input/SmartInput";
import { TaskList } from "@/features/tasks/TaskList";
import { isSupportedOcrFile } from "@/lib/ocr";
import { cn } from "@/lib/utils";

export function InboxView({
  tasks,
  smartInboxTodos = [],
  recentDirectoryFiles = [],
  onSubmit,
  onFileDrop,
  onOpenTodo,
  onDeleteTodo,
  onOpenRecentFile,
  onRefreshRecentFiles,
  onOpenTask,
}) {
  return (
    <div className="grid flex-1 gap-6 overflow-y-auto p-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="flex min-w-0 flex-col gap-5">
        <div>
          <h2 className="text-3xl font-semibold">Capture work from anywhere</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Add a task, paste a Trello card or board, or route a pull request to a project and task.
          </p>
        </div>
        <SmartInput
          large
          onSubmit={onSubmit}
          onFileDrop={onFileDrop}
        />
        <InboxCaptureTabs
          todos={smartInboxTodos}
          files={recentDirectoryFiles}
          onOpenTodo={onOpenTodo}
          onDeleteTodo={onDeleteTodo}
          onOpenFile={onOpenRecentFile}
          onRefresh={onRefreshRecentFiles}
        />
      </section>

      <aside className="min-w-0">
        <Panel title="Recent tasks" icon={ClipboardList}>
          <TaskList tasks={tasks.slice(0, 8)} onOpenTask={onOpenTask} onUpdateTask={() => {}} readonly />
        </Panel>
      </aside>
    </div>
  );
}

function InboxCaptureTabs({
  todos,
  files,
  onOpenTodo,
  onDeleteTodo,
  onOpenFile,
  onRefresh,
}) {
  const [activeTab, setActiveTab] = useState("todos");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const tabs = [
    { id: "todos", label: "Todos", icon: Inbox },
    { id: "latest-files", label: "Latest files", icon: Files },
  ];

  async function refreshFiles() {
    if (!onRefresh || isRefreshing) return;

    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex w-fit rounded-md border bg-muted/30 p-1" role="tablist" aria-label="Smart inbox captures">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-sm px-3 text-sm font-medium text-muted-foreground transition-colors",
                  "hover:bg-background hover:text-foreground",
                  isActive && "bg-background text-foreground shadow-xs",
                )}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon className="size-4" />
                {tab.label}
              </button>
            );
          })}
        </div>
        {activeTab === "latest-files" && onRefresh && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Refresh latest files"
                disabled={isRefreshing}
                onClick={refreshFiles}
              >
                <RefreshCw className={isRefreshing ? "animate-spin" : ""} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh latest files</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div role="tabpanel" aria-label={activeTab === "todos" ? "Todos" : "Latest files"}>
        {activeTab === "todos" ? (
          <SmartInboxTodoList
            todos={todos}
            onOpenTodo={onOpenTodo}
            onDeleteTodo={onDeleteTodo}
          />
        ) : (
          <RecentDirectoryFilesList
            files={files}
            onOpenFile={onOpenFile}
          />
        )}
      </div>
    </div>
  );
}

export function SmartInboxTodoList({ todos = [], onOpenTodo, onDeleteTodo }) {
  if (todos.length === 0) return <EmptyState text="No todos yet." />;

  return (
    <div className="flex flex-col gap-2">
      {todos.map((todo) => (
        <SmartInboxTodoItem
          key={todo.id}
          todo={todo}
          onOpenTodo={onOpenTodo}
          onDeleteTodo={onDeleteTodo}
        />
      ))}
    </div>
  );
}

function SmartInboxTodoItem({ todo, onOpenTodo, onDeleteTodo }) {
  const isMissing = todo.kind === "file" && todo.fileMissing;
  const canCreateTask = Boolean(onOpenTodo) && !isMissing;

  return (
    <div
      className={cn(
        "grid min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border bg-card p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]",
        isMissing && "border-destructive/30 bg-destructive/5",
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted/40">
        <FileText className={cn("size-4 text-muted-foreground", isMissing && "text-destructive")} />
      </span>
      <button
        type="button"
        className="min-w-0 overflow-hidden text-left"
        disabled={!canCreateTask}
        onClick={() => onOpenTodo?.(todo)}
        title={isMissing ? "File is missing" : "Create task"}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium">{todo.title}</span>
          {isMissing && (
            <Badge variant="secondary" className="shrink-0 border border-destructive/30 bg-destructive/10 text-destructive">
              Missing
            </Badge>
          )}
        </span>
        <span className="mt-1 block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
          {todoSubtitle(todo)}
        </span>
      </button>
      <Button
        type="button"
        size="sm"
        className="col-start-2 row-start-2 w-fit sm:col-start-auto sm:row-start-auto"
        onClick={() => onOpenTodo?.(todo)}
        disabled={!canCreateTask}
      >
        <Plus />
        Create task
      </Button>
      <span className="col-start-3 row-start-1 sm:col-start-auto sm:row-start-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Delete todo"
              disabled={!onDeleteTodo}
              onClick={() => onDeleteTodo?.(todo)}
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete todo</TooltipContent>
        </Tooltip>
      </span>
    </div>
  );
}

function todoSubtitle(todo) {
  if (todo.kind === "file" && todo.fileMissing) {
    return [todo.fileName, "File missing", todo.filePath].filter(Boolean).join(" · ");
  }
  if (todo.kind === "file") {
    return [todo.fileName, todo.filePath, todo.mimeType].filter(Boolean).join(" · ") || "File";
  }
  return todo.rawText || "Plain text";
}

export function RecentDirectoryFilesList({ files = [], onOpenFile, onRefresh }) {
  return (
    <div className="grid gap-2">
      {files.length === 0 ? (
        <EmptyState text="No latest files." />
      ) : (
        <div className="flex flex-col gap-2">
          {files.slice(0, 5).map((file) => (
            <div
              key={file.path}
              className="flex min-w-0 max-w-full items-center gap-3 rounded-md border bg-card p-3"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden text-left transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!onOpenFile}
                onClick={() => onOpenFile?.(file)}
                title="Create task"
              >
                <RecentFilePreview file={file} />
                <span className="min-w-0 flex-1 overflow-hidden">
                  <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium">{file.name}</span>
                  <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
                    {file.directoryName} · {file.relativePath || file.path}
                  </span>
                </span>
              </button>
              <Button
                type="button"
                size="sm"
                className="shrink-0"
                onClick={() => onOpenFile?.(file)}
                disabled={!onOpenFile}
              >
                <Plus />
                Create task
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecentFilePreview({ file }) {
  const [failed, setFailed] = useState(false);
  const isImage = isSupportedOcrFile({ name: file.name || file.path, mimeType: "" });

  if (isImage && !failed) {
    return (
      <img
        className="size-12 shrink-0 rounded-md border object-cover"
        src={convertFileSrc(file.path)}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span className="flex size-12 shrink-0 items-center justify-center rounded-md border bg-muted/40">
      <FileText className="size-4 text-muted-foreground" />
    </span>
  );
}
