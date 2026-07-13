import { useEffect, useState } from "react";

import { Modal } from "@/components/common/Modal";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

export function TodoEditDialog({ todo, onClose, onSave }) {
  const [value, setValue] = useState(todo.kind === "file" ? todo.title : todo.rawText || "");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setValue(todo.kind === "file" ? todo.title : todo.rawText || "");
    setError("");
  }, [todo]);

  async function submit(event) {
    event.preventDefault();
    if (!value.trim() || isSaving) return;

    setIsSaving(true);
    setError("");
    try {
      await onSave(todo.kind === "file"
        ? { id: todo.id, title: value }
        : { id: todo.id, rawText: value });
    } catch (saveError) {
      setError(saveError?.message || String(saveError));
      setIsSaving(false);
    }
  }

  return (
    <Modal title="Edit todo" onClose={onClose}>
      <form className="grid gap-4" onSubmit={submit}>
        <Field>
          <FieldLabel>Todo</FieldLabel>
          <Textarea
            autoFocus
            className="min-h-32 resize-y"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <Button type="submit" disabled={!value.trim() || isSaving}>
          {isSaving ? "Saving..." : "Save todo"}
        </Button>
      </form>
    </Modal>
  );
}
