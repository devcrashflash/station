import { useEffect, useState } from "react";

import { Modal } from "@/components/common/Modal";
import { SelectControl } from "@/components/common/SelectControl";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const statusOptions = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
];

export function TaskEditDialog({ task, onClose, onSave }) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body);
  const [status, setStatus] = useState(task.status);

  useEffect(() => {
    setTitle(task.title);
    setBody(task.body);
    setStatus(task.status);
  }, [task]);

  async function submit(event) {
    event.preventDefault();
    await onSave({
      id: task.id,
      title,
      body,
      status,
    });
  }

  return (
    <Modal title="Edit task" onClose={onClose}>
      <form className="grid gap-4" onSubmit={submit}>
        <Field>
          <FieldLabel>Title</FieldLabel>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>

        <Field>
          <FieldLabel>Status</FieldLabel>
          <SelectControl value={status} onValueChange={setStatus} options={statusOptions} />
        </Field>

        <Field>
          <FieldLabel>Notes</FieldLabel>
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
