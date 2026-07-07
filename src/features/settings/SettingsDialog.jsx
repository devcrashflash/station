import { useState } from "react";
import { Trash2 } from "lucide-react";

import { Modal } from "@/components/common/Modal";
import { SelectControl } from "@/components/common/SelectControl";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const providerOptions = [
  { value: "gitlab", label: "GitLab" },
  { value: "github", label: "GitHub" },
  { value: "trello", label: "Trello" },
];

export function SettingsDialog({ connections, onClose, onSave, onDelete }) {
  const [provider, setProvider] = useState("gitlab");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");

  async function submit(event) {
    event.preventDefault();
    await onSave({ id: null, provider, name, baseUrl, token });
    setName("");
    setBaseUrl("");
    setToken("");
  }

  return (
    <Modal title="Global endpoint settings" onClose={onClose}>
      <form className="grid gap-3" onSubmit={submit}>
        <Field>
          <FieldLabel>Provider</FieldLabel>
          <SelectControl value={provider} onValueChange={setProvider} options={providerOptions} />
        </Field>
        <Field>
          <FieldLabel>Connection name</FieldLabel>
          <Input value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field>
          <FieldLabel>Base URL</FieldLabel>
          <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required />
        </Field>
        <Field>
          <FieldLabel>Token</FieldLabel>
          <Input value={token} type="password" onChange={(event) => setToken(event.target.value)} />
        </Field>
        <Button type="submit">Save connection</Button>
      </form>

      <div className="mt-6 grid gap-2">
        {connections.map((connection) => (
          <div key={connection.id} className="flex items-center gap-2 rounded-md border p-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{connection.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {connection.provider} · {connection.baseUrl}
              </p>
            </div>
            <Button size="icon-sm" variant="ghost" type="button" onClick={() => onDelete(connection.id)}>
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
