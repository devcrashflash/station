import { cn } from "@/lib/utils";

export function SegmentedTabs({
  tabs,
  value,
  onValueChange,
  ariaLabel,
  className,
}) {
  function handleKeyDown(event, index) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabList = event.currentTarget.parentElement;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    onValueChange(tabs[nextIndex].id);
    requestAnimationFrame(() => {
      tabList
        ?.querySelectorAll('[role="tab"]')
        ?.[nextIndex]
        ?.focus();
    });
  }

  return (
    <div
      className={cn("inline-flex w-fit max-w-full overflow-x-auto rounded-md border bg-muted/30 p-1", className)}
      role="tablist"
      aria-label={ariaLabel}
    >
      {tabs.map((tab, index) => {
        const Icon = tab.icon;
        const isActive = value === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-2 rounded-sm px-3 text-sm font-medium text-muted-foreground transition-colors",
              "hover:bg-background hover:text-foreground",
              isActive && "bg-background text-foreground shadow-xs",
            )}
            onClick={() => onValueChange(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {Icon && <Icon className="size-4" />}
            {tab.label}
            {tab.count !== undefined && ` (${tab.count})`}
          </button>
        );
      })}
    </div>
  );
}
