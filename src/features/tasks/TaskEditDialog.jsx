import { useEffect, useRef, useState } from "react";

import { Modal } from "@/components/common/Modal";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { shortcutModifier } from "@/lib/keyboardShortcut";

export function TaskEditDialog({ task, onClose, onSave }) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body);
  const formRef = useRef(null);
  const shortcutKey = shortcutModifier();

  useEffect(() => {
    setTitle(task.title);
    setBody(task.body);
  }, [task]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (
        (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey
        && event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        formRef.current?.requestSubmit();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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
    <Modal
      title="Edit task"
      onClose={onClose}
      contentClassName="h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:h-[85dvh] sm:max-h-[85dvh] sm:w-[70vw] sm:max-w-4xl"
    >
      <form
        ref={formRef}
        className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden"
        onSubmit={submit}
      >
        <Field>
          <FieldLabel>Title</FieldLabel>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>

        <Field className="min-h-0 overflow-hidden">
          <FieldLabel>Description</FieldLabel>
          <Textarea
            className="field-sizing-fixed h-full min-h-0 resize-none overflow-y-auto"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" title="Cancel with Esc" onClick={onClose}>
            Cancel
            <Kbd>Esc</Kbd>
          </Button>
          <Button type="submit" title={`Save task with ${shortcutKey} S`}>
            Save task
            <Kbd className="bg-primary-foreground/15 text-primary-foreground">{shortcutKey} S</Kbd>
          </Button>
        </div>
      </form>
    </Modal>
  );
}
