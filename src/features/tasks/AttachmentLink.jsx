import { providerLabels } from "@/lib/domain";

export function ResourceLink({ label, url, meta }) {
  return (
    <a
      className="block min-w-0 max-w-full overflow-hidden rounded-md border bg-card p-3 text-sm underline-offset-2 hover:bg-accent hover:no-underline"
      href={url}
      target="_blank"
      rel="noreferrer"
    >
      <span className="block min-w-0 max-w-full truncate font-medium capitalize">{label}</span>
      <span className="mt-1 block min-w-0 max-w-full truncate text-xs text-muted-foreground">{meta}</span>
      <span className="mt-1 block min-w-0 max-w-full truncate text-xs text-blue-700">{url}</span>
    </a>
  );
}

export const AttachmentLink = ResourceLink;

export function taskLinkMeta(link) {
  return [
    providerLabels[link.provider] || link.provider,
    link.externalTitle || link.externalId,
    link.externalState,
  ]
    .filter(Boolean)
    .join(" · ");
}
