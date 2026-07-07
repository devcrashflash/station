import { useState } from "react";
import { Plus } from "lucide-react";

import { Modal } from "@/components/common/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { providerLabels } from "@/lib/domain";
import { parseSmartInput } from "@/lib/smartInputParser";

export function ProjectPickerDialog({ input, projects, onClose, onPick, onCreate }) {
  const [name, setName] = useState("");
  const parsed = parseSmartInput(input);
  const description =
    parsed.kind === "text"
      ? "Choose the project where this task should be saved."
      : `${providerLabels[parsed.provider] || "This link"} is not connected to a project yet.`;

  return (
    <Modal title="Choose a project" onClose={onClose}>
      <p className="mb-4 text-sm text-muted-foreground">{description}</p>
      <div className="grid gap-2">
        {projects.map((project) => (
          <Button key={project.id} type="button" variant="outline" onClick={() => onPick(project.id)}>
            {project.name}
          </Button>
        ))}
      </div>
      <form
        className="mt-5 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(name || parsed.title);
        }}
      >
        <Input
          className="flex-1"
          value={name}
          placeholder="Or create project"
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit">
          <Plus />
          Create
        </Button>
      </form>
    </Modal>
  );
}
