import { useState } from "react";
import { Link2, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { providerLabels } from "@/lib/domain";
import { parseSmartInput } from "@/lib/smartInputParser";
import { cn } from "@/lib/utils";

export function SmartInput({ onSubmit, large = false }) {
  const [value, setValue] = useState("");
  const parsed = parseSmartInput(value);
  const canSubmit = value.trim().length > 0;

  async function submit(event) {
    event.preventDefault();
    if (!canSubmit) return;
    await onSubmit(value);
    setValue("");
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Textarea
        className={cn(
          "min-h-28 resize-none rounded-lg bg-card px-4 py-3 text-base shadow-sm",
          large && "min-h-40 text-lg",
        )}
        value={value}
        placeholder="Write a task, paste a Trello link, or capture work to route later..."
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ParsedBadge parsed={parsed} />
        <Button type="submit" disabled={!canSubmit}>
          <Plus />
          Add
        </Button>
      </div>
    </form>
  );
}

export function ParsedBadge({ parsed }) {
  const label =
    parsed.kind === "text"
      ? "Plain task"
      : `${providerLabels[parsed.provider] || "Link"} · ${parsed.kind.replaceAll("_", " ")}`;

  return (
    <Badge variant="secondary" className="gap-2">
      <Link2 className="size-3.5" />
      {label}
    </Badge>
  );
}
