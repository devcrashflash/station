import { useState } from "react";
import { Link2, Plus, Trash2 } from "lucide-react";

import { Panel } from "@/components/common/Panel";
import { SelectControl } from "@/components/common/SelectControl";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { resourceKinds } from "@/lib/domain";
import { parseSmartInput } from "@/lib/smartInputParser";

export function ResourcesPanel({ project, resources, connections, onConnectResource, onDisconnectResource }) {
  const [kind, setKind] = useState("trello_board");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [connectionId, setConnectionId] = useState("");

  const connectionOptions = [
    { value: "none", label: "No endpoint connection" },
    ...connections.map((connection) => ({
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
    <Panel title="Connected resources" icon={Link2}>
      <form className="mb-4 flex flex-col gap-3" onSubmit={submit}>
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

      {resources.length === 0 ? (
        <EmptyState text="No resources connected." />
      ) : (
        <div className="flex flex-col gap-2">
          {resources.map((resource) => (
            <div key={resource.id} className="flex items-center gap-2 rounded-md border bg-card p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{resource.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {resource.provider} · {resource.kind}
                </p>
              </div>
              <Button
                size="icon-xs"
                variant="ghost"
                type="button"
                title="Disconnect resource"
                onClick={() => onDisconnectResource(resource.id)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
