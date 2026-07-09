import { CheckCircle2 } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isProviderBackedTask, isTaskDone } from "@/lib/taskStatus";
import { cn } from "@/lib/utils";

export function TaskList({ tasks, onOpenTask, onUpdateTask, readonly = false }) {
  if (!tasks.length) {
    return <EmptyState text="No tasks yet." />;
  }

  return (
    <div className="flex flex-col gap-2">
      {tasks.map((task) => {
        const isProviderBacked = isProviderBackedTask(task);
        const isDone = isTaskDone(task);

        return (
          <div key={task.id} className="flex min-w-0 items-start gap-3 rounded-md border bg-card p-3">
            {!isProviderBacked && (
              <Button
                className={cn(
                  "mt-0.5 size-auto rounded-full p-0 text-muted-foreground hover:bg-transparent",
                  isDone && "text-emerald-600",
                )}
                type="button"
                variant="ghost"
                disabled={readonly}
                title={isDone ? "Mark open" : "Mark done"}
                onClick={(event) => {
                  event.stopPropagation();
                  onUpdateTask({
                    id: task.id,
                    status: isDone ? "open" : "done",
                  });
                }}
              >
                <CheckCircle2 className="size-5" />
              </Button>
            )}
            <button
              className="min-w-0 flex-1 text-left"
              type="button"
              onClick={() => onOpenTask?.(task)}
              title="Open task detail"
            >
              <p className={cn("truncate font-medium", isDone && "text-muted-foreground line-through")}>
                {task.title}
              </p>
              {task.sourceUrl && (
                <span className="mt-1 block min-w-0 max-w-full truncate text-xs text-blue-700">
                  {task.sourceUrl}
                </span>
              )}
            </button>
            <Badge className="shrink-0" variant="secondary">{task.status}</Badge>
          </div>
        );
      })}
    </div>
  );
}
