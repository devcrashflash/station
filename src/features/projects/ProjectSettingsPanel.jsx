import { useEffect, useState } from "react";
import { Settings } from "lucide-react";

import { Panel } from "@/components/common/Panel";
import { SelectControl } from "@/components/common/SelectControl";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { iconMap } from "@/features/projects/projectIcons";

const iconOptions = Object.keys(iconMap).map((iconName) => ({
  value: iconName,
  label: iconName,
}));

export function ProjectSettingsPanel({ project, onUpdateProject }) {
  const [name, setName] = useState(project.name);
  const [icon, setIcon] = useState(project.icon);

  useEffect(() => {
    setName(project.name);
    setIcon(project.icon);
  }, [project]);

  return (
    <Panel title="Project settings" icon={Settings}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onUpdateProject({ id: project.id, name, icon });
        }}
      >
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field>
          <FieldLabel>Icon</FieldLabel>
          <SelectControl value={icon} onValueChange={setIcon} options={iconOptions} />
        </Field>
        <Button type="submit" variant="outline">
          Save project
        </Button>
      </form>
    </Panel>
  );
}
