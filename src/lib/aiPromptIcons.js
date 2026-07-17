import {
  BookOpen,
  Bug,
  Clock3,
  FlaskConical,
  Hammer,
  ListChecks,
  SearchCheck,
  Sparkles,
  Target,
  Telescope,
} from "lucide-react";

export const aiPromptIconOptions = [
  { value: "target", label: "Goal definition", icon: Target },
  { value: "clock", label: "Estimation", icon: Clock3 },
  { value: "hammer", label: "Implementation", icon: Hammer },
  { value: "review", label: "Review", icon: SearchCheck },
  { value: "testing", label: "Testing", icon: FlaskConical },
  { value: "bug", label: "Debugging", icon: Bug },
  { value: "planning", label: "Planning", icon: ListChecks },
  { value: "documentation", label: "Documentation", icon: BookOpen },
  { value: "research", label: "Research", icon: Telescope },
  { value: "sparkles", label: "General", icon: Sparkles },
];

export const AI_PROMPT_ICON_IDS = aiPromptIconOptions.map((option) => option.value);

export function aiPromptIconFor(value) {
  return aiPromptIconOptions.find((option) => option.value === value)?.icon || Sparkles;
}
