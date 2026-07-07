import { useState } from "react";
import { Link2, Plus, Trash2 } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Modal } from "@/components/common/Modal";
import { Panel } from "@/components/common/Panel";
import { SelectControl } from "@/components/common/SelectControl";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { resourceKinds } from "@/lib/domain";
import { parseSmartInput } from "@/lib/smartInputParser";

export function ResourcesPanel({
  resources,
  connections,
  onManageResources,
}) {
  const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));

  return (
    <Panel title="Connected resources" icon={Link2}>
      <div className="grid gap-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Resources</p>
          <span className="text-xs text-muted-foreground">{resources.length} connected</span>
        </div>

        {resources.length === 0 ? (
          <EmptyState text="No resources connected." />
        ) : (
          <ResourceList
            resources={resources}
            connectionsById={connectionsById}
            editable={false}
          />
        )}

        <Button type="button" variant="outline" onClick={onManageResources}>
          <Link2 className="size-4" />
          Manage resources
        </Button>
      </div>
    </Panel>
  );
}

export function ProjectResourcesDialog({
  project,
  resources,
  connections,
  projectConnectionIds = [],
  onClose,
  onConnectResource,
  onDisconnectResource,
}) {
  const [kind, setKind] = useState("trello_board");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [connectionId, setConnectionId] = useState("");

  const enabledConnections = connections.filter((connection) => projectConnectionIds.includes(connection.id));
  const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
  const connectionOptions = [
    { value: "none", label: "No endpoint connection" },
    ...enabledConnections.map((connection) => ({
      value: connection.id,
      label: connection.name,
    })),
  ];

  async function submit(event) {
    event.preventDefault();
    const parsed = parseSmartInput(url);
    const provider = kind.startsWith("trello") ? "trello" : kind.startsWith("github") ? "github" : "gitlab";
    await onConnectResource({
      projectId: project.id,
      provider,
      kind,
      externalId: parsed.externalId || url,
      url,
      name: name.trim() || parsed.title || url,
      iconUrl: null,
      connectionId: connectionId === "none" ? null : connectionId || null,
    });
    setUrl("");
    setName("");
  }

  return (
    <Modal title="Project resources" onClose={onClose}>
      <form className="grid gap-3" onSubmit={submit}>
        <SelectControl value={kind} onValueChange={setKind} options={resourceKinds} />
        <Field>
          <FieldLabel>Resource URL</FieldLabel>
          <Input value={url} onChange={(event) => setUrl(event.target.value)} required />
        </Field>
        <Field>
          <FieldLabel>Display name</FieldLabel>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <SelectControl
          value={connectionId || "none"}
          onValueChange={setConnectionId}
          options={connectionOptions}
        />
        <Button type="submit" variant="outline">
          <Plus />
          Connect
        </Button>
      </form>

      <div className="mt-5 border-t pt-5">
        {resources.length === 0 ? (
          <EmptyState text="No resources connected." />
        ) : (
          <ResourceList
            resources={resources}
            connectionsById={connectionsById}
            editable
            onDisconnectResource={onDisconnectResource}
          />
        )}
      </div>
    </Modal>
  );
}

function ResourceList({ resources, connectionsById, editable, onDisconnectResource }) {
  return (
    <div className="flex flex-col gap-2">
      {resources.map((resource) => (
        <div key={resource.id} className="flex min-w-0 items-center gap-2 rounded-md border bg-card p-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{resource.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {resource.provider} · {resource.kind}
              {resource.connectionId && connectionsById.has(resource.connectionId)
                ? ` · ${connectionsById.get(resource.connectionId).name}`
                : ""}
            </p>
            <p className="truncate text-xs text-blue-700">{resource.url}</p>
          </div>
          {editable && (
            <Button
              className="shrink-0"
              size="icon-xs"
              variant="ghost"
              type="button"
              title="Disconnect resource"
              onClick={() => onDisconnectResource(resource.id)}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
