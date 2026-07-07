import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PROJECT_COLOR_OPTIONS,
  normalizeProjectColor,
} from "@/lib/projectAvatar";
import { cn } from "@/lib/utils";

export function ProjectColorPicker({ value, onChange }) {
  const normalizedValue = normalizeProjectColor(value);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PROJECT_COLOR_OPTIONS.map((color) => {
        const selected = normalizedValue === color;

        return (
          <Button
            key={color}
            className={cn(
              "size-8 rounded-md border p-0 shadow-sm",
              selected && "ring-2 ring-ring ring-offset-2",
            )}
            style={{ backgroundColor: color }}
            size="icon-sm"
            variant="ghost"
            type="button"
            title={color}
            onClick={() => onChange(color)}
          >
            {selected && <Check className="size-4 text-white" />}
          </Button>
        );
      })}
      <Input
        className="h-8 w-12 cursor-pointer p-1"
        type="color"
        value={normalizedValue}
        title="Custom project color"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
