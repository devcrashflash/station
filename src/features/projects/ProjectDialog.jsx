import { useState } from "react";

import { Modal } from "@/components/common/Modal";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ProjectColorPicker } from "@/features/projects/ProjectColorPicker";
import { DEFAULT_PROJECT_COLOR } from "@/lib/projectAvatar";

export function ProjectDialog({ onClose, onCreate }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_PROJECT_COLOR);

  return (
    <Modal title="Add project" onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(name, color);
        }}
      >
        <Field>
          <FieldLabel>Project name</FieldLabel>
          <Input value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field>
          <FieldLabel>Color</FieldLabel>
          <ProjectColorPicker value={color} onChange={setColor} />
        </Field>
        <Button type="submit">Create project</Button>
      </form>
    </Modal>
  );
}
