import { Bot } from "lucide-react";

import { BurningTreeIcon } from "@/components/common/BurningTreeIcon";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function AiSessionStateIcon({ state, className }) {
  if (state === "running") {
    return (
      <span role="img" aria-label="Running" className={cn("relative inline-block shrink-0", className)}>
        <span aria-hidden="true" className="running-session-icon__robot absolute inset-0">
          <Bot className="size-full animate-spin text-blue-600 dark:text-blue-400" />
        </span>
        <span aria-hidden="true" className="running-session-icon__tree absolute inset-0">
          <BurningTreeIcon className="size-full" />
        </span>
      </span>
    );
  }

  const presentation = {
    waiting: { label: "Waiting for you", className: "text-amber-600 dark:text-amber-400" },
    done: { label: "Done", className: "text-green-600 dark:text-green-400" },
    idle: { label: "Idle", className: "text-muted-foreground" },
  }[state];

  return (
    <Bot
      role="img"
      aria-label={presentation.label}
      className={cn("shrink-0", className, presentation.className)}
    />
  );
}

export function WaitingForInputBadge() {
  return (
    <Badge
      variant="outline"
      className="shrink-0 border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    >
      Waiting for you
    </Badge>
  );
}
