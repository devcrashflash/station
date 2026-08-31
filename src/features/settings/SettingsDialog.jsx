import { useEffect, useRef, useState } from "react";
import { AtSign, Bot, CalendarDays, ChevronDown, FolderOpen, GitMerge, GitPullRequest, Keyboard, LoaderCircle, Monitor, Palette, Pencil, PlugZap, RefreshCw, RotateCcw, Signpost, SquareKanban, SquareTerminal, Trash2, UserRound } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Modal } from "@/components/common/Modal";
import { SelectControl } from "@/components/common/SelectControl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { aiPromptIconFor, aiPromptIconOptions } from "@/lib/aiPromptIcons";
import {
  AI_SESSION_BACKGROUND_REFRESH_INTERVALS,
  AI_SESSION_MAX_DONE_DURATION_SECONDS,
  AI_SESSION_MIN_DONE_DURATION_SECONDS,
  AI_SESSION_REFRESH_INTERVALS,
  AI_SESSION_SOURCE_OPTIONS,
  aiSessionSourceOption,
  aiSessionProviderLabel,
  enabledAiSessionSourceOptions,
  normalizeAiSessionSettings,
  preferredAiSessionSource,
} from "@/lib/aiSessions";
import { calendarWarnings } from "@/lib/calendar";
import { api } from "@/lib/api";
import { TRELLO_CREDENTIAL_URLS, credentialUrl } from "@/lib/credentialLinks";
import { formatShortcut, shortcutFromKeyboardEvent, shortcutPreviewFromKeyboardEvent } from "@/lib/keyboardShortcut";
import { quickCaptureShortcutConflict, quickCaptureStatus } from "@/lib/quickCaptureSettings";
import { terminalFontFamily, terminalFontOptions, terminalFontStyle, terminalFontStyleOptions } from "@/lib/terminalFonts";
import {
  terminalShellIntegrationBadgeText,
  terminalShellIntegrationBadgeVariant,
  terminalShellIntegrationDetailText,
  terminalShellIntegrationStatusText,
} from "@/lib/terminalShellIntegration";
import {
  DEFAULT_TERMINAL_SHORTCUTS,
  TERMINAL_SHORTCUT_ACTIONS,
  normalizeTerminalShortcuts,
  setTerminalShortcutRecording,
  terminalShortcutConflict,
} from "@/lib/terminalShortcuts";
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

const aiSessionDoneDurationUnits = [
  { value: "minutes", label: "Minutes", seconds: 60 },
  { value: "hours", label: "Hours", seconds: 3_600 },
  { value: "days", label: "Days", seconds: 86_400 },
];

function aiSessionDoneDurationInput(seconds) {
  const unit = [...aiSessionDoneDurationUnits]
    .reverse()
    .find((option) => seconds % option.seconds === 0)
    || aiSessionDoneDurationUnits[0];
  return { value: String(seconds / unit.seconds), unit: unit.value };
}

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
  { id: "commands", label: "Commands", description: "AI Prompts & CLI Commands", icon: Signpost },
  { id: "ai-sessions", label: "AI Sessions", description: "Runners and refresh rate", icon: Bot },
  { id: "directories", label: "Directories", description: "Local source folders", icon: FolderOpen },
  { id: "quick-capture", label: "Quick Capture", description: "Global capture overlay", icon: Keyboard },
  { id: "appearance", label: "Appearance", description: "Color theme", icon: Palette },
  { id: "terminal", label: "Terminal", description: "Typography and behavior", icon: SquareTerminal },
  { id: "browser", label: "Browser", description: "New tab behavior", icon: Monitor },
];

const aiSessionSourceGroups = Array.from(
  new Set(AI_SESSION_SOURCE_OPTIONS.map(({ provider }) => provider)),
  (provider) => ({
    provider,
    options: AI_SESSION_SOURCE_OPTIONS.filter((option) => option.provider === provider),
  }),
);

export function SettingsDialog({
  connections,
  aiPrompts,
  directories,
  browserSettings,
  commandSettings,
  aiSessionSettings,
  terminalSettings,
  terminalFonts = [],
  terminalShellIntegration,
  quickCaptureSettings,
  themePreference = "system",
  calendarAccounts = [],
  calendarSyncRuns = [],
  initialSection = "accounts",
  onClose,
  onSave,
  onDelete,
  onTest,
  onTestConnectionInput,
  onSaveAiPrompt,
  onDeleteAiPrompt,
  onChooseDirectory,
  onSaveDirectory,
  onDeleteDirectory,
  onSaveBrowserSettings,
  onSaveCommandSettings,
  onSaveAiSessionSettings,
  onSaveTerminalSettings,
  onRefreshTerminalShellIntegration,
  onInstallTerminalShellIntegration,
  onUninstallTerminalShellIntegration,
  onSaveQuickCaptureSettings,
  onThemePreferenceChange,
  onSaveCalendarSubscription,
  onSaveCalDavAccount,
  onConnectGoogleAccount,
  onCancelGoogleAccount,
  onUpdateCalendarService,
  onRefreshCalendarCollections,
  onUpdateCalendarCollections,
  onTestCalendarAccount,
  onTestCalendarAccountInput,
  onDeleteCalendarAccount,
}) {
  const [activeTab, setActiveTab] = useState(initialSection);
  const [aiPromptAgentType, setAiPromptAgentType] = useState("codex");
  const [aiPromptAgentOrigin, setAiPromptAgentOrigin] = useState("desktop");
  const [aiPromptName, setAiPromptName] = useState("");
  const [aiPromptIcon, setAiPromptIcon] = useState("sparkles");
  const [aiPromptText, setAiPromptText] = useState("");
  const [editingAiPromptId, setEditingAiPromptId] = useState(null);
  const [aiPromptEditorMode, setAiPromptEditorMode] = useState(null);
  const [isChoosingDirectory, setIsChoosingDirectory] = useState(false);
  const [directoryNotice, setDirectoryNotice] = useState("");
  const [browserBundleId, setBrowserBundleId] = useState(browserSettings?.browserBundleId || "");
  const [browserNotice, setBrowserNotice] = useState("");
  const activeSectionLabel = settingsSections.find((section) => section.id === activeTab)?.label || settingsSections[0].label;
  const enabledAiPromptSources = enabledAiSessionSourceOptions(aiSessionSettings);
  const selectedAiPromptSourceEnabled = enabledAiPromptSources.some((source) => (
    source.provider === aiPromptAgentType && source.origin === aiPromptAgentOrigin
  ));

  useEffect(() => {
    setBrowserBundleId(browserSettings?.browserBundleId || "");
  }, [browserSettings?.browserBundleId]);

  function resetAiPromptForm() {
    setAiPromptAgentType("codex");
    setAiPromptAgentOrigin("desktop");
    setAiPromptName("");
    setAiPromptIcon("sparkles");
    setAiPromptText("");
    setEditingAiPromptId(null);
    setAiPromptEditorMode(null);
  }

  function createAiPrompt(source) {
    setAiPromptAgentType(source.provider);
    setAiPromptAgentOrigin(source.origin);
    setAiPromptName("");
    setAiPromptIcon("sparkles");
    setAiPromptText("");
    setEditingAiPromptId(null);
    setAiPromptEditorMode("create");
  }

  function editAiPrompt(prompt) {
    const source = preferredAiSessionSource(
      aiSessionSettings,
      prompt.agentType,
      prompt.agentOrigin || "desktop",
    );
    setAiPromptAgentType(source?.provider || "");
    setAiPromptAgentOrigin(source?.origin || "");
    setAiPromptName(prompt.name);
    setAiPromptIcon(prompt.icon || "sparkles");
    setAiPromptText(prompt.promptText || "");
    setEditingAiPromptId(prompt.id);
    setAiPromptEditorMode("edit");
  }

  async function submitAiPrompt(event) {
    event.preventDefault();
    try {
      await onSaveAiPrompt({
        id: editingAiPromptId,
        agentType: aiPromptAgentType,
        agentOrigin: aiPromptAgentOrigin,
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
      title={`Settings - ${activeSectionLabel}`}
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

        <main className="min-h-0 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6" style={activeTab === "accounts" ? { overflowAnchor: "none" } : undefined}>
          <div className="mx-auto grid w-full max-w-3xl gap-6">
            {activeTab === "accounts" && (
              <AccountsSettingsTab
                connections={connections}
                calendarAccounts={calendarAccounts}
                calendarSyncRuns={calendarSyncRuns}
                onSaveConnection={onSave}
                onDeleteConnection={onDelete}
                onTestConnection={onTest}
                onTestConnectionInput={onTestConnectionInput}
                onSaveSubscription={onSaveCalendarSubscription}
                onSaveCalDav={onSaveCalDavAccount}
                onConnectGoogle={onConnectGoogleAccount}
                onCancelGoogle={onCancelGoogleAccount}
                onUpdateService={onUpdateCalendarService}
                onRefreshCalendars={onRefreshCalendarCollections}
                onUpdateCollections={onUpdateCalendarCollections}
                onTestCalendar={onTestCalendarAccount}
                onTestCalendarInput={onTestCalendarAccountInput}
                onDeleteCalendar={onDeleteCalendarAccount}
              />
            )}

            {activeTab === "commands" && (
              <div className="grid gap-6">
                <FieldSet className="gap-4 rounded-lg border p-4">
                  <FieldLegend className="mb-0 px-1">AI Prompts</FieldLegend>

                  <div className="grid gap-4 rounded-md border bg-muted/20 p-4">
                    <div>
                      <p className="font-medium">Add AI Prompt</p>
                      <p className="mt-1 text-sm text-muted-foreground">Choose an enabled AI Session source to configure a new prompt.</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {enabledAiPromptSources.map((option) => {
                        const Icon = option.origin === "cli" ? SquareTerminal : Bot;
                        return (
                          <Button
                            key={option.key}
                            type="button"
                            variant={aiPromptEditorMode === "create" && aiPromptAgentType === option.provider && aiPromptAgentOrigin === option.origin ? "secondary" : "outline"}
                            onClick={() => createAiPrompt(option)}
                          >
                            <Icon />
                            {option.label}
                          </Button>
                        );
                      })}
                      {enabledAiPromptSources.length === 0 && (
                        <p className="text-sm text-muted-foreground">Enable an AI Session source before adding an AI Prompt.</p>
                      )}
                    </div>

                    {aiPromptEditorMode && (
                      <form className="grid gap-3 border-t pt-4" onSubmit={submitAiPrompt}>
                        <div>
                          <p className="font-medium">
                            {aiPromptEditorMode === "edit"
                              ? "Edit AI Prompt"
                              : `Add ${aiSessionSourceOption(aiPromptAgentType, aiPromptAgentOrigin)?.label || "AI"} Prompt`}
                          </p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {aiPromptEditorMode === "edit"
                              ? "Update this saved prompt."
                              : "Configure reusable instructions for this provider."}
                          </p>
                        </div>
                        <div className={cn("grid gap-3", aiPromptEditorMode === "edit" && "sm:grid-cols-2")}>
                          {aiPromptEditorMode === "edit" && (
                            <Field>
                              <FieldLabel>AI Agent</FieldLabel>
                              <SelectControl
                                value={`${aiPromptAgentType}:${aiPromptAgentOrigin}`}
                                onValueChange={(value) => {
                                  const [provider, origin] = value.split(":");
                                  setAiPromptAgentType(provider);
                                  setAiPromptAgentOrigin(origin);
                                }}
                                options={enabledAiPromptSources.map((option) => ({
                                  value: `${option.provider}:${option.origin}`,
                                  label: option.label,
                                }))}
                              />
                            </Field>
                          )}
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
                          <Button type="submit" disabled={!selectedAiPromptSourceEnabled}>
                            {aiPromptEditorMode === "edit" ? "Update AI Prompt" : "Save AI Prompt"}
                          </Button>
                          <Button type="button" variant="outline" onClick={resetAiPromptForm}>
                            {aiPromptEditorMode === "edit" ? "Cancel edit" : "Cancel"}
                          </Button>
                        </div>
                      </form>
                    )}
                  </div>

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
                              {aiSessionSourceOption(prompt.agentType, prompt.agentOrigin || "desktop")?.label || prompt.agentType}
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
                </FieldSet>

                <CommandInternalsSettings
                  settings={commandSettings}
                  onSave={onSaveCommandSettings}
                />
              </div>
            )}

            {activeTab === "ai-sessions" && (
              <AiSessionSettingsTab
                settings={aiSessionSettings}
                onSave={onSaveAiSessionSettings}
              />
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
                shellIntegration={terminalShellIntegration}
                onChooseDirectory={onChooseDirectory}
                onSave={onSaveTerminalSettings}
                onRefreshShellIntegration={onRefreshTerminalShellIntegration}
                onInstallShellIntegration={onInstallTerminalShellIntegration}
                onUninstallShellIntegration={onUninstallTerminalShellIntegration}
              />
            )}

            {activeTab === "quick-capture" && (
              <QuickCaptureSettingsTab
                settings={quickCaptureSettings}
                terminalShortcuts={terminalSettings?.shortcuts}
                onSave={onSaveQuickCaptureSettings}
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

function CommandInternalsSettings({ settings, onSave }) {
  const [reviewEnabled, setReviewEnabled] = useState(settings?.reviewEnabled !== false);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeIsError, setNoticeIsError] = useState(false);

  useEffect(() => {
    setReviewEnabled(settings?.reviewEnabled !== false);
  }, [settings?.reviewEnabled]);

  async function toggleReviewEnabled(enabled) {
    const previous = reviewEnabled;
    setReviewEnabled(enabled);
    setNotice("");
    setNoticeIsError(false);
    setIsSaving(true);
    try {
      const next = await onSave({ reviewEnabled: enabled });
      setReviewEnabled(next?.reviewEnabled !== false);
      setNotice(enabled ? "Review command enabled." : "Review command disabled.");
    } catch (error) {
      setReviewEnabled(previous);
      setNotice(error?.message || String(error));
      setNoticeIsError(true);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <FieldSet className="gap-4 rounded-lg border p-4">
      <FieldLegend className="mb-0 px-1">Internals</FieldLegend>
      <p className="text-xs text-muted-foreground">
        Control built-in commands provided by Station.
      </p>

      <label className={cn(
        "flex items-start gap-3 rounded-md border bg-muted/20 p-3",
        isSaving ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      )}>
        <Checkbox
          checked={reviewEnabled}
          disabled={isSaving}
          aria-label="Enable Review command"
          onCheckedChange={(checked) => toggleReviewEnabled(checked === true)}
        />
        <span className="grid gap-1">
          <span className="text-sm font-medium">Enable Review command</span>
          <span className="text-xs text-muted-foreground">
            Show Review for tasks linked to GitHub pull requests or GitLab merge requests.
          </span>
        </span>
      </label>

      {notice && (
        <p className={cn("text-xs", noticeIsError ? "text-destructive" : "text-muted-foreground")}>
          {notice}
        </p>
      )}
    </FieldSet>
  );
}

function AiSessionSettingsTab({ settings, onSave }) {
  const [candidate, setCandidate] = useState(() => normalizeAiSessionSettings(settings));
  const [doneDuration, setDoneDuration] = useState(() => (
    aiSessionDoneDurationInput(normalizeAiSessionSettings(settings).doneStateDurationSeconds)
  ));
  const [notice, setNotice] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const normalized = normalizeAiSessionSettings(settings);
    setCandidate(normalized);
    setDoneDuration(aiSessionDoneDurationInput(normalized.doneStateDurationSeconds));
  }, [settings]);

  async function save() {
    setNotice("");
    const unit = aiSessionDoneDurationUnits.find(({ value }) => value === doneDuration.unit);
    const doneStateDurationSeconds = Math.round(Number(doneDuration.value) * unit.seconds);
    if (
      !Number.isFinite(doneStateDurationSeconds)
      || doneStateDurationSeconds < AI_SESSION_MIN_DONE_DURATION_SECONDS
      || doneStateDurationSeconds > AI_SESSION_MAX_DONE_DURATION_SECONDS
    ) {
      setNotice("Done duration must be between 1 minute and 7 days.");
      return;
    }
    setIsSaving(true);
    try {
      const next = await onSave({ ...candidate, doneStateDurationSeconds });
      const normalized = normalizeAiSessionSettings(next);
      setCandidate(normalized);
      setDoneDuration(aiSessionDoneDurationInput(normalized.doneStateDurationSeconds));
      setNotice("AI session settings saved.");
    } catch (error) {
      setNotice(error?.message || String(error));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="grid gap-5">
      <FieldSet className="gap-4 rounded-lg border p-4">
        <FieldLegend className="mb-0 px-1">Local AI Runners</FieldLegend>
        <p className="text-xs text-muted-foreground">
          Choose which locally discovered AI sessions appear in the AI Sessions view.
          Older sessions without source information remain visible when either source for their provider is enabled.
        </p>

        <div className="grid gap-3">
          {aiSessionSourceGroups.map(({ provider, options }) => (
            <div key={provider} className="grid gap-3 rounded-lg border bg-muted/20 p-4">
              <p className="text-sm font-medium">{aiSessionProviderLabel(provider)}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {options.map((option) => (
                  <label
                    key={option.key}
                    className={cn(
                      "flex items-start gap-3 rounded-md border bg-background/60 p-3 transition-colors",
                      isSaving
                        ? "cursor-not-allowed opacity-60"
                        : "cursor-pointer hover:bg-muted/35",
                    )}
                  >
                    <Checkbox
                      checked={candidate[option.key]}
                      disabled={isSaving}
                      aria-label={`${aiSessionProviderLabel(provider)} ${option.origin === "cli" ? "CLI" : "Desktop"}`}
                      onCheckedChange={(checked) => setCandidate((current) => ({
                        ...current,
                        [option.key]: checked === true,
                      }))}
                    />
                    <span className="grid gap-1">
                      <span className="text-sm font-medium">
                        {option.origin === "cli" ? "CLI" : "Desktop"}
                      </span>
                      <span className="text-xs text-muted-foreground">{option.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          You can disable every local runner to hide all locally discovered AI sessions.
        </p>
      </FieldSet>

      <FieldSet className="gap-4 rounded-lg border p-4">
        <FieldLegend className="mb-0 px-1">Session states</FieldLegend>
        <p className="text-xs text-muted-foreground">
          Choose how long a completed AI task remains marked as Done before it becomes Idle.
        </p>

        <Field>
          <FieldLabel>Done duration</FieldLabel>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px]">
            <Input
              type="number"
              min={AI_SESSION_MIN_DONE_DURATION_SECONDS / (aiSessionDoneDurationUnits.find(({ value }) => value === doneDuration.unit)?.seconds || 60)}
              max={AI_SESSION_MAX_DONE_DURATION_SECONDS / (aiSessionDoneDurationUnits.find(({ value }) => value === doneDuration.unit)?.seconds || 60)}
              step="any"
              value={doneDuration.value}
              aria-label="Done duration value"
              disabled={isSaving}
              onChange={(event) => setDoneDuration((current) => ({
                ...current,
                value: event.target.value,
              }))}
            />
            <SelectControl
              value={doneDuration.unit}
              onValueChange={(value) => setDoneDuration((current) => {
                const currentUnit = aiSessionDoneDurationUnits.find((option) => option.value === current.unit);
                const nextUnit = aiSessionDoneDurationUnits.find((option) => option.value === value);
                const seconds = Number(current.value) * currentUnit.seconds;
                return {
                  value: Number.isFinite(seconds) ? String(seconds / nextUnit.seconds) : current.value,
                  unit: value,
                };
              })}
              options={aiSessionDoneDurationUnits}
              triggerClassName="w-full"
              disabled={isSaving}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Enter any duration from 1 minute to 7 days. The default is 3 hours.
          </p>
        </Field>
      </FieldSet>

      <FieldSet className="gap-4 rounded-lg border p-4">
        <FieldLegend className="mb-0 px-1">Refresh rate</FieldLegend>
        <p className="text-xs text-muted-foreground">
          Control how often Station checks AI runners for session updates.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel>Foreground refresh</FieldLabel>
            <SelectControl
              value={String(candidate.foregroundRefreshIntervalSeconds)}
              onValueChange={(value) => setCandidate((current) => ({
                ...current,
                foregroundRefreshIntervalSeconds: Number(value),
              }))}
              options={AI_SESSION_REFRESH_INTERVALS.map((option) => ({
                ...option,
                value: String(option.value),
              }))}
              triggerClassName="w-full"
              disabled={isSaving}
            />
            <p className="text-xs text-muted-foreground">
              Used while AI Agents is visible. Off continues at the background rate.
            </p>
          </Field>

          <Field>
            <FieldLabel>Background refresh</FieldLabel>
            <SelectControl
              value={String(candidate.backgroundRefreshIntervalSeconds)}
              onValueChange={(value) => setCandidate((current) => ({
                ...current,
                backgroundRefreshIntervalSeconds: Number(value),
              }))}
              options={AI_SESSION_BACKGROUND_REFRESH_INTERVALS.map((option) => ({
                ...option,
                value: String(option.value),
              }))}
              triggerClassName="w-full"
              disabled={isSaving}
            />
            <p className="text-xs text-muted-foreground">
              Used whenever AI Agents is not foreground. Monitoring continues while Station runs.
            </p>
          </Field>
        </div>
      </FieldSet>

      <div className="flex justify-end">
        <Button type="button" disabled={isSaving} onClick={save}>
          {isSaving && <LoaderCircle className="animate-spin" />}
          Save
        </Button>
      </div>
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
    </div>
  );
}

function QuickCaptureSettingsTab({ settings, terminalShortcuts, onSave }) {
  const [candidate, setCandidate] = useState(settings?.shortcut || "CommandOrControl+Shift+Space");
  const [isRecording, setIsRecording] = useState(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [recordingPreview, setRecordingPreview] = useState(null);
  const [notice, setNotice] = useState(settings?.error || "");
  const [noticeIsError, setNoticeIsError] = useState(Boolean(settings?.error));
  const [isSaving, setIsSaving] = useState(false);
  const recorderMountedRef = useRef(true);
  const nativeRecordingRequestedRef = useRef(false);
  const supported = settings?.supported === true;
  const status = quickCaptureStatus(settings);
  const shortcutConflict = candidate !== settings?.shortcut
    ? quickCaptureShortcutConflict(candidate, terminalShortcuts)
    : null;

  useEffect(() => {
    setCandidate(settings?.shortcut || settings?.defaultShortcut || "CommandOrControl+Shift+Space");
    setNotice(settings?.error || "");
    setNoticeIsError(Boolean(settings?.error));
  }, [settings]);

  useEffect(() => {
    recorderMountedRef.current = true;
    return () => {
      recorderMountedRef.current = false;
      setTerminalShortcutRecording(false);
      if (nativeRecordingRequestedRef.current) {
        api.setQuickCaptureShortcutRecording(false).catch(console.error);
      }
    };
  }, []);

  useEffect(() => {
    if (!isRecording) return undefined;
    setTerminalShortcutRecording(true);
    let active = true;
    let pendingFinish = null;

    async function finishRecording(result) {
      try {
        await api.setQuickCaptureShortcutRecording(false);
        nativeRecordingRequestedRef.current = false;
        if (!active) return;
        setIsRecording(false);
        setRecordingPreview(null);
        if (result.status === "cancel") {
          setNotice("Recording cancelled.");
        } else {
          setNotice("Shortcut recorded. Save to activate it.");
        }
        setNoticeIsError(false);
      } catch (error) {
        if (!active) return;
        setIsRecording(false);
        setRecordingPreview(null);
        setNotice(error?.message || String(error));
        setNoticeIsError(true);
      }
    }

    function handleRecorderKeyDown(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat || pendingFinish) return;

      const result = shortcutFromKeyboardEvent(event);
      if (result.status === "cancel") {
        pendingFinish = { result, code: event.code };
        setNotice("Release Escape to cancel recording.");
        setNoticeIsError(false);
        return;
      }
      if (result.status === "recording") {
        setRecordingPreview(shortcutPreviewFromKeyboardEvent(event));
        setNotice("Press a non-modifier key to finish the shortcut.");
        setNoticeIsError(false);
        return;
      }
      if (result.status === "error") {
        setRecordingPreview("");
        setNotice(result.error);
        setNoticeIsError(true);
        return;
      }

      setCandidate(result.shortcut);
      setRecordingPreview(result.shortcut);
      pendingFinish = { result, code: event.code };
      setNotice("Shortcut recorded. Release the key to finish.");
      setNoticeIsError(false);
    }

    function handleRecorderKeyUp(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!pendingFinish) {
        setRecordingPreview(shortcutPreviewFromKeyboardEvent(event, { includeKey: false }));
        return;
      }
      if (event.code !== pendingFinish.code) return;
      const { result } = pendingFinish;
      pendingFinish = null;
      finishRecording(result);
    }

    window.addEventListener("keydown", handleRecorderKeyDown, true);
    window.addEventListener("keyup", handleRecorderKeyUp, true);
    return () => {
      active = false;
      window.removeEventListener("keydown", handleRecorderKeyDown, true);
      window.removeEventListener("keyup", handleRecorderKeyUp, true);
      setTerminalShortcutRecording(false);
      if (nativeRecordingRequestedRef.current) {
        api.setQuickCaptureShortcutRecording(false)
          .then(() => { nativeRecordingRequestedRef.current = false; })
          .catch(console.error);
      }
    };
  }, [isRecording]);

  async function startRecording() {
    setIsStartingRecording(true);
    setNotice("Preparing shortcut recording…");
    setNoticeIsError(false);
    nativeRecordingRequestedRef.current = true;
    try {
      await api.setQuickCaptureShortcutRecording(true);
      if (!recorderMountedRef.current) {
        await api.setQuickCaptureShortcutRecording(false);
        nativeRecordingRequestedRef.current = false;
        return;
      }
      setTerminalShortcutRecording(true);
      setRecordingPreview("");
      setIsRecording(true);
      setNotice("Press the new shortcut. Escape cancels.");
    } catch (error) {
      nativeRecordingRequestedRef.current = false;
      setTerminalShortcutRecording(false);
      setRecordingPreview(null);
      if (!recorderMountedRef.current) return;
      setNotice(error?.message || String(error));
      setNoticeIsError(true);
    } finally {
      if (recorderMountedRef.current) setIsStartingRecording(false);
    }
  }

  async function save(shortcut) {
    setIsSaving(true);
    setNotice("");
    setNoticeIsError(false);
    try {
      const nextSettings = await onSave({ enabled: settings.enabled, shortcut });
      setCandidate(nextSettings.shortcut);
      if (shortcut === settings.defaultShortcut) {
        setNotice("Default shortcut restored.");
      } else {
        setNotice(nextSettings.enabled
          ? "Shortcut saved and active."
          : "Shortcut saved for when Quick Capture is enabled.");
      }
      setNoticeIsError(false);
    } catch (error) {
      setNotice(error?.message || String(error));
      setNoticeIsError(true);
    } finally {
      setIsSaving(false);
    }
  }

  async function toggleEnabled(enabled) {
    setIsSaving(true);
    setNotice("");
    setNoticeIsError(false);
    try {
      const nextSettings = await onSave({ enabled, shortcut: settings.shortcut });
      setCandidate(nextSettings.shortcut);
      setNotice(enabled ? "Quick Capture enabled." : "Quick Capture disabled.");
    } catch (error) {
      setNotice(error?.message || String(error));
      setNoticeIsError(true);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="grid gap-5">
      <FieldSet className="gap-4 rounded-lg border p-4">
        <FieldLegend className="mb-0 px-1">Quick Capture overlay</FieldLegend>
        <p className="text-xs text-muted-foreground">
          Open the capture overlay from any application while Station is running.
        </p>

        {!supported ? (
          <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            Quick Capture configuration requires the desktop app.
          </p>
        ) : (
          <label className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
            <Checkbox
              checked={settings.enabled}
              disabled={isSaving || isRecording || isStartingRecording}
              onCheckedChange={(checked) => toggleEnabled(checked === true)}
            />
            <span className="grid gap-1">
              <span className="text-sm font-medium">Enable Quick Capture</span>
              <span className="text-xs text-muted-foreground">
                Create the capture overlay and make it available through the global shortcut.
              </span>
            </span>
          </label>
        )}
      </FieldSet>

      {supported && (
        <>
          <FieldSet className="gap-4 rounded-lg border p-4">
            <FieldLegend className="mb-0 px-1">Global shortcut</FieldLegend>
            <p className="text-xs text-muted-foreground">
              Include Command, Control, Option, or Alt with another key. Shift can be added as an extra modifier.
            </p>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">Current shortcut</span>
                <div className="flex items-center gap-2">
                  <Kbd className="h-7 px-2 text-sm">{formatShortcut(settings.shortcut)}</Kbd>
                  <Badge variant={status.variant}>
                    {status.label}
                  </Badge>
                </div>
              </div>
              <div className="grid justify-items-end gap-1">
                <span className="text-xs text-muted-foreground">New shortcut</span>
                <Kbd className="h-7 px-2 text-sm">
                  {formatShortcut(isRecording ? recordingPreview : candidate) || "—"}
                </Kbd>
              </div>
            </div>

            <Button
              type="button"
              variant={isRecording ? "secondary" : "outline"}
              disabled={isSaving || isStartingRecording}
              onClick={startRecording}
            >
              {isStartingRecording ? <LoaderCircle className="animate-spin" /> : <Keyboard />}
              {isStartingRecording ? "Preparing…" : isRecording ? "Press shortcut…" : "Record shortcut"}
            </Button>
          </FieldSet>

          {shortcutConflict && (
            <p className="text-sm text-amber-700 dark:text-amber-300" role="status">
              This shortcut is also assigned to {shortcutConflict.label}. Saving it confirms that Smart Overlay may override that action.
            </p>
          )}

          {notice && (
            <p className={cn("text-sm text-muted-foreground", noticeIsError && "text-destructive")} role="status">
              {notice}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={isSaving || isRecording || isStartingRecording} onClick={() => save(candidate)}>
              {isSaving && <LoaderCircle className="animate-spin" />}
              Save shortcut
            </Button>
            <Button type="button" variant="outline" disabled={isSaving || isRecording || isStartingRecording} onClick={() => save(settings.defaultShortcut)}>
              <RotateCcw />
              Restore default
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function AccountsSettingsTab({ connections, calendarAccounts, calendarSyncRuns, onSaveConnection, onDeleteConnection, onTestConnection, onTestConnectionInput, onSaveSubscription, onSaveCalDav, onConnectGoogle, onCancelGoogle, onUpdateService, onRefreshCalendars, onUpdateCollections, onTestCalendar, onTestCalendarInput, onDeleteCalendar }) {
  const [editor, setEditor] = useState(null);
  const [fields, setFields] = useState({});
  const [calendarKind, setCalendarKind] = useState("caldav");
  const [busyKey, setBusyKey] = useState("");
  const [editorError, setEditorError] = useState("");
  const [editorTestResult, setEditorTestResult] = useState(null);
  const [actionNotice, setActionNotice] = useState("");
  const [testResults, setTestResults] = useState({});
  const googleConnectRunRef = useRef(0);
  const editorTestRunRef = useRef(0);

  function resetEditor(nextEditor = null, nextFields = {}, nextCalendarKind = "caldav") {
    editorTestRunRef.current += 1;
    setEditor(nextEditor);
    setFields(nextFields);
    setCalendarKind(nextCalendarKind);
    setEditorError("");
    setEditorTestResult(null);
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
    editorTestRunRef.current += 1;
    setEditorTestResult(null);
    setFields((current) => ({ ...current, [name]: value }));
  }

  function changeCalendarKind(value) {
    editorTestRunRef.current += 1;
    setCalendarKind(value);
    setFields(value === "ical" ? { color: "#64748b" } : {});
    setEditorError("");
    setEditorTestResult(null);
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

  function closeAccountEditor() {
    if (busyKey === "editor" || busyKey === "google-cancel") return;
    if (busyKey === "google-connect") {
      cancelGoogle();
      return;
    }
    resetEditor();
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
    setBusyKey(`test:${id}`);
    setTestResults((current) => ({ ...current, [id]: { ok: null, message: "Testing connection..." } }));
    try {
      const result = await onTestConnection(id);
      setTestResults((current) => ({ ...current, [id]: result }));
    } catch (error) {
      setTestResults((current) => ({ ...current, [id]: { ok: false, message: error?.message || String(error) } }));
    } finally {
      setBusyKey("");
    }
  }

  async function testCalendar(id) {
    setBusyKey(`test:${id}`);
    setTestResults((current) => ({ ...current, [id]: { ok: null, message: "Testing connection..." } }));
    try {
      const message = await onTestCalendar(id);
      setTestResults((current) => ({ ...current, [id]: { ok: true, message } }));
    } catch (error) {
      setTestResults((current) => ({ ...current, [id]: { ok: false, message: error?.message || String(error) } }));
    } finally {
      setBusyKey("");
    }
  }

  async function testEditorConnection() {
    const run = editorTestRunRef.current + 1;
    editorTestRunRef.current = run;
    setEditorTestResult({ ok: null, message: "Testing connection..." });
    try {
      const result = ["github", "gitlab", "trello"].includes(editor.type)
        ? await onTestConnectionInput({
          id: editor.mode === "edit" ? editor.id : null,
          provider: editor.type,
          name: fields.name || "",
          baseUrl: editor.type === "trello" ? TRELLO_BASE_URL : fields.baseUrl || "",
          apiKey: editor.type === "trello" ? fields.apiKey || "" : null,
          token: fields.token || "",
        })
        : await onTestCalendarInput({
          id: editor.mode === "edit" ? editor.id : null,
          provider: calendarKind,
          serverUrl: calendarKind === "caldav" ? fields.serverUrl || "" : null,
          username: calendarKind === "caldav" ? fields.username || "" : null,
          password: calendarKind === "caldav" ? fields.password || "" : null,
          url: calendarKind === "ical" ? fields.url || "" : null,
        });
      if (editorTestRunRef.current !== run) return;
      setEditorTestResult(["github", "gitlab", "trello"].includes(editor.type)
        ? result
        : { ok: true, message: result });
    } catch (error) {
      if (editorTestRunRef.current !== run) return;
      setEditorTestResult({ ok: false, message: error?.message || String(error) });
    }
  }

  const tokenUrl = editor && ["github", "gitlab", "trello"].includes(editor.type)
    ? credentialUrl(editor.type, fields.baseUrl || "", fields.apiKey || "")
    : "";
  const editorProviderLabel = editor?.type === "google"
    ? "Google"
    : providerOptions.find((item) => item.value === editor?.type)?.label;
  const savedCount = connections.length + calendarAccounts.length;
  const calendarAccountWarnings = calendarWarnings(calendarSyncRuns);
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
      <div className="grid gap-4 rounded-md border bg-muted/20 p-4">
        <div>
          <p className="font-medium">Add account</p>
          <p className="mt-1 text-sm text-muted-foreground">Choose a provider to configure.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {accountAddOptions.map((option) => {
            const Icon = option.icon;
            return <Button key={option.value} type="button" disabled={busyKey === "google-connect" || busyKey === "google-cancel"} variant="outline" onClick={() => openCreate(option.value)}>
              <Icon />{option.label}
            </Button>;
          })}
        </div>
      </div>

      {editor && editor.type !== "calendar" && <Modal title={`${editor.mode === "edit" ? "Edit" : "Add"} ${editorProviderLabel} account`} onClose={closeAccountEditor} contentClassName="sm:max-w-xl">
        {["github", "gitlab", "trello"].includes(editor.type) && (
          <form className="grid max-h-[75vh] gap-3 overflow-y-auto pr-1" onSubmit={submitDeveloper}>
            <Field><FieldLabel>Connection name</FieldLabel><Input value={fields.name || ""} onChange={(event) => setField("name", event.target.value)} required /></Field>
            {editor.type === "trello" ? <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
              <p>Get an API key, paste it below, then generate an API token for your account.</p>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                <a className="font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300" href={TRELLO_CREDENTIAL_URLS.apps} target="_blank" rel="noreferrer">Trello app administration</a>
                <a className="font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300" href={TRELLO_CREDENTIAL_URLS.powerUps} target="_blank" rel="noreferrer">Power-Up administration</a>
                <a className="font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300" href={TRELLO_CREDENTIAL_URLS.legacyAppKey} target="_blank" rel="noreferrer">Legacy app-key page</a>
                <a className="font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300" href={TRELLO_CREDENTIAL_URLS.setupGuide} target="_blank" rel="noreferrer">Trello API setup guide</a>
              </div>
            </div> : (
              <Field><FieldLabel>{editor.type === "github" ? "GitHub server" : "GitLab server"}</FieldLabel><Input value={fields.baseUrl || ""} onChange={(event) => setField("baseUrl", event.target.value)} required /></Field>
            )}
            {editor.type === "trello" && <Field><FieldLabel>API key</FieldLabel><Input type="password" value={fields.apiKey || ""} onChange={(event) => setField("apiKey", event.target.value)} required /></Field>}
            <Field>
              <FieldLabel>{editor.type === "trello" ? "API token" : "Token"}</FieldLabel>
              <Input type="password" value={fields.token || ""} onChange={(event) => setField("token", event.target.value)} required />
              <div className="grid gap-1 text-xs text-muted-foreground"><p>{permissionHints[editor.type]}</p>{tokenUrl ? <a className="font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300" href={tokenUrl} target="_blank" rel="noreferrer">Generate token</a> : editor.type === "trello" ? <span>Enter an API key to generate a token.</span> : null}</div>
            </Field>
            <EditorFooter busy={busyKey === "editor"} submitLabel={editor.mode === "edit" ? "Update connection" : `Add ${editorProviderLabel}`} error={editorError} testResult={editorTestResult} onTest={testEditorConnection} onCancel={closeAccountEditor} />
          </form>
        )}

        {editor.type === "google" && (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">{editor.mode === "edit" ? `Reconnect ${fields.name} to refresh its Google authorization.` : "Sign in with Google to discover calendars. Calendar access is read-only."}</p>
            {editorError && <p className="rounded-md border bg-background p-3 text-sm text-destructive">{editorError}</p>}
            <div className="flex gap-2"><Button type="button" disabled={busyKey === "google-connect" || busyKey === "google-cancel"} onClick={connectGoogle}>{busyKey === "google-connect" && <LoaderCircle className="animate-spin" />}{busyKey === "google-connect" ? "Connecting Google…" : editor.mode === "edit" ? "Reconnect Google" : "Connect Google"}</Button><Button type="button" variant="outline" disabled={busyKey === "google-cancel"} onClick={closeAccountEditor}>{busyKey === "google-cancel" && <LoaderCircle className="animate-spin" />}{busyKey === "google-connect" || busyKey === "google-cancel" ? "Cancel connection" : "Cancel"}</Button></div>
          </div>
        )}
      </Modal>}

      {editor?.type === "calendar" && <Modal title={editor.mode === "edit" ? "Edit calendar" : "Add calendar"} onClose={() => resetEditor()} contentClassName="sm:max-w-xl">
        <form className="grid max-h-[75vh] gap-3 overflow-y-auto pr-1" onSubmit={submitCalendar}>
          <Field><FieldLabel>Calendar type</FieldLabel><SelectControl value={calendarKind} disabled={editor.mode === "edit"} onValueChange={changeCalendarKind} options={calendarKindOptions} /></Field>
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
          <EditorFooter busy={busyKey === "editor"} submitLabel={editor.mode === "edit" ? (calendarKind === "caldav" ? "Reconnect account" : "Update subscription") : (calendarKind === "caldav" ? "Connect CalDAV" : "Add calendar")} error={editorError} testResult={editorTestResult} onTest={testEditorConnection} onCancel={() => resetEditor()} />
        </form>
      </Modal>}

      {actionNotice && <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">{actionNotice}</p>}
      {savedCount === 0 ? <EmptyState text="No accounts configured." /> : <div className="grid gap-5">
        {groups.map((group) => group.items.length > 0 && <AccountGroup key={group.id} group={group} busyKey={busyKey} testResults={testResults} calendarWarnings={calendarAccountWarnings} onEdit={group.kind === "developer" ? editConnection : editCalendar} onReconnect={(item) => runAction(`reconnect:${item.id}`, () => onConnectGoogle(item.id), `${item.name} reconnected.`).catch(() => {})} onTest={(item) => group.kind === "developer" ? testDeveloper(item.id) : testCalendar(item.id)} onRefresh={(item) => runAction(`refresh:${item.id}`, () => onRefreshCalendars(item.id), "Calendars refreshed.").catch(() => {})} onDelete={(item) => runAction(`delete:${item.id}`, () => group.kind === "developer" ? onDeleteConnection(item.id) : onDeleteCalendar(item.id), "Account removed.").then(() => { if (editor?.id === item.id) resetEditor(); }).catch(() => {})} onUpdateService={(item, enabled) => runAction(`service:${item.id}`, () => onUpdateService(item.id, enabled), enabled ? "Google Calendar enabled." : "Google Calendar paused.").catch(() => {})} onUpdateCollections={onUpdateCollections} setActionNotice={setActionNotice} />)}
      </div>}
    </div>
  );
}

function EditorFooter({ busy, submitLabel, error, testResult, onTest, onCancel }) {
  const testing = testResult?.ok === null;
  return <>
    {error && <p className="rounded-md border bg-background p-3 text-sm text-destructive">{error}</p>}
    {testResult && (
      <div className="flex items-center gap-2 rounded-md border bg-background p-3">
        <Badge variant={testResult.ok === false ? "destructive" : "secondary"} className={cn(testResult.ok === true && "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300")}>
          {testing ? "Testing" : testResult.ok ? "Connected" : "Failed"}
        </Badge>
        <span className="text-xs text-muted-foreground">{testResult.message}</span>
      </div>
    )}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={busy}>{busy && <LoaderCircle className="animate-spin" />}{submitLabel}</Button>
      <Button type="button" variant="outline" disabled={busy || testing} onClick={onTest}>{testing && <LoaderCircle className="animate-spin" />}{testing ? "Testing…" : "Test connection"}</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
    </div>
  </>;
}

function AccountGroup({ group, busyKey, testResults, calendarWarnings: warnings, onEdit, onReconnect, onTest, onRefresh, onDelete, onUpdateService, onUpdateCollections, setActionNotice }) {
  const Icon = group.icon;
  return (
    <section className="grid gap-2">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <h3 className="font-semibold">{group.label}</h3>
        <Badge variant="secondary">{group.items.length}</Badge>
      </div>
      {group.items.map((item) => {
        const isDeveloper = group.kind === "developer";
        const result = testResults[item.id];
        const isTesting = busyKey === `test:${item.id}`;
        const reconnectWarnings = item.provider === "google"
          ? warnings.filter((warning) => warning.accountId === item.id && warning.reconnectable)
          : [];
        return (
          <div key={item.id} className="grid gap-3 rounded-md border p-4">
            <div className="flex min-w-0 items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{item.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {isDeveloper ? (item.provider === "trello" ? "Cloud API" : item.baseUrl) : calendarTypeLabels[item.provider] || "Calendar"}
                </p>
                {result && (
                  <div className="mt-2 flex items-center gap-2">
                    <Badge variant={result.ok === false ? "destructive" : "secondary"} className={cn(result.ok === true && "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300")}>
                      {result.ok === null ? "Testing" : result.ok ? "Connected" : "Failed"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{result.message}</span>
                  </div>
                )}
              </div>
              <Button size="icon-sm" variant="ghost" title={item.provider === "google" ? "Reconnect account" : "Edit account"} onClick={() => onEdit(item)}>
                <Pencil />
              </Button>
              <Button size="icon-sm" variant="ghost" title="Test account" aria-disabled={isTesting || undefined} disabled={Boolean(busyKey) && !isTesting} onClick={() => { if (!busyKey) onTest(item); }}>
                {isTesting ? <LoaderCircle className="animate-spin" /> : <PlugZap />}
              </Button>
              {!isDeveloper && (
                <Button size="icon-sm" variant="ghost" title="Refresh calendars" disabled={Boolean(busyKey)} onClick={() => onRefresh(item)}>
                  <RefreshCw className={busyKey === `refresh:${item.id}` ? "animate-spin" : ""} />
                </Button>
              )}
              <Button size="icon-sm" variant="ghost" title="Delete account" disabled={Boolean(busyKey)} onClick={() => onDelete(item)}>
                <Trash2 />
              </Button>
            </div>
            {reconnectWarnings.map((warning) => (
              <div key={`${warning.collectionId}:${warning.message}`} className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <p className="min-w-0 text-xs text-destructive">{warning.message}</p>
                <Button type="button" size="sm" variant="outline" disabled={Boolean(busyKey)} onClick={() => onReconnect(item)}>
                  {busyKey === `reconnect:${item.id}` && <LoaderCircle className="animate-spin" />}
                  {busyKey === `reconnect:${item.id}` ? "Reconnecting…" : "Reconnect"}
                </Button>
              </div>
            ))}
            {item.provider === "google" && (
              <label className="flex items-center gap-3 rounded-md border bg-muted/20 p-3">
                <Checkbox checked={item.calendarEnabled !== false} disabled={Boolean(busyKey)} onCheckedChange={(checked) => onUpdateService(item, checked === true)} />
                <div>
                  <p className="text-sm font-medium">Calendar</p>
                  <p className="text-xs text-muted-foreground">Show and sync calendars from this Google account.</p>
                </div>
              </label>
            )}
            {!isDeveloper && item.provider === "google" && item.calendarEnabled !== false && (
              <div className="grid gap-2">
                {(item.calendars || []).map((calendar) => (
                  <label key={calendar.id} className="flex items-center gap-3 rounded-md border bg-muted/20 p-3">
                    <Checkbox checked={calendar.enabled} onCheckedChange={(checked) => onUpdateCollections([{ id: calendar.id, enabled: checked === true, color: calendar.color }]).catch((error) => setActionNotice(error?.message || String(error)))} />
                    <input className="size-7 cursor-pointer rounded border bg-transparent p-0.5" type="color" value={calendar.color || "#64748b"} onChange={(event) => onUpdateCollections([{ id: calendar.id, enabled: calendar.enabled, color: event.target.value }]).catch((error) => setActionNotice(error?.message || String(error)))} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{calendar.name}</span>
                  </label>
                ))}
                {(item.calendars || []).length === 0 && <EmptyState text="No event calendars discovered." />}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
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
      <FieldSet className="gap-4 rounded-lg border p-4">
        <FieldLegend className="mb-0 px-1">Configured directories</FieldLegend>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{directories.length} configured</p>
          <Button type="button" variant="outline" disabled={isChoosing} onClick={onChooseDirectory}>
            <FolderOpen className="size-4" />
            {isChoosing ? "Choosing..." : "Choose directory"}
          </Button>
        </div>

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
      </FieldSet>

      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
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
      <FieldSet className="gap-4 rounded-lg border p-4">
        <FieldLegend className="mb-0 px-1">Browser for new tabs</FieldLegend>
        <p className="text-xs text-muted-foreground">Detected default: {detectedBrowserBundleId || "Unavailable"}</p>
        <p className="text-xs text-muted-foreground">Effective browser: {effectiveBrowser}</p>

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
      </FieldSet>

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

function TerminalTab({
  settings,
  fonts,
  shellIntegration,
  onChooseDirectory,
  onSave,
  onRefreshShellIntegration,
  onInstallShellIntegration,
  onUninstallShellIntegration,
}) {
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
  const [shortcuts, setShortcuts] = useState(() => normalizeTerminalShortcuts(settings?.shortcuts));
  const [recordingAction, setRecordingAction] = useState(null);
  const [shortcutError, setShortcutError] = useState("");
  const [notice, setNotice] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isShellIntegrationBusy, setIsShellIntegrationBusy] = useState(false);
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
    setShortcuts(normalizeTerminalShortcuts(settings?.shortcuts));
  }, [settings?.newTabDirectory, settings?.newPaneDirectory, settings?.inactivePaneOpacity, settings?.closeTerminalsOnAppExit, settings?.copyOnSelection, settings?.fontFamily, settings?.fontWeight, settings?.fontStyle, settings?.fontSize, settings?.lineHeight, settings?.horizontalSpacing, settings?.scrollbackLines, settings?.shortcuts]);

  useEffect(() => () => setTerminalShortcutRecording(false), []);

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

  function stopShortcutRecording() {
    setRecordingAction(null);
    setTerminalShortcutRecording(false);
  }

  function startShortcutRecording(action) {
    setRecordingAction(action);
    setShortcutError("");
    setNotice("Press the new shortcut. Escape cancels.");
    setTerminalShortcutRecording(true);
  }

  function recordShortcut(event, action) {
    if (recordingAction !== action) return;
    event.preventDefault();
    event.stopPropagation();
    const result = shortcutFromKeyboardEvent(event);
    if (result.status === "cancel") {
      stopShortcutRecording();
      setNotice("Shortcut recording cancelled.");
      return;
    }
    if (result.status === "recording") {
      setNotice("Press a non-modifier key to finish the shortcut.");
      return;
    }
    if (result.status === "error") {
      setShortcutError(result.error);
      return;
    }

    const next = { ...shortcuts, [action]: result.shortcut };
    const conflict = terminalShortcutConflict(next);
    if (conflict) {
      const other = TERMINAL_SHORTCUT_ACTIONS.find((entry) => entry.id === conflict.otherAction)?.label;
      setShortcutError(conflict.reserved
        ? "That shortcut is reserved for new terminal, close terminal, or terminal navigation."
        : `That shortcut is already assigned to ${other || "another terminal action"}.`);
      return;
    }
    setShortcuts(next);
    setShortcutError("");
    stopShortcutRecording();
    setNotice("Shortcut recorded. Save terminal settings to activate it.");
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
      const shortcutConflict = terminalShortcutConflict(shortcuts);
      if (shortcutConflict) {
        throw new Error(shortcutConflict.invalid
          ? "Terminal shortcuts must include Command, Control, Option, or Alt with another key."
          : shortcutConflict.reserved
            ? "Terminal shortcuts cannot replace Cmd/Ctrl+T, Cmd/Ctrl+W, or Cmd/Ctrl+0–9."
            : "Each terminal action must use a unique shortcut.");
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
        shortcuts,
      });
      setNotice("Terminal settings saved.");
    } catch (error) {
      setNotice(error?.message || String(error));
    } finally {
      setIsSaving(false);
    }
  }

  async function refreshShellIntegration() {
    if (!onRefreshShellIntegration) return;
    setIsShellIntegrationBusy(true);
    setNotice("");
    try {
      const status = await onRefreshShellIntegration();
      setNotice(status?.message || "Shift+Enter shell integration status refreshed.");
    } catch (error) {
      setNotice(error?.message || String(error));
    } finally {
      setIsShellIntegrationBusy(false);
    }
  }

  async function installShellIntegration() {
    if (!onInstallShellIntegration) return;
    setIsShellIntegrationBusy(true);
    setNotice("");
    try {
      const status = await onInstallShellIntegration();
      setNotice(status?.message || "Shift+Enter shell integration installed. Open a new terminal session to use it.");
    } catch (error) {
      setNotice(error?.message || String(error));
    } finally {
      setIsShellIntegrationBusy(false);
    }
  }

  async function uninstallShellIntegration() {
    if (!onUninstallShellIntegration) return;
    setIsShellIntegrationBusy(true);
    setNotice("");
    try {
      const status = await onUninstallShellIntegration();
      setNotice(status?.message || "Shift+Enter shell integration removed.");
    } catch (error) {
      setNotice(error?.message || String(error));
    } finally {
      setIsShellIntegrationBusy(false);
    }
  }

  return (
    <div className="grid gap-5">
      <FieldSet className="gap-4 rounded-lg border p-4">
        <FieldLegend className="mb-0 px-1">Typography</FieldLegend>
        <p className="text-xs text-muted-foreground">Saved changes apply to all open terminal panes.</p>

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
      </FieldSet>

      <FieldSet className="gap-4 rounded-lg border p-4">
        <FieldLegend className="mb-0 px-1">Start directories</FieldLegend>
        <p className="text-xs text-muted-foreground">
          These defaults apply when creating new terminal tabs and panes. Existing terminals keep their current directory.
        </p>

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
      </FieldSet>

      <FieldSet className="gap-4 rounded-lg border p-4">
        <FieldLegend className="mb-0 px-1">Terminal behavior</FieldLegend>
        <p className="text-xs text-muted-foreground">
          Control terminal history, focus treatment, clipboard behavior, and restored layouts.
        </p>

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

        <div className="rounded-md border bg-muted/20 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">Shift+Enter multiline in shells</p>
                <Badge variant={terminalShellIntegrationBadgeVariant(shellIntegration)}>
                  {terminalShellIntegrationBadgeText(shellIntegration)}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {terminalShellIntegrationStatusText(shellIntegration)}
              </p>
              <p className="text-xs text-muted-foreground">
                {terminalShellIntegrationDetailText(shellIntegration)}
              </p>
              {shellIntegration?.targetConfigPath && (
                <p className="break-all text-xs text-muted-foreground">
                  Managed file: {shellIntegration.targetConfigPath}
                </p>
              )}
              {shellIntegration?.startupFilePath && (
                <p className="break-all text-xs text-muted-foreground">
                  Startup file: {shellIntegration.startupFilePath}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={isShellIntegrationBusy || !onRefreshShellIntegration}
                onClick={refreshShellIntegration}
              >
                {isShellIntegrationBusy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                Refresh
              </Button>
              {shellIntegration?.installed ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={isShellIntegrationBusy || !shellIntegration?.supported || !onUninstallShellIntegration}
                  onClick={uninstallShellIntegration}
                >
                  {isShellIntegrationBusy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
                  Remove
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={isShellIntegrationBusy || !shellIntegration?.supported || !onInstallShellIntegration}
                  onClick={installShellIntegration}
                >
                  {isShellIntegrationBusy ? <LoaderCircle className="animate-spin" /> : <SquareTerminal />}
                  Install
                </Button>
              )}
            </div>
          </div>
        </div>
      </FieldSet>

      <details
        className="group rounded-lg border"
        onToggle={(event) => {
          if (!event.currentTarget.open && recordingAction !== null) stopShortcutRecording();
        }}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-medium marker:hidden">
          <span className="flex items-center gap-2">
            <Keyboard className="size-4 text-muted-foreground" />
            Terminal shortcuts
          </span>
          <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <FieldSet className="grid gap-3 border-t p-4">
          <FieldLegend className="sr-only">Terminal shortcuts</FieldLegend>
          <p className="text-xs text-muted-foreground">
            Cmd/Ctrl+T, Cmd/Ctrl+W, and Cmd/Ctrl+0–9 remain fixed.
          </p>
          <div className="grid gap-2">
            {TERMINAL_SHORTCUT_ACTIONS.map((action) => (
              <div key={action.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/20 p-3">
                <span className="text-sm">{action.label}</span>
                <div className="flex items-center gap-2">
                  <Kbd className="h-7 px-2 text-sm">{formatShortcut(shortcuts[action.id])}</Kbd>
                  <Button
                    type="button"
                    size="sm"
                    variant={recordingAction === action.id ? "secondary" : "outline"}
                    disabled={isSaving || (recordingAction !== null && recordingAction !== action.id)}
                    onClick={() => startShortcutRecording(action.id)}
                    onKeyDown={(event) => recordShortcut(event, action.id)}
                    onBlur={() => {
                      if (recordingAction === action.id) stopShortcutRecording();
                    }}
                  >
                    <Keyboard />
                    {recordingAction === action.id ? "Press shortcut…" : "Change"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
          {shortcutError && <p className="text-sm text-destructive" role="alert">{shortcutError}</p>}
        </FieldSet>
      </details>

      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={isSaving || recordingAction !== null} onClick={save}>
          {isSaving && <LoaderCircle className="animate-spin" />}
          Save terminal
        </Button>
        <Button type="button" variant="outline" onClick={() => { stopShortcutRecording(); setShortcutError(""); setNewTabDirectory(""); setNewPaneDirectory(""); setInactivePaneOpacity(0.65); setCloseTerminalsOnAppExit(false); setCopyOnSelection(true); setFontFamily("ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"); setFontSize("13"); setLineHeight("100"); setHorizontalSpacing("100"); setScrollbackLines("10000"); setShortcuts({ ...DEFAULT_TERMINAL_SHORTCUTS }); }}>
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
      <FieldSet className="gap-4 rounded-lg border p-4">
        <FieldLegend className="mb-0 px-1">Color theme</FieldLegend>
        <p className="text-xs text-muted-foreground">
          System follows your operating system and updates automatically when it changes.
        </p>
        <Field>
          <FieldLabel>Appearance</FieldLabel>
          <SelectControl
            value={themePreference}
            onValueChange={onThemePreferenceChange}
            options={themeOptions}
            triggerClassName="w-full sm:max-w-xs"
          />
        </Field>
      </FieldSet>
    </div>
  );
}
