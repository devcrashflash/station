import { ClipboardList } from "lucide-react";

import { Panel } from "@/components/common/Panel";
import { SmartInput } from "@/features/smart-input/SmartInput";
import { TaskList } from "@/features/tasks/TaskList";

export function InboxView({ tasks, onSubmit, onOpenTask }) {
  return (
    <div className="flex flex-1 flex-col gap-8 overflow-y-auto px-8 py-10">
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <div>
          <h2 className="text-3xl font-semibold">Capture work from anywhere</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Add a task, paste a Trello card or board, or route a pull request to a project and task.
          </p>
        </div>
        <SmartInput large onSubmit={onSubmit} />
      </section>

      <section className="mx-auto grid w-full max-w-4xl gap-4">
        <Panel title="Recent tasks" icon={ClipboardList}>
          <TaskList tasks={tasks.slice(0, 8)} onOpenTask={onOpenTask} onUpdateTask={() => {}} readonly />
        </Panel>
      </section>
    </div>
  );
}
