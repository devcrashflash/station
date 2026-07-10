import { useEffect, useState } from "react";
import { FolderOpen, LoaderCircle, Monitor, Pencil, PlugZap, RotateCcw, Trash2 } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
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
const settingsSections = [
  { id: "endpoints", label: "Endpoints", description: "Global endpoint settings", icon: PlugZap },
  { id: "directories", label: "Directories", description: "Local source folders", icon: FolderOpen },
  { id: "browser", label: "Browser", description: "New tab behavior", icon: Monitor },
];

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

export function SettingsDialog({
  connections,
  directories,
  browserSettings,
  onClose,
  onSave,
  onDelete,
  onTest,
  onChooseDirectory,
  onSaveDirectory,
  onDeleteDirectory,
  onSaveBrowserSettings,
}) {
  const [activeTab, setActiveTab] = useState("endpoints");
  const [provider, setProvider] = useState("gitlab");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [token, setToken] = useState("");
  const [editingConnectionId, setEditingConnectionId] = useState(null);
  const [testingConnectionId, setTestingConnectionId] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [isChoosingDirectory, setIsChoosingDirectory] = useState(false);
  const [directoryNotice, setDirectoryNotice] = useState("");
  const [browserBundleId, setBrowserBundleId] = useState(browserSettings?.browserBundleId || "");
  const [browserNotice, setBrowserNotice] = useState("");

  useEffect(() => {
    setBrowserBundleId(browserSettings?.browserBundleId || "");
  }, [browserSettings?.browserBundleId]);

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
    <Modal
      title="Settings"
      onClose={onClose}
      contentClassName="grid-rows-[auto_minmax(0,1fr)] h-[calc(100vh-3rem)] max-h-[calc(100vh-3rem)] w-[calc(100vw-3rem)] max-w-[calc(100vw-3rem)] gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-3rem)]"
      headerClassName="border-b px-6 py-4 pr-14"
    >
      <div className="grid min-h-0 grid-cols-[4.75rem_minmax(0,1fr)] sm:grid-cols-[220px_minmax(0,1fr)]">
        <nav className="min-h-0 overflow-y-auto border-r bg-muted/30 p-2 sm:p-3" aria-label="Settings sections">
          <div className="grid gap-1">
            {settingsSections.map((section) => (
              <SettingsMenuButton
                key={section.id}
                section={section}
                active={activeTab === section.id}
                onClick={() => setActiveTab(section.id)}
              />
            ))}
          </div>
        </nav>

        <main className="min-h-0 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6">
          <div className="mx-auto grid w-full max-w-3xl gap-6">
            {activeTab === "endpoints" && (
              <>
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

                <div className="grid gap-2">
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
              </>
            )}

            {activeTab === "directories" && (
              <DirectoriesTab
                directories={directories}
                isChoosing={isChoosingDirectory}
                notice={directoryNotice}
                onChooseDirectory={async () => {
                  setIsChoosingDirectory(true);
                  setDirectoryNotice("");
                  try {
                    const path = await onChooseDirectory();
                    if (!path) return;
                    await onSaveDirectory({ path });
                    setDirectoryNotice("Directory saved.");
                  } catch (error) {
                    setDirectoryNotice(error?.message || String(error));
                  } finally {
                    setIsChoosingDirectory(false);
                  }
                }}
                onDeleteDirectory={async (id) => {
                  setDirectoryNotice("");
                  try {
                    await onDeleteDirectory(id);
                    setDirectoryNotice("Directory removed.");
                  } catch (error) {
                    setDirectoryNotice(error?.message || String(error));
                  }
                }}
              />
            )}

            {activeTab === "browser" && (
              <BrowserTab
                browserBundleId={browserBundleId}
                detectedBrowserBundleId={browserSettings?.detectedBrowserBundleId || ""}
                notice={browserNotice}
                onBrowserBundleIdChange={setBrowserBundleId}
                onSave={async () => {
                  setBrowserNotice("");
                  try {
                    await onSaveBrowserSettings({ browserBundleId });
                    setBrowserNotice("Browser settings saved.");
                  } catch (error) {
                    setBrowserNotice(error?.message || String(error));
                  }
                }}
                onReset={async () => {
                  setBrowserBundleId("");
                  setBrowserNotice("");
                  try {
                    await onSaveBrowserSettings({ browserBundleId: null });
                    setBrowserNotice("Using system default browser.");
                  } catch (error) {
                    setBrowserNotice(error?.message || String(error));
                  }
                }}
              />
            )}
          </div>
        </main>
      </div>
    </Modal>
  );
}

function SettingsMenuButton({ section, active, onClick }) {
  const Icon = section.icon;

  return (
    <button
      type="button"
      className={cn(
        "flex min-w-0 items-start justify-center gap-3 rounded-md px-3 py-2 text-left transition-colors sm:justify-start",
        active ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
      )}
      aria-pressed={active}
      onClick={onClick}
      title={section.label}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="hidden min-w-0 gap-0.5 sm:grid">
        <span className="truncate text-sm font-medium">{section.label}</span>
        <span className="truncate text-xs">{section.description}</span>
      </span>
    </button>
  );
}

function DirectoriesTab({ directories, isChoosing, notice, onChooseDirectory, onDeleteDirectory }) {
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Configured directories</p>
          <p className="text-xs text-muted-foreground">{directories.length} configured</p>
        </div>
        <Button type="button" variant="outline" disabled={isChoosing} onClick={onChooseDirectory}>
          <FolderOpen className="size-4" />
          {isChoosing ? "Choosing..." : "Choose directory"}
        </Button>
      </div>

      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      {directories.length === 0 ? (
        <EmptyState text="No directories configured." />
      ) : (
        <div className="flex flex-col gap-2">
          {directories.map((directory) => (
            <div key={directory.id} className="flex min-w-0 items-center gap-2 rounded-md border p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{directory.name}</p>
                <p className="truncate text-xs text-blue-700">{directory.path}</p>
              </div>
              <Button
                className="shrink-0"
                size="icon-xs"
                variant="ghost"
                type="button"
                title="Remove directory"
                onClick={() => onDeleteDirectory(directory.id)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BrowserTab({
  browserBundleId,
  detectedBrowserBundleId,
  notice,
  onBrowserBundleIdChange,
  onSave,
  onReset,
}) {
  const effectiveBrowser = browserBundleId?.trim() || detectedBrowserBundleId || "system default";

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <p className="text-sm font-medium">Browser for new tabs</p>
        <p className="text-xs text-muted-foreground">Detected default: {detectedBrowserBundleId || "Unavailable"}</p>
        <p className="text-xs text-muted-foreground">Effective browser: {effectiveBrowser}</p>
      </div>

      <Field>
        <FieldLabel>Browser bundle id override</FieldLabel>
        <Input
          value={browserBundleId}
          placeholder={detectedBrowserBundleId || "org.mozilla.firefox"}
          onChange={(event) => onBrowserBundleIdChange(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Leave empty to use the macOS default browser detected from http/https handlers.
        </p>
      </Field>

      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onSave}>
          Save browser
        </Button>
        <Button type="button" variant="outline" onClick={onReset}>
          <RotateCcw className="size-4" />
          Use system default
        </Button>
      </div>
    </div>
  );
}
