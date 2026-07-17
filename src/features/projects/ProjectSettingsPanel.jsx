import { useEffect, useState } from "react";
import { Pencil, Settings } from "lucide-react";
import { Tabs as TabsPrimitive } from "radix-ui";

import { EmptyState } from "@/components/common/EmptyState";
import { Modal } from "@/components/common/Modal";
import { Panel } from "@/components/common/Panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ProjectColorPicker } from "@/features/projects/ProjectColorPicker";
import { ProjectLocalResourcesEditor } from "@/features/resources/LocalResourcesPanel";
import { providerLabels } from "@/lib/domain";
import { getProjectInitial, normalizeProjectColor } from "@/lib/projectAvatar";

export function ProjectSettingsPanel({
  project,
  connections = [],
  projectConnectionIds = [],
  onEdit,
}) {
  const projectColor = normalizeProjectColor(project.color);
  const enabledConnections = connections.filter((connection) => projectConnectionIds.includes(connection.id));

  return (
    <Panel
      title="Project details"
      icon={Settings}
      headerAction={(
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="icon-xs" variant="ghost" aria-label="Edit project" onClick={onEdit}>
                <Pencil />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Edit project</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    >
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
      </div>
    </Panel>
  );
}

function ProjectEditor({ project, onSave }) {
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState(normalizeProjectColor(project.color));
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setName(project.name);
    setColor(normalizeProjectColor(project.color));
  }, [project]);

  async function submitProject(event) {
    event.preventDefault();
    setIsSaving(true);
    setNotice("");
    try {
      await onSave({ id: project.id, name, color });
      setNotice("Project saved.");
    } catch (error) {
      setNotice(error?.message || String(error));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form className="grid gap-3" onSubmit={submitProject}>
      <Field>
        <FieldLabel>Name</FieldLabel>
        <Input value={name} onChange={(event) => setName(event.target.value)} required />
      </Field>
      <Field>
        <FieldLabel>Color</FieldLabel>
        <ProjectColorPicker value={color} onChange={setColor} />
      </Field>
      {notice && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}
      <Button type="submit" disabled={isSaving}>{isSaving ? "Saving..." : "Save project"}</Button>
    </form>
  );
}

function ProjectConnectionsEditor({
  connections = [],
  projectConnectionIds = [],
  onSave,
}) {
  const [enabledConnectionIds, setEnabledConnectionIds] = useState(projectConnectionIds);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState("");

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

  async function submitConnections(event) {
    event.preventDefault();
    setIsSaving(true);
    setNotice("");
    try {
      await onSave(enabledConnectionIds);
      setNotice("Connections saved.");
    } catch (error) {
      setNotice(error?.message || String(error));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submitConnections}>
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
      {notice && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}
      <Button type="submit" disabled={!connections.length || isSaving}>
        {isSaving ? "Saving..." : "Save connections"}
      </Button>
    </form>
  );
}

const tabTriggerClassName = "rounded-md px-3 py-2 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm";
const tabContentClassName = "mt-4 max-h-[min(65vh,36rem)] overflow-y-auto pr-1 outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ProjectEditorDialog({
  project,
  connections,
  projectConnectionIds,
  localResources,
  onClose,
  onUpdateProject,
  onUpdateProjectConnections,
  onChooseLocalResourceDirectory,
  onSaveLocalResource,
  onDeleteLocalResource,
}) {
  return (
    <Modal title="Edit project" onClose={onClose} contentClassName="sm:max-w-2xl">
      <TabsPrimitive.Root defaultValue="project">
        <TabsPrimitive.List
          className="grid grid-cols-3 rounded-lg bg-muted p-1"
          aria-label="Project editing sections"
        >
          <TabsPrimitive.Trigger className={tabTriggerClassName} value="project">Project</TabsPrimitive.Trigger>
          <TabsPrimitive.Trigger className={tabTriggerClassName} value="connections">Connections</TabsPrimitive.Trigger>
          <TabsPrimitive.Trigger className={tabTriggerClassName} value="local-resources">Local resources</TabsPrimitive.Trigger>
        </TabsPrimitive.List>
        <TabsPrimitive.Content className={tabContentClassName} value="project">
          <ProjectEditor project={project} onSave={onUpdateProject} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content className={tabContentClassName} value="connections">
          <ProjectConnectionsEditor
            connections={connections}
            projectConnectionIds={projectConnectionIds}
            onSave={onUpdateProjectConnections}
          />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content className={tabContentClassName} value="local-resources">
          <ProjectLocalResourcesEditor
            project={project}
            localResources={localResources}
            onChooseDirectory={onChooseLocalResourceDirectory}
            onSaveLocalResource={onSaveLocalResource}
            onDeleteLocalResource={onDeleteLocalResource}
          />
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>
    </Modal>
  );
}
