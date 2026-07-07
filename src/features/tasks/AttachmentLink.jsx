import { providerLabels } from "@/lib/domain";

export function AttachmentLink({ label, url, meta }) {
  return (
    <a
      className="block rounded-md border bg-card p-3 text-sm underline-offset-2 hover:bg-accent hover:no-underline"
      href={url}
      target="_blank"
      rel="noreferrer"
    >
      <span className="block font-medium capitalize">{label}</span>
      <span className="mt-1 block truncate text-xs text-muted-foreground">{meta}</span>
      <span className="mt-1 block truncate text-xs text-blue-700">{url}</span>
    </a>
  );
}

export function taskLinkMeta(link) {
  return `${providerLabels[link.provider] || link.provider} · ${link.externalId}`;
}
