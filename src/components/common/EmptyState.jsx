import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@/components/ui/empty";

export function EmptyState({ text }) {
  return (
    <Empty className="min-h-auto rounded-md border bg-muted/30 px-4 py-6">
      <EmptyHeader>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
