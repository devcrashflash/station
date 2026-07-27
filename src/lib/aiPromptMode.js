export const AI_PROMPT_MODES = ["agent", "plan"];

export const AI_PROMPT_MODE_OPTIONS = [
  { value: "agent", label: "Agent" },
  { value: "plan", label: "Plan" },
];

export function defaultAiPromptMode(agentType) {
  return agentType === "codex" ? "plan" : "agent";
}

export function normalizeAiPromptMode(agentType, mode) {
  if (agentType !== "codex") return "agent";
  return AI_PROMPT_MODES.includes(mode) ? mode : "plan";
}

export function aiPromptModeLabel(mode) {
  return AI_PROMPT_MODE_OPTIONS.find((option) => option.value === mode)?.label || mode;
}
