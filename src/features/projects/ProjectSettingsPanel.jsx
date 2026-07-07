import { useEffect, useState } from "react";
import { Pencil, Plug, Settings } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Modal } from "@/components/common/Modal";
import { Panel } from "@/components/common/Panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ProjectColorPicker } from "@/features/projects/ProjectColorPicker";
import { providerLabels } from "@/lib/domain";
import { getProjectInitial, normalizeProjectColor } from "@/lib/projectAvatar";

export function ProjectSettingsPanel({
  project,
  connections = [],
  projectConnectionIds = [],
  onEditProject,
  onManageConnections,
}) {
  const projectColor = normalizeProjectColor(project.color);
  const enabledConnections = connections.filter((connection) => projectConnectionIds.includes(connection.id));

  return (
    <Panel title="Project details" icon={Settings}>
      <div className="grid gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="flex size-10 shrink-0 items-center justify-center rounded-md border text-sm font-semibold text-white"
            style={{ backgroundColor: projectColor }}
          >
            {getProjectInitial(project.name)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{project.name}</p>
            <p className="truncate text-xs text-muted-foreground">{projectColor}</p>
          </div>
        </div>

        <div className="grid gap-2 border-t pt-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Connections</p>
            <span className="text-xs text-muted-foreground">{enabledConnections.length} enabled</span>
          </div>
          {enabledConnections.length === 0 ? (
            <EmptyState text="No connections enabled." />
          ) : (
            <div className="grid gap-2">
              {enabledConnections.map((connection) => (
                <div key={connection.id} className="min-w-0 rounded-md border bg-card p-2">
                  <p className="truncate text-sm font-medium">{connection.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {providerLabels[connection.provider] || connection.provider} · {connection.baseUrl}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-2">
          <Button type="button" variant="outline" onClick={onEditProject}>
            <Pencil className="size-4" />
            Edit project
          </Button>
          <Button type="button" variant="outline" onClick={onManageConnections}>
            <Plug className="size-4" />
            Manage connections
          </Button>
        </div>
      </div>
    </Panel>
  );
}

export function ProjectEditDialog({ project, onClose, onSave }) {
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState(normalizeProjectColor(project.color));

  useEffect(() => {
    setName(project.name);
    setColor(normalizeProjectColor(project.color));
  }, [project]);

  return (
    <Modal title="Edit project" onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={async (event) => {
          event.preventDefault();
          await onSave({ id: project.id, name, color });
        }}
      >
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field>
          <FieldLabel>Color</FieldLabel>
          <ProjectColorPicker value={color} onChange={setColor} />
        </Field>
        <Button type="submit">Save project</Button>
      </form>
    </Modal>
  );
}

export function ProjectConnectionsDialog({
  connections = [],
  projectConnectionIds = [],
  onClose,
  onSave,
}) {
  const [enabledConnectionIds, setEnabledConnectionIds] = useState(projectConnectionIds);

  useEffect(() => {
    setEnabledConnectionIds(projectConnectionIds);
  }, [projectConnectionIds]);

  function toggleConnection(connectionId, checked) {
    setEnabledConnectionIds((current) =>
      checked
        ? Array.from(new Set([...current, connectionId]))
        : current.filter((id) => id !== connectionId),
    );
  }

  const groupedConnections = connections.reduce((groups, connection) => {
    groups[connection.provider] = groups[connection.provider] || [];
    groups[connection.provider].push(connection);
    return groups;
  }, {});

  return (
    <Modal title="Project connections" onClose={onClose}>
      <form
        className="grid gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          await onSave(enabledConnectionIds);
        }}
      >
        <div className="grid gap-3">
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">No global connections configured.</p>
          ) : (
            Object.entries(groupedConnections).map(([provider, items]) => (
              <div key={provider} className="grid gap-2">
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  {providerLabels[provider] || provider}
                </p>
                {items.map((connection) => (
                  <label
                    key={connection.id}
                    className="flex min-w-0 items-center gap-2 rounded-md border p-2 text-sm"
                  >
                    <Checkbox
                      checked={enabledConnectionIds.includes(connection.id)}
                      onCheckedChange={(checked) => toggleConnection(connection.id, checked === true)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{connection.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {connection.baseUrl}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ))
          )}
        </div>
        <Button type="submit" disabled={!connections.length}>
          Save connections
        </Button>
      </form>
    </Modal>
  );
}
