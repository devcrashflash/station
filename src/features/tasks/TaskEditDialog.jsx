import { useEffect, useState } from "react";

import { Modal } from "@/components/common/Modal";
import { SelectControl } from "@/components/common/SelectControl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isProviderBackedTask } from "@/lib/taskStatus";

const statusOptions = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
];

export function TaskEditDialog({ task, onClose, onSave }) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body);
  const [status, setStatus] = useState(task.status);
  const isProviderBacked = isProviderBackedTask(task);

  useEffect(() => {
    setTitle(task.title);
    setBody(task.body);
    setStatus(task.status);
  }, [task]);

  async function submit(event) {
    event.preventDefault();
    const payload = {
      id: task.id,
      title,
      body,
    };

    if (!isProviderBacked) {
      payload.status = status;
    }

    await onSave(payload);
  }

  return (
    <Modal title="Edit task" onClose={onClose}>
      <form className="grid gap-4" onSubmit={submit}>
        <Field>
          <FieldLabel>Title</FieldLabel>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>

        {isProviderBacked ? (
          <Field>
            <FieldLabel>Status</FieldLabel>
            <Badge className="w-fit" variant="secondary">{task.status}</Badge>
          </Field>
        ) : (
          <Field>
            <FieldLabel>Status</FieldLabel>
            <SelectControl value={status} onValueChange={setStatus} options={statusOptions} />
          </Field>
        )}

        <Field>
          <FieldLabel>Description</FieldLabel>
          <Textarea
            className="min-h-32 resize-y"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </Field>

        <Button type="submit">Save task</Button>
      </form>
    </Modal>
  );
}
