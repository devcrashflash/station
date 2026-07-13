import { ExternalLink, Link2 } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Panel } from "@/components/common/Panel";
import { providerLabels, resourceKinds } from "@/lib/domain";

const resourceKindLabels = new Map(resourceKinds.map((kind) => [kind.value, kind.label]));

export function ResourcesPanel({ resources }) {
  return (
    <Panel title="Connected resources" icon={Link2}>
      <div className="grid min-w-0 max-w-full gap-4 overflow-hidden">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Resources</p>
          <span className="text-xs text-muted-foreground">{resources.length} connected</span>
        </div>

        {resources.length === 0 ? (
          <EmptyState text="No resources connected." />
        ) : (
          <ResourceList resources={resources} />
        )}
      </div>
    </Panel>
  );
}

function ResourceList({ resources }) {
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-2 overflow-hidden">
      {resources.map((resource) => (
        <a
          key={resource.id}
          className="flex min-w-0 w-full max-w-full items-center gap-2 overflow-hidden rounded-md border bg-card p-3 transition-colors hover:bg-accent"
          href={resource.url}
          target="_blank"
          rel="noreferrer"
        >
          <div className="min-w-0 max-w-full flex-1 overflow-hidden">
            <p className="block min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium">
              {resource.name}
            </p>
            <p className="block min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
              {providerLabels[resource.provider] || resource.provider} · {resourceKindLabels.get(resource.kind) || resource.kind}
            </p>
            <p className="block min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-blue-700">
              {resource.url}
            </p>
          </div>
          <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
        </a>
      ))}
    </div>
  );
}
