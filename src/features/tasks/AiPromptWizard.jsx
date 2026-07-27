import { useMemo, useState } from "react";
import { Check, ChevronLeft, ExternalLink, FolderGit2, LoaderCircle } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Modal } from "@/components/common/Modal";
import { Button } from "@/components/ui/button";
import { aiPromptIconFor } from "@/lib/aiPromptIcons";
import { aiPromptModeLabel } from "@/lib/aiPromptMode";
import { aiPromptWorkspaceOptions, compactWorkspacePath } from "@/lib/aiPromptThread";
import { cn } from "@/lib/utils";

const agentTypeLabels = {
  codex: "Codex",
  claude: "Claude",
};

export function AiPromptWizard({
  task,
  prompts,
  initialPromptId = "",
  localResources,
  homeDirectory,
  onClose,
  onStart,
}) {
  const [step, setStep] = useState(initialPromptId ? "workspace" : "prompt");
  const [selectedPromptId, setSelectedPromptId] = useState(initialPromptId);
  const [selectedPath, setSelectedPath] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState("");
  const workspaces = useMemo(() => aiPromptWorkspaceOptions(localResources), [localResources]);
  const selectedPrompt = prompts.find((prompt) => prompt.id === selectedPromptId);

  async function startThread() {
    if (!selectedPromptId || !selectedPath || isStarting) return;
    setIsStarting(true);
    setError("");
    try {
      await onStart({
        aiPromptId: selectedPromptId,
        taskId: task.id,
        path: selectedPath,
      });
      onClose();
    } catch (nextError) {
      setError(nextError?.message || String(nextError));
      setIsStarting(false);
    }
  }

  return (
    <Modal title="Start AI thread" onClose={() => !isStarting && onClose()}>
      <div className="grid gap-5">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className={cn(step === "prompt" && "text-foreground")}>1. AI Prompt</span>
          <span>→</span>
          <span className={cn(step === "workspace" && "text-foreground")}>2. Repository or directory</span>
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
                    detail={`${agentTypeLabels[prompt.agentType] || prompt.agentType} · ${aiPromptModeLabel(prompt.mode)}`}
                    onClick={() => setSelectedPromptId(prompt.id)}
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
        ) : (
          <div className="grid gap-3">
            <div>
              <p className="text-sm font-medium">Choose where to start the thread</p>
              <p className="text-xs text-muted-foreground">
                {selectedPrompt?.name} will use this folder as its working directory.
              </p>
            </div>
            {workspaces.length === 0 ? (
              <EmptyState text="No linked repositories are available. Link one before starting a thread." />
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
                    onClick={() => setSelectedPath(workspace.path)}
                  />
                ))}
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex flex-wrap justify-between gap-2">
              <Button type="button" variant="outline" disabled={isStarting} onClick={() => setStep("prompt")}>
                <ChevronLeft className="size-4" />
                Back
              </Button>
              <Button type="button" disabled={!selectedPath || isStarting} onClick={startThread}>
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

function ChoiceButton({ selected, icon: Icon, title, detail, path, displayPath, onClick }) {
  return (
    <button
      type="button"
      title={path}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-md border p-3 text-left transition-colors hover:bg-accent",
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
