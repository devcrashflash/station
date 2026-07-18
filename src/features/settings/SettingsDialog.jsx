import { useEffect, useRef, useState } from "react";
import { AtSign, Bot, CalendarDays, FolderOpen, GitMerge, GitPullRequest, LoaderCircle, Monitor, Palette, Pencil, PlugZap, RefreshCw, RotateCcw, SquareKanban, Trash2, UserRound } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Modal } from "@/components/common/Modal";
import { SelectControl } from "@/components/common/SelectControl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { aiPromptIconFor, aiPromptIconOptions } from "@/lib/aiPromptIcons";
import { cn } from "@/lib/utils";

const providerOptions = [
  { value: "gitlab", label: "GitLab" },
  { value: "github", label: "GitHub" },
  { value: "trello", label: "Trello" },
];

const accountAddOptions = [
  { value: "google", label: "Google", icon: AtSign },
  { value: "github", label: "GitHub", icon: GitPullRequest },
  { value: "gitlab", label: "GitLab", icon: GitMerge },
  { value: "trello", label: "Trello", icon: SquareKanban },
  { value: "calendar", label: "Calendar", icon: CalendarDays },
];

const calendarKindOptions = [
  { value: "caldav", label: "CalDAV account" },
  { value: "ical", label: "iCal URL" },
];

const calendarTypeLabels = {
  google: "Google Calendar",
  caldav: "CalDAV",
  ical: "iCal URL",
};

const aiAgentTypeOptions = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
];

const themeOptions = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const permissionHints = {
  gitlab: "Use read_api or api. read_repository is not enough for issues and merge requests.",
  github: "Use Metadata read, Pull requests read, and Issues read for fine-grained tokens.",
  trello: "Enter your Trello API key, then generate an API token for your account.",
};

const TRELLO_BASE_URL = "https://api.trello.com";
const settingsSections = [
  { id: "accounts", label: "Accounts", description: "Connected services", icon: UserRound },
  { id: "ai-prompts", label: "AI Prompts", description: "Reusable AI instructions", icon: Bot },
  { id: "directories", label: "Directories", description: "Local source folders", icon: FolderOpen },
  { id: "appearance", label: "Appearance", description: "Color theme", icon: Palette },
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
  aiPrompts,
  directories,
  browserSettings,
  themePreference = "system",
  calendarAccounts = [],
  initialSection = "accounts",
  onClose,
  onSave,
  onDelete,
  onTest,
  onSaveAiPrompt,
  onDeleteAiPrompt,
  onChooseDirectory,
  onSaveDirectory,
  onDeleteDirectory,
  onSaveBrowserSettings,
  onThemePreferenceChange,
  onSaveCalendarSubscription,
  onSaveCalDavAccount,
  onConnectGoogleAccount,
  onCancelGoogleAccount,
  onUpdateCalendarService,
  onRefreshCalendarCollections,
  onUpdateCalendarCollections,
  onTestCalendarAccount,
  onDeleteCalendarAccount,
}) {
  const [activeTab, setActiveTab] = useState(initialSection);
  const [aiPromptAgentType, setAiPromptAgentType] = useState("codex");
  const [aiPromptName, setAiPromptName] = useState("");
  const [aiPromptIcon, setAiPromptIcon] = useState("sparkles");
  const [aiPromptText, setAiPromptText] = useState("");
  const [editingAiPromptId, setEditingAiPromptId] = useState(null);
  const [isChoosingDirectory, setIsChoosingDirectory] = useState(false);
  const [directoryNotice, setDirectoryNotice] = useState("");
  const [browserBundleId, setBrowserBundleId] = useState(browserSettings?.browserBundleId || "");
  const [browserNotice, setBrowserNotice] = useState("");

  useEffect(() => {
    setBrowserBundleId(browserSettings?.browserBundleId || "");
  }, [browserSettings?.browserBundleId]);

  function resetAiPromptForm() {
    setAiPromptAgentType("codex");
    setAiPromptName("");
    setAiPromptIcon("sparkles");
    setAiPromptText("");
    setEditingAiPromptId(null);
  }

  function editAiPrompt(prompt) {
    setAiPromptAgentType(prompt.agentType);
    setAiPromptName(prompt.name);
    setAiPromptIcon(prompt.icon || "sparkles");
    setAiPromptText(prompt.promptText || "");
    setEditingAiPromptId(prompt.id);
  }

  async function submitAiPrompt(event) {
    event.preventDefault();
    try {
      await onSaveAiPrompt({
        id: editingAiPromptId,
        agentType: aiPromptAgentType,
        name: aiPromptName,
        icon: aiPromptIcon,
        promptText: aiPromptText,
      });
      resetAiPromptForm();
    } catch {
      // The app-level handler presents the error notice and keeps the form intact.
    }
  }

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
            {activeTab === "accounts" && (
              <AccountsSettingsTab
                connections={connections}
                calendarAccounts={calendarAccounts}
                onSaveConnection={onSave}
                onDeleteConnection={onDelete}
                onTestConnection={onTest}
                onSaveSubscription={onSaveCalendarSubscription}
                onSaveCalDav={onSaveCalDavAccount}
                onConnectGoogle={onConnectGoogleAccount}
                onCancelGoogle={onCancelGoogleAccount}
                onUpdateService={onUpdateCalendarService}
                onRefreshCalendars={onRefreshCalendarCollections}
                onUpdateCollections={onUpdateCalendarCollections}
                onTestCalendar={onTestCalendarAccount}
                onDeleteCalendar={onDeleteCalendarAccount}
              />
            )}

            {activeTab === "ai-prompts" && (
              <div className="grid gap-6">
                <form className="grid gap-3" onSubmit={submitAiPrompt}>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field>
                      <FieldLabel>AI Agent</FieldLabel>
                      <SelectControl
                        value={aiPromptAgentType}
                        onValueChange={setAiPromptAgentType}
                        options={aiAgentTypeOptions}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Workflow icon</FieldLabel>
                      <SelectControl
                        value={aiPromptIcon}
                        onValueChange={setAiPromptIcon}
                        options={aiPromptIconOptions}
                      />
                    </Field>
                  </div>
                  <Field>
                    <FieldLabel>Name</FieldLabel>
                    <Input
                      value={aiPromptName}
                      onChange={(event) => setAiPromptName(event.target.value)}
                      placeholder="e.g. Implement ticket"
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Prompt text</FieldLabel>
                    <Textarea
                      value={aiPromptText}
                      onChange={(event) => setAiPromptText(event.target.value)}
                      placeholder="Optional instructions added before the ticket details"
                      rows={8}
                    />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit">{editingAiPromptId ? "Update AI Prompt" : "Save AI Prompt"}</Button>
                    {editingAiPromptId && (
                      <Button type="button" variant="outline" onClick={resetAiPromptForm}>
                        Cancel edit
                      </Button>
                    )}
                  </div>
                </form>

                <div className="grid gap-2">
                  {aiPrompts.length === 0 ? (
                    <EmptyState text="No AI Prompts configured yet." />
                  ) : (
                    aiPrompts.map((prompt) => (
                      <div key={prompt.id} className="flex items-center gap-2 rounded-md border p-3">
                        <AiPromptIcon name={prompt.icon} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{prompt.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {aiAgentTypeOptions.find((option) => option.value === prompt.agentType)?.label || prompt.agentType}
                          </p>
                          {prompt.promptText && (
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{prompt.promptText}</p>
                          )}
                        </div>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          type="button"
                          title="Edit AI Prompt"
                          onClick={() => editAiPrompt(prompt)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          type="button"
                          title="Delete AI Prompt"
                          onClick={() => {
                            if (editingAiPromptId === prompt.id) resetAiPromptForm();
                            onDeleteAiPrompt(prompt.id).catch(() => {});
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </div>
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

            {activeTab === "appearance" && (
              <AppearanceTab
                themePreference={themePreference}
                onThemePreferenceChange={onThemePreferenceChange}
              />
            )}
          </div>
        </main>
      </div>
    </Modal>
  );
}

function AccountsSettingsTab({ connections, calendarAccounts, onSaveConnection, onDeleteConnection, onTestConnection, onSaveSubscription, onSaveCalDav, onConnectGoogle, onCancelGoogle, onUpdateService, onRefreshCalendars, onUpdateCollections, onTestCalendar, onDeleteCalendar }) {
  const [editor, setEditor] = useState(null);
  const [fields, setFields] = useState({});
  const [calendarKind, setCalendarKind] = useState("caldav");
  const [busyKey, setBusyKey] = useState("");
  const [editorError, setEditorError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [testResults, setTestResults] = useState({});
  const googleConnectRunRef = useRef(0);

  function resetEditor(nextEditor = null, nextFields = {}, nextCalendarKind = "caldav") {
    setEditor(nextEditor);
    setFields(nextFields);
    setCalendarKind(nextCalendarKind);
    setEditorError("");
    setBusyKey("");
  }

  function openCreate(type) {
    resetEditor(
      { mode: "create", type },
      type === "github" ? { baseUrl: "https://github.com" } : type === "gitlab" ? { baseUrl: "https://gitlab.com" } : {},
    );
  }

  function editConnection(connection) {
    resetEditor({ mode: "edit", type: connection.provider, id: connection.id }, {
      name: connection.name,
      baseUrl: connection.provider === "trello" ? "" : connection.baseUrl,
      apiKey: connection.apiKey || "",
      token: connection.token || "",
    });
  }

  function editCalendar(account) {
    if (account.provider === "google") {
      resetEditor({ mode: "edit", type: "google", id: account.id }, { name: account.name });
      return;
    }
    const kind = account.provider === "ical" ? "ical" : "caldav";
    resetEditor({ mode: "edit", type: "calendar", id: account.id }, kind === "ical" ? {
      name: account.name,
      url: "",
      color: account.calendars?.[0]?.color || "#64748b",
    } : {
      name: account.name,
      serverUrl: account.serverUrl,
      username: account.username || "",
      password: "",
    }, kind);
  }

  function setField(name, value) {
    setFields((current) => ({ ...current, [name]: value }));
  }

  async function submitDeveloper(event) {
    event.preventDefault();
    setBusyKey("editor");
    setEditorError("");
    try {
      await onSaveConnection({
        id: editor.mode === "edit" ? editor.id : null,
        provider: editor.type,
        name: fields.name || "",
        baseUrl: editor.type === "trello" ? TRELLO_BASE_URL : fields.baseUrl || "",
        apiKey: editor.type === "trello" ? fields.apiKey || "" : null,
        token: fields.token || "",
      });
      if (editor.id) setTestResults((current) => ({ ...current, [editor.id]: undefined }));
      resetEditor();
    } catch (error) {
      setEditorError(error?.message || String(error));
      setBusyKey("");
    }
  }

  async function submitCalendar(event) {
    event.preventDefault();
    setBusyKey("editor");
    setEditorError("");
    try {
      if (calendarKind === "caldav") {
        await onSaveCalDav({ id: editor.mode === "edit" ? editor.id : null, name: fields.name || "", serverUrl: fields.serverUrl || "", username: fields.username || "", password: fields.password || "" });
      } else {
        await onSaveSubscription({ id: editor.mode === "edit" ? editor.id : null, name: fields.name || "", url: fields.url || "", color: fields.color || "#64748b" });
      }
      resetEditor();
    } catch (error) {
      setEditorError(error?.message || String(error));
      setBusyKey("");
    }
  }

  async function connectGoogle() {
    const run = googleConnectRunRef.current + 1;
    googleConnectRunRef.current = run;
    setBusyKey("google-connect");
    setEditorError("");
    try {
      await onConnectGoogle(editor.mode === "edit" ? editor.id : null);
      if (googleConnectRunRef.current !== run) return;
      resetEditor();
    } catch (error) {
      if (googleConnectRunRef.current !== run) return;
      setEditorError(error?.message || String(error));
      setBusyKey("");
    }
  }

  async function cancelGoogle() {
    googleConnectRunRef.current += 1;
    setBusyKey("google-cancel");
    setEditorError("");
    try {
      await onCancelGoogle();
      resetEditor();
    } catch (error) {
      setEditorError(error?.message || String(error));
      setBusyKey("");
    }
  }

  async function runAction(key, action, success) {
    setBusyKey(key);
    setActionNotice("");
    try {
      const result = await action();
      setActionNotice(typeof success === "function" ? success(result) : success);
      return result;
    } catch (error) {
      setActionNotice(error?.message || String(error));
      throw error;
    } finally {
      setBusyKey("");
    }
  }

  async function testDeveloper(id) {
    setTestResults((current) => ({ ...current, [id]: { ok: null, message: "Testing connection..." } }));
    const result = await runAction(`test:${id}`, () => onTestConnection(id), "Connection tested.").catch((error) => ({ ok: false, message: error?.message || String(error) }));
    setTestResults((current) => ({ ...current, [id]: result }));
  }

  const tokenUrl = editor && ["github", "gitlab", "trello"].includes(editor.type)
    ? credentialUrl(editor.type, fields.baseUrl || "", fields.apiKey || "")
    : "";
  const savedCount = connections.length + calendarAccounts.length;
  const groups = [
    { id: "google", label: "Google", icon: AtSign, items: calendarAccounts.filter((item) => item.provider === "google"), kind: "calendar" },
    { id: "github", label: "GitHub", icon: GitPullRequest, items: connections.filter((item) => item.provider === "github"), kind: "developer" },
    { id: "gitlab", label: "GitLab", icon: GitMerge, items: connections.filter((item) => item.provider === "gitlab"), kind: "developer" },
    { id: "trello", label: "Trello", icon: SquareKanban, items: connections.filter((item) => item.provider === "trello"), kind: "developer" },
    { id: "caldav", label: "CalDAV", icon: CalendarDays, items: calendarAccounts.filter((item) => item.provider === "caldav"), kind: "calendar" },
    { id: "ical", label: "Calendar URLs", icon: CalendarDays, items: calendarAccounts.filter((item) => item.provider === "ical"), kind: "calendar" },
  ];

  return (
    <div className="grid gap-6">
      <div>
        <h2 className="text-xl font-semibold">Accounts</h2>
        <p className="mt-1 text-sm text-muted-foreground">Connect the services and calendars you use. You can add more than one account for each provider.</p>
      </div>

      <div className="grid gap-4 rounded-md border bg-muted/20 p-4">
        <div>
          <p className="font-medium">Add account</p>
          <p className="mt-1 text-sm text-muted-foreground">Choose a provider to configure it here.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {accountAddOptions.map((option) => {
            const Icon = option.icon;
            return <Button key={option.value} type="button" disabled={busyKey === "google-connect" || busyKey === "google-cancel"} variant={editor?.type === option.value && editor?.mode === "create" ? "secondary" : "outline"} onClick={() => openCreate(option.value)}>
              <Icon />{option.label}
            </Button>;
          })}
        </div>

        {editor && editor.type !== "calendar" && (
          <div className="grid gap-4 border-t pt-4">
            {["github", "gitlab", "trello"].includes(editor.type) && (
              <form className="grid gap-3" onSubmit={submitDeveloper}>
                <EditorHeading editor={editor} label={providerOptions.find((item) => item.value === editor.type)?.label} onCancel={() => resetEditor()} />
                <Field><FieldLabel>Connection name</FieldLabel><Input value={fields.name || ""} onChange={(event) => setField("name", event.target.value)} required /></Field>
                {editor.type === "trello" ? <p className="rounded-md border bg-background p-3 text-sm text-muted-foreground">Trello uses the fixed cloud API. Enter the API key and token from your Trello developer app.</p> : (
                  <Field><FieldLabel>{editor.type === "github" ? "GitHub server" : "GitLab server"}</FieldLabel><Input value={fields.baseUrl || ""} onChange={(event) => setField("baseUrl", event.target.value)} required /></Field>
                )}
                {editor.type === "trello" && <Field><FieldLabel>API key</FieldLabel><Input type="password" value={fields.apiKey || ""} onChange={(event) => setField("apiKey", event.target.value)} required /></Field>}
                <Field>
                  <FieldLabel>{editor.type === "trello" ? "API token" : "Token"}</FieldLabel>
                  <Input type="password" value={fields.token || ""} onChange={(event) => setField("token", event.target.value)} required />
                  <div className="grid gap-1 text-xs text-muted-foreground"><p>{permissionHints[editor.type]}</p>{tokenUrl ? <a className="font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300" href={tokenUrl} target="_blank" rel="noreferrer">Generate token</a> : editor.type === "trello" ? <span>Enter an API key to generate a token.</span> : null}</div>
                </Field>
                <EditorFooter busy={busyKey === "editor"} submitLabel={editor.mode === "edit" ? "Update connection" : `Add ${providerOptions.find((item) => item.value === editor.type)?.label}`} error={editorError} onCancel={() => resetEditor()} />
              </form>
            )}

            {editor.type === "google" && (
              <div className="grid gap-3">
                <EditorHeading editor={editor} label="Google" onCancel={() => resetEditor()} />
                <p className="text-sm text-muted-foreground">{editor.mode === "edit" ? `Reconnect ${fields.name} to refresh its Google authorization.` : "Sign in with Google to discover calendars. Calendar access is read-only."}</p>
                {editorError && <p className="rounded-md border bg-background p-3 text-sm text-destructive">{editorError}</p>}
                <div className="flex gap-2"><Button type="button" disabled={busyKey === "google-connect" || busyKey === "google-cancel"} onClick={connectGoogle}>{busyKey === "google-connect" && <LoaderCircle className="animate-spin" />}{busyKey === "google-connect" ? "Connecting Google…" : editor.mode === "edit" ? "Reconnect Google" : "Connect Google"}</Button><Button type="button" variant="outline" disabled={busyKey === "google-cancel"} onClick={busyKey === "google-connect" ? cancelGoogle : () => resetEditor()}>{busyKey === "google-cancel" && <LoaderCircle className="animate-spin" />}{busyKey === "google-connect" || busyKey === "google-cancel" ? "Cancel connection" : "Cancel"}</Button></div>
              </div>
            )}

          </div>
        )}
      </div>

      {editor?.type === "calendar" && <Modal title={editor.mode === "edit" ? "Edit calendar" : "Add calendar"} onClose={() => resetEditor()} contentClassName="sm:max-w-xl">
        <form className="grid max-h-[75vh] gap-3 overflow-y-auto pr-1" onSubmit={submitCalendar}>
          <Field><FieldLabel>Calendar type</FieldLabel><SelectControl value={calendarKind} disabled={editor.mode === "edit"} onValueChange={(value) => { setCalendarKind(value); setFields(value === "ical" ? { color: "#64748b" } : {}); setEditorError(""); }} options={calendarKindOptions} /></Field>
          <Field><FieldLabel>{calendarKind === "ical" ? "Calendar name" : "Account name"}</FieldLabel><Input value={fields.name || ""} onChange={(event) => setField("name", event.target.value)} required /></Field>
          {calendarKind === "caldav" ? <>
            <Field><FieldLabel>Server URL</FieldLabel><Input value={fields.serverUrl || ""} onChange={(event) => setField("serverUrl", event.target.value)} placeholder="https://calendar.example.com" required /></Field>
            <Field><FieldLabel>Username</FieldLabel><Input value={fields.username || ""} onChange={(event) => setField("username", event.target.value)} required /></Field>
            <Field><FieldLabel>App password</FieldLabel><Input type="password" value={fields.password || ""} onChange={(event) => setField("password", event.target.value)} required /></Field>
            {editor.mode === "edit" && <CalendarColorFields account={calendarAccounts.find((account) => account.id === editor.id)} onUpdateCollections={onUpdateCollections} setActionNotice={setActionNotice} />}
          </> : <>
            <Field><FieldLabel>Secret iCal URL</FieldLabel><Input type="password" value={fields.url || ""} onChange={(event) => setField("url", event.target.value)} placeholder={editor.mode === "edit" ? "Leave blank to keep the saved URL" : "https://calendar.example.com/private.ics"} required={editor.mode !== "edit"} /></Field>
            <Field><FieldLabel>Color</FieldLabel><input className="h-9 w-14 cursor-pointer rounded-md border bg-background p-1" type="color" value={fields.color || "#64748b"} onChange={(event) => setField("color", event.target.value)} /></Field>
            <p className="rounded-md border bg-background p-3 text-sm text-muted-foreground">Treat this URL like a password. It is stored in the app’s local database and never displayed again.</p>
          </>}
          <EditorFooter busy={busyKey === "editor"} submitLabel={editor.mode === "edit" ? (calendarKind === "caldav" ? "Reconnect account" : "Update subscription") : (calendarKind === "caldav" ? "Connect CalDAV" : "Add calendar")} error={editorError} onCancel={() => resetEditor()} />
        </form>
      </Modal>}

      {actionNotice && <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">{actionNotice}</p>}
      {savedCount === 0 ? <EmptyState text="No accounts configured." /> : <div className="grid gap-5">
        {groups.map((group) => group.items.length > 0 && <AccountGroup key={group.id} group={group} busyKey={busyKey} testResults={testResults} onEdit={group.kind === "developer" ? editConnection : editCalendar} onTest={(item) => group.kind === "developer" ? testDeveloper(item.id) : runAction(`test:${item.id}`, () => onTestCalendar(item.id), (message) => message).catch(() => {})} onRefresh={(item) => runAction(`refresh:${item.id}`, () => onRefreshCalendars(item.id), "Calendars refreshed.").catch(() => {})} onDelete={(item) => runAction(`delete:${item.id}`, () => group.kind === "developer" ? onDeleteConnection(item.id) : onDeleteCalendar(item.id), "Account removed.").then(() => { if (editor?.id === item.id) resetEditor(); }).catch(() => {})} onUpdateService={(item, enabled) => runAction(`service:${item.id}`, () => onUpdateService(item.id, enabled), enabled ? "Google Calendar enabled." : "Google Calendar paused.").catch(() => {})} onUpdateCollections={onUpdateCollections} setActionNotice={setActionNotice} />)}
      </div>}
    </div>
  );
}

function EditorHeading({ editor, label }) {
  return <div><p className="font-medium">{editor.mode === "edit" ? `Edit ${label}` : `Add ${label}`}</p><p className="mt-1 text-sm text-muted-foreground">{editor.mode === "edit" ? "Update this saved account." : `Configure a new ${label} account.`}</p></div>;
}

function EditorFooter({ busy, submitLabel, error, onCancel }) {
  return <><>{error && <p className="rounded-md border bg-background p-3 text-sm text-destructive">{error}</p>}</><div className="flex gap-2"><Button type="submit" disabled={busy}>{busy && <LoaderCircle className="animate-spin" />}{submitLabel}</Button><Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button></div></>;
}

function AccountGroup({ group, busyKey, testResults, onEdit, onTest, onRefresh, onDelete, onUpdateService, onUpdateCollections, setActionNotice }) {
  const Icon = group.icon;
  return <section className="grid gap-2"><div className="flex items-center gap-2"><Icon className="size-4 text-muted-foreground" /><h3 className="font-semibold">{group.label}</h3><Badge variant="secondary">{group.items.length}</Badge></div>{group.items.map((item) => {
    const isDeveloper = group.kind === "developer";
    const result = testResults[item.id];
    return <div key={item.id} className="grid gap-3 rounded-md border p-4"><div className="flex min-w-0 items-start gap-2"><div className="min-w-0 flex-1"><p className="font-medium">{item.name}</p><p className="truncate text-xs text-muted-foreground">{isDeveloper ? (item.provider === "trello" ? "Cloud API" : item.baseUrl) : calendarTypeLabels[item.provider] || "Calendar"}</p>{result && <div className="mt-2 flex items-center gap-2"><Badge variant={result.ok === false ? "destructive" : "secondary"} className={cn(result.ok === true && "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300")}>{result.ok === null ? "Testing" : result.ok ? "Connected" : "Failed"}</Badge><span className="text-xs text-muted-foreground">{result.message}</span></div>}</div><Button size="icon-sm" variant="ghost" title={item.provider === "google" ? "Reconnect account" : "Edit account"} onClick={() => onEdit(item)}><Pencil /></Button><Button size="icon-sm" variant="ghost" title="Test account" disabled={Boolean(busyKey)} onClick={() => onTest(item)}>{busyKey === `test:${item.id}` ? <LoaderCircle className="animate-spin" /> : <PlugZap />}</Button>{!isDeveloper && <Button size="icon-sm" variant="ghost" title="Refresh calendars" disabled={Boolean(busyKey)} onClick={() => onRefresh(item)}><RefreshCw className={busyKey === `refresh:${item.id}` ? "animate-spin" : ""} /></Button>}<Button size="icon-sm" variant="ghost" title="Delete account" disabled={Boolean(busyKey)} onClick={() => onDelete(item)}><Trash2 /></Button></div>{item.provider === "google" && <label className="flex items-center gap-3 rounded-md border bg-muted/20 p-3"><Checkbox checked={item.calendarEnabled !== false} disabled={Boolean(busyKey)} onCheckedChange={(checked) => onUpdateService(item, checked === true)} /><div><p className="text-sm font-medium">Calendar</p><p className="text-xs text-muted-foreground">Show and sync calendars from this Google account.</p></div></label>}{!isDeveloper && item.provider === "google" && item.calendarEnabled !== false && <div className="grid gap-2">{(item.calendars || []).map((calendar) => <label key={calendar.id} className="flex items-center gap-3 rounded-md border bg-muted/20 p-3"><Checkbox checked={calendar.enabled} onCheckedChange={(checked) => onUpdateCollections([{ id: calendar.id, enabled: checked === true, color: calendar.color }]).catch((error) => setActionNotice(error?.message || String(error)))} /><input className="size-7 cursor-pointer rounded border bg-transparent p-0.5" type="color" value={calendar.color || "#64748b"} onChange={(event) => onUpdateCollections([{ id: calendar.id, enabled: calendar.enabled, color: event.target.value }]).catch((error) => setActionNotice(error?.message || String(error)))} /><span className="min-w-0 flex-1 truncate text-sm font-medium">{calendar.name}</span></label>)}{(item.calendars || []).length === 0 && <EmptyState text="No event calendars discovered." />}</div>}</div>;
  })}</section>;
}

function CalendarColorFields({ account, onUpdateCollections, setActionNotice }) {
  if (!account?.calendars?.length) return null;
  return <div className="grid gap-2"><FieldLabel>Calendar colors</FieldLabel>{account.calendars.map((calendar) => <label key={calendar.id} className="flex items-center gap-3 rounded-md border bg-muted/20 p-3"><input className="size-7 cursor-pointer rounded border bg-transparent p-0.5" type="color" value={calendar.color || "#64748b"} onChange={(event) => onUpdateCollections([{ id: calendar.id, enabled: true, color: event.target.value }]).catch((error) => setActionNotice(error?.message || String(error)))} /><span className="min-w-0 flex-1 truncate text-sm font-medium">{calendar.name}</span></label>)}</div>;
}

function AiPromptIcon({ name }) {
  const Icon = aiPromptIconFor(name);
  return <Icon className="size-5 shrink-0 text-muted-foreground" />;
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
                <p className="truncate text-xs text-blue-700 dark:text-blue-300">{directory.path}</p>
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

function AppearanceTab({ themePreference, onThemePreferenceChange }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <p className="text-sm font-medium">Color theme</p>
        <p className="text-xs text-muted-foreground">
          System follows your operating system and updates automatically when it changes.
        </p>
      </div>
      <Field>
        <FieldLabel>Appearance</FieldLabel>
        <SelectControl
          value={themePreference}
          onValueChange={onThemePreferenceChange}
          options={themeOptions}
          triggerClassName="w-full sm:max-w-xs"
        />
      </Field>
    </div>
  );
}
