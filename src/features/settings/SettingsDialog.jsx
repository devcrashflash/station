import { useEffect, useRef, useState } from "react";
import { AtSign, Bot, CalendarDays, FolderOpen, GitMerge, GitPullRequest, Keyboard, LoaderCircle, Monitor, Palette, Pencil, PlugZap, RefreshCw, RotateCcw, SquareKanban, SquareTerminal, Trash2, UserRound } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Modal } from "@/components/common/Modal";
import { SelectControl } from "@/components/common/SelectControl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { aiPromptIconFor, aiPromptIconOptions } from "@/lib/aiPromptIcons";
import { formatShortcut, shortcutFromKeyboardEvent } from "@/lib/keyboardShortcut";
import { terminalFontFamily, terminalFontOptions, terminalFontStyle, terminalFontStyleOptions } from "@/lib/terminalFonts";
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
  { id: "shortcuts", label: "Shortcuts", description: "Global quick capture", icon: Keyboard },
  { id: "appearance", label: "Appearance", description: "Color theme", icon: Palette },
  { id: "terminal", label: "Terminal", description: "Typography and behavior", icon: SquareTerminal },
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
  terminalSettings,
  terminalFonts = [],
  quickCaptureShortcutSettings,
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
  onSaveTerminalSettings,
  onSaveQuickCaptureShortcut,
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

            {activeTab === "terminal" && (
              <TerminalTab
                settings={terminalSettings}
                fonts={terminalFonts}
                onChooseDirectory={onChooseDirectory}
                onSave={onSaveTerminalSettings}
              />
            )}

            {activeTab === "shortcuts" && (
              <ShortcutsTab
                settings={quickCaptureShortcutSettings}
                onSave={onSaveQuickCaptureShortcut}
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

function ShortcutsTab({ settings, onSave }) {
  const [candidate, setCandidate] = useState(settings?.shortcut || "CommandOrControl+Shift+Space");
  const [isRecording, setIsRecording] = useState(false);
  const [notice, setNotice] = useState(settings?.error || "");
  const [noticeIsError, setNoticeIsError] = useState(Boolean(settings?.error));
  const [isSaving, setIsSaving] = useState(false);
  const supported = settings?.supported === true;

  useEffect(() => {
    setCandidate(settings?.shortcut || settings?.defaultShortcut || "CommandOrControl+Shift+Space");
    setNotice(settings?.error || "");
    setNoticeIsError(Boolean(settings?.error));
  }, [settings]);

  function handleRecorderKeyDown(event) {
    if (!isRecording) return;
    event.preventDefault();
    event.stopPropagation();

    const result = shortcutFromKeyboardEvent(event);
    if (result.status === "cancel") {
      setIsRecording(false);
      setNotice("Recording cancelled.");
      setNoticeIsError(false);
      return;
    }
    if (result.status === "recording") {
      setNotice("Press a non-modifier key to finish the shortcut.");
      setNoticeIsError(false);
      return;
    }
    if (result.status === "error") {
      setNotice(result.error);
      setNoticeIsError(true);
      return;
    }

    setCandidate(result.shortcut);
    setIsRecording(false);
    setNotice("Shortcut recorded. Save to activate it.");
    setNoticeIsError(false);
  }

  async function save(shortcut) {
    setIsSaving(true);
    setNotice("");
    setNoticeIsError(false);
    try {
      const nextSettings = await onSave({ shortcut });
      setCandidate(nextSettings.shortcut);
      setNotice(shortcut === null ? "Default shortcut restored." : "Shortcut saved and active.");
      setNoticeIsError(false);
    } catch (error) {
      setNotice(error?.message || String(error));
      setNoticeIsError(true);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="grid gap-5">
      <div className="grid gap-1">
        <p className="text-sm font-medium">Quick capture overlay</p>
        <p className="text-xs text-muted-foreground">
          Open the capture overlay from any application while Station is running.
        </p>
      </div>

      {!supported ? (
        <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          Global shortcut configuration requires the desktop app.
        </p>
      ) : (
        <>
          <div className="grid gap-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">Current shortcut</span>
                <div className="flex items-center gap-2">
                  <Kbd className="h-7 px-2 text-sm">{formatShortcut(settings.shortcut)}</Kbd>
                  <Badge variant={settings.registered ? "secondary" : "destructive"}>
                    {settings.registered ? "Active" : "Unavailable"}
                  </Badge>
                </div>
              </div>
              <div className="grid justify-items-end gap-1">
                <span className="text-xs text-muted-foreground">New shortcut</span>
                <Kbd className="h-7 px-2 text-sm">{formatShortcut(candidate)}</Kbd>
              </div>
            </div>

            <Button
              type="button"
              variant={isRecording ? "secondary" : "outline"}
              disabled={isSaving}
              onClick={() => {
                setIsRecording(true);
                setNotice("Press the new shortcut. Escape cancels.");
                setNoticeIsError(false);
              }}
              onKeyDown={handleRecorderKeyDown}
              onBlur={() => setIsRecording(false)}
            >
              <Keyboard />
              {isRecording ? "Press shortcut…" : "Record shortcut"}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Include Command, Control, Option, or Alt with another key. Shift can be added as an extra modifier.
          </p>
          {notice && (
            <p className={cn("text-sm text-muted-foreground", noticeIsError && "text-destructive")} role="status">
              {notice}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={isSaving || isRecording} onClick={() => save(candidate)}>
              {isSaving && <LoaderCircle className="animate-spin" />}
              Save shortcut
            </Button>
            <Button type="button" variant="outline" disabled={isSaving || isRecording} onClick={() => save(null)}>
              <RotateCcw />
              Restore default
            </Button>
          </div>
        </>
      )}
    </div>
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

function TerminalTab({ settings, fonts, onChooseDirectory, onSave }) {
  const [newTabDirectory, setNewTabDirectory] = useState(settings?.newTabDirectory || "");
  const [newPaneDirectory, setNewPaneDirectory] = useState(settings?.newPaneDirectory || "");
  const [inactivePaneOpacity, setInactivePaneOpacity] = useState(settings?.inactivePaneOpacity ?? 0.65);
  const [closeTerminalsOnAppExit, setCloseTerminalsOnAppExit] = useState(settings?.closeTerminalsOnAppExit ?? false);
  const [copyOnSelection, setCopyOnSelection] = useState(settings?.copyOnSelection ?? true);
  const [fontFamily, setFontFamily] = useState(settings?.fontFamily || "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace");
  const [fontWeight, setFontWeight] = useState(settings?.fontWeight ?? 400);
  const [fontStyle, setFontStyle] = useState(settings?.fontStyle || "normal");
  const [fontSize, setFontSize] = useState(String(settings?.fontSize ?? 13));
  const [lineHeight, setLineHeight] = useState(String(settings?.lineHeight ?? 100));
  const [horizontalSpacing, setHorizontalSpacing] = useState(String(settings?.horizontalSpacing ?? 100));
  const [scrollbackLines, setScrollbackLines] = useState(String(settings?.scrollbackLines ?? 10_000));
  const [notice, setNotice] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [choosingFor, setChoosingFor] = useState(null);

  useEffect(() => {
    setNewTabDirectory(settings?.newTabDirectory || "");
    setNewPaneDirectory(settings?.newPaneDirectory || "");
    setInactivePaneOpacity(settings?.inactivePaneOpacity ?? 0.65);
    setCloseTerminalsOnAppExit(settings?.closeTerminalsOnAppExit ?? false);
    setCopyOnSelection(settings?.copyOnSelection ?? true);
    setFontFamily(settings?.fontFamily || "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace");
    setFontWeight(settings?.fontWeight ?? 400);
    setFontStyle(settings?.fontStyle || "normal");
    setFontSize(String(settings?.fontSize ?? 13));
    setLineHeight(String(settings?.lineHeight ?? 100));
    setHorizontalSpacing(String(settings?.horizontalSpacing ?? 100));
    setScrollbackLines(String(settings?.scrollbackLines ?? 10_000));
  }, [settings?.newTabDirectory, settings?.newPaneDirectory, settings?.inactivePaneOpacity, settings?.closeTerminalsOnAppExit, settings?.copyOnSelection, settings?.fontFamily, settings?.fontWeight, settings?.fontStyle, settings?.fontSize, settings?.lineHeight, settings?.horizontalSpacing, settings?.scrollbackLines]);

  const selectedFont = terminalFontFamily(fonts, fontFamily);
  const selectedStyle = terminalFontStyle(selectedFont, fontWeight, fontStyle);

  function chooseFontFamily(value) {
    const font = terminalFontFamily(fonts, value);
    const style = terminalFontStyle(font, 400, "normal");
    setFontFamily(value);
    if (style) {
      setFontWeight(style.weight);
      setFontStyle(style.italic ? "italic" : "normal");
    }
  }

  function chooseFontStyle(value) {
    const style = selectedFont?.styles.find((entry) => entry.id === value);
    if (!style) return;
    setFontWeight(style.weight);
    setFontStyle(style.italic ? "italic" : "normal");
  }

  async function choose(setValue, target) {
    setChoosingFor(target);
    setNotice("");
    try {
      const path = await onChooseDirectory();
      if (path) setValue(path);
    } catch (error) {
      setNotice(error?.message || String(error));
    } finally {
      setChoosingFor(null);
    }
  }

  async function save() {
    setIsSaving(true);
    setNotice("");
    try {
      const parsedFontSize = Number(fontSize);
      const parsedLineHeight = Number(lineHeight);
      const parsedHorizontalSpacing = Number(horizontalSpacing);
      const parsedScrollbackLines = Number(scrollbackLines);
      if (!Number.isFinite(parsedFontSize) || parsedFontSize < 8 || parsedFontSize > 32) {
        throw new Error("Font size must be between 8 and 32 pixels.");
      }
      if (!Number.isFinite(parsedLineHeight) || parsedLineHeight < 100 || parsedLineHeight > 200) {
        throw new Error("Vertical spacing must be between 100 and 200 percent.");
      }
      if (!Number.isFinite(parsedHorizontalSpacing) || parsedHorizontalSpacing < 100 || parsedHorizontalSpacing > 200) {
        throw new Error("Horizontal spacing must be between 100 and 200 percent.");
      }
      if (!Number.isInteger(parsedScrollbackLines) || parsedScrollbackLines < 0 || parsedScrollbackLines > 100_000) {
        throw new Error("Scrollback must be a whole number between 0 and 100,000 lines.");
      }
      await onSave({
        newTabDirectory,
        newPaneDirectory,
        inactivePaneOpacity,
        closeTerminalsOnAppExit,
        copyOnSelection,
        fontFamily,
        fontWeight,
        fontStyle,
        fontSize: parsedFontSize,
        lineHeight: parsedLineHeight,
        horizontalSpacing: parsedHorizontalSpacing,
        scrollbackLines: parsedScrollbackLines,
      });
      setNotice("Terminal settings saved.");
    } catch (error) {
      setNotice(error?.message || String(error));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="grid gap-5">
      <div className="grid gap-1">
        <p className="text-sm font-medium">Terminal typography</p>
        <p className="text-xs text-muted-foreground">Saved changes apply to all open terminal panes.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field>
          <FieldLabel>Font family</FieldLabel>
          <SelectControl
            value={selectedFont?.family || ""}
            placeholder="Select a local font"
            disabled={!fonts.length}
            onValueChange={chooseFontFamily}
            options={terminalFontOptions(fonts)}
          />
          <p className="text-xs text-muted-foreground">
            {fonts.length ? "Installed monospaced fonts only." : "Local font discovery requires the desktop app."}
          </p>
        </Field>
        <Field>
          <FieldLabel>Font style</FieldLabel>
          <SelectControl
            value={selectedStyle?.id || ""}
            placeholder="Select a style"
            disabled={!selectedFont}
            onValueChange={chooseFontStyle}
            options={terminalFontStyleOptions(selectedFont)}
          />
          <p className="text-xs text-muted-foreground">Only styles installed for this family.</p>
        </Field>
        <Field>
          <FieldLabel>Font size</FieldLabel>
          <Input type="number" min="8" max="32" step="1" value={fontSize} onChange={(event) => setFontSize(event.target.value)} />
          <p className="text-xs text-muted-foreground">8–32 pixels</p>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>Vertical spacing</FieldLabel>
          <Input type="number" min="100" max="200" step="1" value={lineHeight} onChange={(event) => setLineHeight(event.target.value)} />
          <p className="text-xs text-muted-foreground">100–200 percent</p>
        </Field>
        <Field>
          <FieldLabel>Horizontal spacing</FieldLabel>
          <Input type="number" min="100" max="200" step="1" value={horizontalSpacing} onChange={(event) => setHorizontalSpacing(event.target.value)} />
          <p className="text-xs text-muted-foreground">100–200 percent</p>
        </Field>
      </div>

      <div className="grid gap-1">
        <p className="text-sm font-medium">Terminal start directories</p>
        <p className="text-xs text-muted-foreground">
          These defaults apply when creating new terminal tabs and panes. Existing terminals keep their current directory.
        </p>
      </div>

      <Field>
        <FieldLabel>New tabs</FieldLabel>
        <div className="flex gap-2">
          <Input
            value={newTabDirectory}
            placeholder={settings?.profileDirectory || "~"}
            onChange={(event) => setNewTabDirectory(event.target.value)}
          />
          <Button type="button" variant="outline" disabled={choosingFor !== null} onClick={() => choose(setNewTabDirectory, "tab")}>
            {choosingFor === "tab" ? <LoaderCircle className="animate-spin" /> : <FolderOpen />}
            Choose
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Leave empty to start in the profile directory (~).</p>
      </Field>

      <Field>
        <FieldLabel>New panes</FieldLabel>
        <div className="flex gap-2">
          <Input
            value={newPaneDirectory}
            placeholder="Current directory"
            onChange={(event) => setNewPaneDirectory(event.target.value)}
          />
          <Button type="button" variant="outline" disabled={choosingFor !== null} onClick={() => choose(setNewPaneDirectory, "pane")}>
            {choosingFor === "pane" ? <LoaderCircle className="animate-spin" /> : <FolderOpen />}
            Choose
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Leave empty to inherit the focused pane's current directory.</p>
      </Field>

      <Field>
        <FieldLabel>Scrollback lines</FieldLabel>
        <Input
          type="number"
          min="0"
          max="100000"
          step="1000"
          value={scrollbackLines}
          onChange={(event) => setScrollbackLines(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">0 disables history; maximum 100,000 lines.</p>
      </Field>

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Inactive pane opacity</FieldLabel>
          <span className="text-xs tabular-nums text-muted-foreground">{Math.round(inactivePaneOpacity * 100)}%</span>
        </div>
        <input
          type="range"
          min="0.2"
          max="0.95"
          step="0.05"
          value={inactivePaneOpacity}
          className="w-full accent-primary"
          onChange={(event) => setInactivePaneOpacity(Number(event.target.value))}
        />
        <p className="text-xs text-muted-foreground">Controls how strongly terminal panes without focus are dimmed.</p>
      </Field>

      <label className="flex items-start gap-3 rounded-md border bg-muted/20 p-3">
        <Checkbox
          checked={copyOnSelection}
          onCheckedChange={(checked) => setCopyOnSelection(checked === true)}
        />
        <div>
          <p className="text-sm font-medium">Copy selected text to clipboard</p>
          <p className="text-xs text-muted-foreground">
            Automatically copy completed terminal selections to the system clipboard.
          </p>
        </div>
      </label>

      <label className="flex items-start gap-3 rounded-md border bg-muted/20 p-3">
        <Checkbox
          checked={closeTerminalsOnAppExit}
          onCheckedChange={(checked) => setCloseTerminalsOnAppExit(checked === true)}
        />
        <div>
          <p className="text-sm font-medium">Close terminal tabs when quitting</p>
          <p className="text-xs text-muted-foreground">
            Discard saved terminal tabs and pane layouts so every app launch starts on Main with no terminals.
          </p>
        </div>
      </label>

      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={isSaving} onClick={save}>
          {isSaving && <LoaderCircle className="animate-spin" />}
          Save terminal
        </Button>
        <Button type="button" variant="outline" onClick={() => { setNewTabDirectory(""); setNewPaneDirectory(""); setInactivePaneOpacity(0.65); setCloseTerminalsOnAppExit(false); setCopyOnSelection(true); setFontFamily("ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"); setFontSize("13"); setLineHeight("100"); setHorizontalSpacing("100"); setScrollbackLines("10000"); }}>
          <RotateCcw className="size-4" />
          Restore defaults
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
