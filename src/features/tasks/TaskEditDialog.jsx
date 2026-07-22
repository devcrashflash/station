import { useEffect, useState } from "react";

import { Modal } from "@/components/common/Modal";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function TaskEditDialog({ task, onClose, onSave }) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body);

  useEffect(() => {
    setTitle(task.title);
    setBody(task.body);
  }, [task]);

  async function submit(event) {
    event.preventDefault();
    const payload = {
      id: task.id,
      title,
      body,
    };

    await onSave(payload);
  }

  return (
    <Modal title="Edit task" onClose={onClose}>
      <form className="grid gap-4" onSubmit={submit}>
        <Field>
          <FieldLabel>Title</FieldLabel>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>

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
