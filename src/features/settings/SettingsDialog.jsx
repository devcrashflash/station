import { useState } from "react";
import { LoaderCircle, Pencil, PlugZap, Trash2 } from "lucide-react";

import { Modal } from "@/components/common/Modal";
import { SelectControl } from "@/components/common/SelectControl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const providerOptions = [
  { value: "gitlab", label: "GitLab" },
  { value: "github", label: "GitHub" },
  { value: "trello", label: "Trello" },
];

const permissionHints = {
  gitlab: "Use read_api or api. read_repository is not enough for issues and merge requests.",
  github: "Use Metadata read, Pull requests read, and Issues read for fine-grained tokens.",
  trello: "Enter your Trello API key, then generate an API token for your account.",
};

const TRELLO_BASE_URL = "https://api.trello.com";

function normalizeCredentialBaseUrl(value, fallback) {
  const trimmed = value?.trim().replace(/\/+$/, "") || "";
  if (!trimmed) return fallback;
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) return trimmed;
  return `https://${trimmed}`;
}

function credentialUrl(provider, baseUrl, apiKey) {
  if (provider === "github") {
    return "https://github.com/settings/personal-access-tokens/new";
  }
  if (provider === "gitlab") {
    return `${normalizeCredentialBaseUrl(baseUrl, "https://gitlab.com")}/-/user_settings/personal_access_tokens`;
  }
  if (provider === "trello") {
    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey) return "";
    return `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=Server%20Token&key=${encodeURIComponent(trimmedApiKey)}`;
  }
  return "";
}

export function SettingsDialog({ connections, onClose, onSave, onDelete, onTest }) {
  const [provider, setProvider] = useState("gitlab");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [token, setToken] = useState("");
  const [editingConnectionId, setEditingConnectionId] = useState(null);
  const [testingConnectionId, setTestingConnectionId] = useState(null);
  const [testResults, setTestResults] = useState({});

  function resetForm() {
    setProvider("gitlab");
    setName("");
    setBaseUrl("");
    setApiKey("");
    setToken("");
    setEditingConnectionId(null);
  }

  function editConnection(connection) {
    setEditingConnectionId(connection.id);
    setProvider(connection.provider);
    setName(connection.name);
    setBaseUrl(connection.provider === "trello" ? "" : connection.baseUrl);
    setApiKey(connection.apiKey || "");
    setToken(connection.token || "");
  }

  async function submit(event) {
    event.preventDefault();
    const savedConnectionId = editingConnectionId;
    await onSave({
      id: editingConnectionId,
      provider,
      name,
      baseUrl: provider === "trello" ? TRELLO_BASE_URL : baseUrl,
      apiKey: provider === "trello" ? apiKey : null,
      token,
    });
    resetForm();
    if (savedConnectionId) {
      setTestResults((current) => {
        const next = { ...current };
        delete next[savedConnectionId];
        return next;
      });
    }
  }

  async function testConnection(connectionId) {
    setTestingConnectionId(connectionId);
    setTestResults((current) => ({
      ...current,
      [connectionId]: { ok: null, message: "Testing connection..." },
    }));
    try {
      const result = await onTest(connectionId);
      setTestResults((current) => ({
        ...current,
        [connectionId]: result,
      }));
    } finally {
      setTestingConnectionId(null);
    }
  }

  const tokenUrl = credentialUrl(provider, baseUrl, apiKey);

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
        {provider === "trello" ? (
          <p className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
            Trello uses the fixed cloud API. Enter the API key and token from your Trello developer app.
          </p>
        ) : (
          <Field>
            <FieldLabel>Base URL</FieldLabel>
            <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required />
          </Field>
        )}
        {provider === "trello" && (
          <Field>
            <FieldLabel>API key</FieldLabel>
            <Input value={apiKey} type="password" onChange={(event) => setApiKey(event.target.value)} required />
          </Field>
        )}
        <Field>
          <FieldLabel>{provider === "trello" ? "API token" : "Token"}</FieldLabel>
          <Input value={token} type="password" onChange={(event) => setToken(event.target.value)} required />
          <div className="grid gap-1 text-xs text-muted-foreground">
            <p>{permissionHints[provider]}</p>
            {tokenUrl && (
              <a
                className="font-medium text-blue-700 underline-offset-2 hover:underline"
                href={tokenUrl}
                target="_blank"
                rel="noreferrer"
              >
                Generate token
              </a>
            )}
            {provider === "trello" && !tokenUrl && (
              <span className="font-medium text-muted-foreground">Enter an API key to generate a token.</span>
            )}
          </div>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">{editingConnectionId ? "Update connection" : "Save connection"}</Button>
          {editingConnectionId && (
            <Button type="button" variant="outline" onClick={resetForm}>
              Cancel edit
            </Button>
          )}
        </div>
      </form>

      <div className="mt-6 grid gap-2">
        {connections.map((connection) => {
          const testResult = testResults[connection.id];
          return (
            <div key={connection.id} className="flex items-start gap-2 rounded-md border p-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{connection.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {connection.provider} · {connection.provider === "trello" ? "Cloud API" : connection.baseUrl}
                </p>
                {testResult && (
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                    <Badge
                      variant={testResult.ok === false ? "destructive" : "secondary"}
                      className={cn(testResult.ok === true && "bg-green-100 text-green-800")}
                    >
                      {testResult.ok === null ? "Testing" : testResult.ok ? "Connected" : "Failed"}
                    </Badge>
                    <p className="min-w-0 flex-1 text-xs text-muted-foreground">{testResult.message}</p>
                  </div>
                )}
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                type="button"
                title="Edit connection"
                onClick={() => editConnection(connection)}
              >
                <Pencil />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                type="button"
                title="Test connection"
                disabled={testingConnectionId === connection.id}
                onClick={() => testConnection(connection.id)}
              >
                {testingConnectionId === connection.id ? <LoaderCircle className="animate-spin" /> : <PlugZap />}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                type="button"
                title="Delete connection"
                onClick={() => {
                  if (editingConnectionId === connection.id) {
                    resetForm();
                  }
                  onDelete(connection.id);
                  setTestResults((current) => {
                    const next = { ...current };
                    delete next[connection.id];
                    return next;
                  });
                }}
              >
                <Trash2 />
              </Button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
