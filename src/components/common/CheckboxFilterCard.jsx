import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export function CheckboxFilterCard({
  label,
  description,
  checked,
  disabled = false,
  ariaLabel,
  onCheckedChange,
}) {
  return (
    <label
      className={cn(
        "flex min-w-0 items-start gap-3 rounded-md border bg-card p-3 text-card-foreground transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-muted/35",
      )}
    >
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={ariaLabel || `${checked ? "Disable" : "Enable"} ${label}`}
      />
      <span className="min-w-0">
        <span className="block min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">
          {label}
        </span>
        {description && (
          <span className="block text-xs text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}
