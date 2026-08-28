import { useMemo, useState } from "react";
import {
  Check,
  Bot,
  ChevronLeft,
  ExternalLink,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  Plus,
  SquareTerminal,
} from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Modal } from "@/components/common/Modal";
import { Button } from "@/components/ui/button";
import { aiPromptIconFor } from "@/lib/aiPromptIcons";
import { aiSessionSourceOption, enabledAiSessionSourceOptions, preferredAiSessionSource } from "@/lib/aiSessions";
import { aiPromptWorkspaceOptions, compactWorkspacePath } from "@/lib/aiPromptThread";
import { cn } from "@/lib/utils";

export function AiPromptWizard({
  task,
  prompts,
  aiSessionSettings,
  initialPromptId = "",
  localResources,
  homeDirectory,
  onChooseLocalResourceDirectory,
  onSaveLocalResource,
  onInspectBranches,
  onClose,
  onStart,
}) {
  const [step, setStep] = useState(initialPromptId ? "workspace" : "prompt");
  const [selectedPromptId, setSelectedPromptId] = useState(initialPromptId);
  const [selectedPath, setSelectedPath] = useState("");
  const [branchOptions, setBranchOptions] = useState(null);
  const [selectedBranchMode, setSelectedBranchMode] = useState("");
  const initialPrompt = prompts.find((prompt) => prompt.id === initialPromptId);
  const initialSource = preferredAiSessionSource(
    aiSessionSettings,
    initialPrompt?.agentType,
    initialPrompt?.agentOrigin || "desktop",
  );
  const [selectedAgentSource, setSelectedAgentSource] = useState(
    initialSource ? `${initialSource.provider}:${initialSource.origin}` : "",
  );
  const [isAddingDirectory, setIsAddingDirectory] = useState(false);
  const [isInspecting, setIsInspecting] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState("");
  const workspaces = useMemo(() => aiPromptWorkspaceOptions(localResources), [localResources]);
  const selectedPrompt = prompts.find((prompt) => prompt.id === selectedPromptId);
  const enabledAgentSources = useMemo(
    () => enabledAiSessionSourceOptions(aiSessionSettings),
    [aiSessionSettings],
  );
  const isBusy = isAddingDirectory || isInspecting || isStarting;

  function selectPath(path) {
    setSelectedPath(path);
    setBranchOptions(null);
    setSelectedBranchMode("");
    setError("");
  }

  function selectPrompt(promptId) {
    const prompt = prompts.find((candidate) => candidate.id === promptId);
    const source = preferredAiSessionSource(
      aiSessionSettings,
      prompt?.agentType,
      prompt?.agentOrigin || "desktop",
    );
    setSelectedPromptId(promptId);
    setSelectedAgentSource(source ? `${source.provider}:${source.origin}` : "");
  }

  async function inspectBranches(path = selectedPath) {
    if (!selectedPromptId || !path || isBusy) return;
    setIsInspecting(true);
    setError("");
    try {
      const options = await onInspectBranches({
        taskId: task.id,
        path,
      });
      setSelectedPath(path);
      setBranchOptions(options);
      setSelectedBranchMode("");
      setStep("branch");
    } catch (nextError) {
      setError(nextError?.message || String(nextError));
    } finally {
      setIsInspecting(false);
    }
  }

  async function startThread() {
    if (!selectedPromptId || !selectedPath || !selectedBranchMode || !selectedAgentSource || isStarting) return;
    setIsStarting(true);
    setError("");
    try {
      await onStart({
        aiPromptId: selectedPromptId,
        taskId: task.id,
        path: selectedPath,
        branchMode: selectedBranchMode,
        agentType: selectedAgentSource.split(":")[0],
        agentOrigin: selectedAgentSource.split(":")[1],
      });
      onClose();
    } catch (nextError) {
      setError(nextError?.message || String(nextError));
      setIsStarting(false);
    }
  }

  async function addRepositoryAndContinue() {
    if (!task.projectId || isBusy) return;
    setIsAddingDirectory(true);
    setError("");
    try {
      const path = await onChooseLocalResourceDirectory();
      if (!path) return;
      const savedResource = await onSaveLocalResource({
        projectId: task.projectId,
        path,
      });
      selectPath(savedResource.path);
      setIsAddingDirectory(false);
      await inspectBranches(savedResource.path);
    } catch (nextError) {
      setError(nextError?.message || String(nextError));
    } finally {
      setIsAddingDirectory(false);
    }
  }

  return (
    <Modal title="Start AI thread" onClose={() => !isBusy && onClose()}>
      <div className="grid gap-5">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className={cn(step === "prompt" && "text-foreground")}>1. AI Prompt</span>
          <span>→</span>
          <span className={cn(step === "workspace" && "text-foreground")}>2. Repository</span>
          <span>→</span>
          <span className={cn(step === "branch" && "text-foreground")}>3. Branch</span>
          <span>→</span>
          <span className={cn(step === "agent" && "text-foreground")}>4. AI Agent</span>
        </div>

        {step === "prompt" ? (
          <div className="grid gap-3">
            <div>
              <p className="text-sm font-medium">Choose an AI Prompt</p>
              <p className="text-xs text-muted-foreground">The task URL, title, and content will be appended to it.</p>
            </div>
            {prompts.length === 0 ? (
              <EmptyState text="No AI Prompts configured. Add one in Global settings first." />
            ) : (
              <div className="grid gap-2">
                {prompts.map((prompt) => (
                  <ChoiceButton
                    key={prompt.id}
                    selected={selectedPromptId === prompt.id}
                    icon={aiPromptIconFor(prompt.icon)}
                    title={prompt.name}
                    detail={aiSessionSourceOption(prompt.agentType, prompt.agentOrigin || "desktop")?.label || prompt.agentType}
                    onClick={() => selectPrompt(prompt.id)}
                  />
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <Button type="button" disabled={!selectedPromptId} onClick={() => setStep("workspace")}>
                Continue
              </Button>
            </div>
          </div>
        ) : step === "workspace" ? (
          <div className="grid gap-3">
            <div>
              <p className="text-sm font-medium">Choose where to start the thread</p>
              <p className="text-xs text-muted-foreground">
                {selectedPrompt?.name} will use this folder as its working directory.
              </p>
            </div>
            {task.projectId && (
              <Button
                className="justify-start"
                type="button"
                variant="outline"
                disabled={isBusy}
                onClick={addRepositoryAndContinue}
              >
                {isAddingDirectory
                  ? <LoaderCircle className="size-4 animate-spin" />
                  : <FolderOpen className="size-4" />}
                {isAddingDirectory ? "Choosing..." : "Choose other repository"}
              </Button>
            )}
            {workspaces.length === 0 ? (
              <EmptyState
                text={task.projectId
                  ? "No linked repositories yet. Choose a repository above to add one and continue."
                  : "No linked repositories are available. Link one before starting a thread."}
              />
            ) : (
              <div className="grid max-h-80 gap-2 overflow-y-auto pr-1">
                {workspaces.map((workspace) => (
                  <ChoiceButton
                    key={workspace.id}
                    selected={selectedPath === workspace.path}
                    icon={FolderGit2}
                    title={workspace.name}
                    detail={workspace.detail}
                    path={workspace.path}
                    displayPath={compactWorkspacePath(workspace.path, homeDirectory)}
                    disabled={isBusy}
                    onClick={() => selectPath(workspace.path)}
                  />
                ))}
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex flex-wrap justify-between gap-2">
              <Button type="button" variant="outline" disabled={isBusy} onClick={() => setStep("prompt")}>
                <ChevronLeft className="size-4" />
                Back
              </Button>
              <Button type="button" disabled={!selectedPath || isBusy} onClick={() => inspectBranches()}>
                {isInspecting && <LoaderCircle className="size-4 animate-spin" />}
                {isInspecting ? "Inspecting..." : "Continue"}
              </Button>
            </div>
          </div>
        ) : step === "branch" ? (
          <div className="grid gap-3">
            <div>
              <p className="text-sm font-medium">Choose which branch to use</p>
              <p className="text-xs text-muted-foreground">
                The repository will be prepared before {selectedPrompt?.name} opens.
              </p>
            </div>
            {!branchOptions?.isClean && (
              <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                This repository has uncommitted or untracked changes. Current Branch remains available,
                but changing branches requires committing, stashing, or cleaning them first.
              </p>
            )}
            <div className="grid gap-2">
              {branchOptions?.checkoutBranch && (
                <ChoiceButton
                  selected={selectedBranchMode === "checkout"}
                  icon={GitPullRequest}
                  title={`Checkout Branch (${branchOptions.checkoutBranch})`}
                  detail="Use the source branch of this task's open pull or merge request."
                  disabled={isBusy || !branchOptions.isClean}
                  onClick={() => setSelectedBranchMode("checkout")}
                />
              )}
              <ChoiceButton
                selected={selectedBranchMode === "current"}
                icon={GitBranch}
                title={`Current Branch (${branchOptions?.currentBranch || ""})`}
                detail="Start from the branch currently checked out in this repository."
                disabled={isBusy}
                onClick={() => setSelectedBranchMode("current")}
              />
              <ChoiceButton
                selected={selectedBranchMode === "new"}
                icon={Plus}
                title={`New Branch (${branchOptions?.newBranch || ""})`}
                detail="Create a new branch from the current HEAD."
                disabled={isBusy || !branchOptions?.isClean}
                onClick={() => setSelectedBranchMode("new")}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex flex-wrap justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={isBusy}
                onClick={() => {
                  setSelectedBranchMode("");
                  setStep("workspace");
                }}
              >
                <ChevronLeft className="size-4" />
                Back
              </Button>
              <Button type="button" disabled={!selectedBranchMode || isBusy} onClick={() => setStep("agent")}>
                Continue
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            <div>
              <p className="text-sm font-medium">Choose which AI Agent to use</p>
              <p className="text-xs text-muted-foreground">
                The saved default is selected when it is enabled. This choice applies to this run only.
              </p>
            </div>
            {enabledAgentSources.length === 0 ? (
              <EmptyState text="No AI Session sources are enabled. Enable one in Settings before running this AI Prompt." />
            ) : (
              <div className="grid gap-2">
                {enabledAgentSources.map((source) => {
                  const sourceValue = `${source.provider}:${source.origin}`;
                  const isDefault = selectedPrompt?.agentType === source.provider
                    && (selectedPrompt?.agentOrigin || "desktop") === source.origin;
                  return (
                    <ChoiceButton
                      key={source.key}
                      selected={selectedAgentSource === sourceValue}
                      icon={source.origin === "cli" ? SquareTerminal : Bot}
                      title={source.label}
                      detail={isDefault ? `${source.description} Saved default.` : source.description}
                      disabled={isBusy}
                      onClick={() => setSelectedAgentSource(sourceValue)}
                    />
                  );
                })}
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex flex-wrap justify-between gap-2">
              <Button type="button" variant="outline" disabled={isBusy} onClick={() => setStep("branch")}>
                <ChevronLeft className="size-4" />
                Back
              </Button>
              <Button type="button" disabled={!selectedAgentSource || isBusy} onClick={startThread}>
                {isStarting ? <LoaderCircle className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                {isStarting ? "Opening..." : `Open ${selectedPrompt?.name || "AI Prompt"}`}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ChoiceButton({ selected, icon: Icon, title, detail, path, displayPath, disabled = false, onClick }) {
  return (
    <button
      type="button"
      title={path}
      disabled={disabled}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-md border p-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
        selected && "border-primary bg-primary/5",
      )}
      aria-pressed={selected}
      onClick={onClick}
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        {path && <span className="block truncate text-xs text-foreground/80">{displayPath || path}</span>}
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      {selected && <Check className="size-4 shrink-0 text-primary" />}
    </button>
  );
}
