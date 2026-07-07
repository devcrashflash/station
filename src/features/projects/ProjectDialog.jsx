import { useState } from "react";

import { Modal } from "@/components/common/Modal";
import { SelectControl } from "@/components/common/SelectControl";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { iconMap } from "@/features/projects/projectIcons";

const iconOptions = Object.keys(iconMap).map((iconName) => ({
  value: iconName,
  label: iconName,
}));

export function ProjectDialog({ onClose, onCreate }) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("FolderKanban");

  return (
    <Modal title="Add project" onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(name, icon);
        }}
      >
        <Field>
          <FieldLabel>Project name</FieldLabel>
          <Input value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field>
          <FieldLabel>Icon</FieldLabel>
          <SelectControl value={icon} onValueChange={setIcon} options={iconOptions} />
        </Field>
        <Button type="submit">Create project</Button>
      </form>
    </Modal>
  );
}
