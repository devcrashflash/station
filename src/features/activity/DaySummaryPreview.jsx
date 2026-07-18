import { CalendarDays, ExternalLink, GitPullRequest, Ticket } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { activityActionClassName } from "@/lib/activity";
import { openExternalUrl } from "@/lib/externalLinks";
import { cn } from "@/lib/utils";

const externalSurfaceClassName = "cursor-pointer transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

export function DaySummaryPreview({ summary }) {
  return (
    <div className="grid min-w-0 gap-7">
      {summary.sections.map((section) => (
        <section className="grid min-w-0 gap-3" key={section.id}>
          <div className="flex min-w-0 items-center gap-2 border-b pb-2">
            <span className={cn("size-2.5 shrink-0 rounded-full", section.isUnknown ? "bg-slate-400" : "bg-blue-500")} />
            <h2 className="min-w-0 break-words text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">{section.name}</h2>
          </div>

          {section.tickets.map((ticket) => (
            <article className="min-w-0 overflow-hidden rounded-lg border bg-card shadow-sm" key={ticket.externalId}>
              <TicketHeader ticket={ticket} />

              <div className="grid gap-4 p-4">
                {ticket.ticketActions.length > 0 && (
                  <SummaryRow label="Ticket" icon={Ticket}>
                    <ActionBadges actions={ticket.ticketActions} />
                  </SummaryRow>
                )}
                {ticket.providers.map((provider) => (
                  <ProviderGroup key={provider.provider} provider={provider} />
                ))}
              </div>
            </article>
          ))}

          {section.unknownProviders.length > 0 && (
            <article className="rounded-lg border border-dashed bg-muted/15 p-4">
              <div className="mb-4">
                <h3 className="font-semibold">Unknown ticket</h3>
                <p className="text-xs text-muted-foreground">Activity mapped to this project without a Trello ticket.</p>
              </div>
              <div className="grid gap-4">
                {section.unknownProviders.map((provider) => (
                  <ProviderGroup key={provider.provider} provider={provider} />
                ))}
              </div>
            </article>
          )}
        </section>
      ))}

      {summary.meetings.length > 0 && (
        <section className="grid gap-3">
          <div className="flex items-center gap-2 border-b pb-2">
            <span className="size-2.5 rounded-full bg-violet-500" />
            <h2 className="text-lg font-semibold tracking-tight">Meetings</h2>
          </div>
          <div className="grid gap-2">
            {summary.meetings.map((meeting) => {
              const Wrapper = meeting.url ? "a" : "div";
              return (
                <Wrapper
                  className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-muted/30"
                  href={meeting.url || undefined}
                  target={meeting.url ? "_blank" : undefined}
                  rel={meeting.url ? "noreferrer" : undefined}
                  key={meeting.id}
                >
                  <div className="rounded-md bg-violet-100 p-2 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                    <CalendarDays className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{meeting.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {meeting.timeLabel}{meeting.calendarName ? ` · ${meeting.calendarName}` : ""}
                    </p>
                  </div>
                  {meeting.url && <ExternalLink className="size-4 text-muted-foreground" />}
                </Wrapper>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function ProviderGroup({ provider }) {
  return (
    <SummaryRow label={provider.label} icon={GitPullRequest} labelClassName={providerLabelClassName(provider.provider)}>
      <div className="grid min-w-0 flex-1 gap-2">
        {provider.items.map((item) => (
          <ProviderItem item={item} providerLabel={provider.label} key={item.key} />
        ))}
      </div>
    </SummaryRow>
  );
}

function TicketHeader({ ticket }) {
  const Wrapper = ticket.url ? "a" : "div";

  return (
    <Wrapper
      className={cn(
        "flex min-w-0 items-start justify-between gap-3 border-b bg-muted/30 px-4 py-3 text-card-foreground",
        ticket.url && externalSurfaceClassName,
      )}
      href={ticket.url || undefined}
      target={ticket.url ? "_blank" : undefined}
      rel={ticket.url ? "noreferrer" : undefined}
      title={ticket.url ? "Open Trello ticket" : undefined}
      onClick={ticket.url ? (event) => {
        event.preventDefault();
        void openExternalUrl(ticket.url);
      } : undefined}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <div className="mt-0.5 rounded-md bg-blue-100 p-1.5 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
          <Ticket className="size-4" />
        </div>
        <div className="min-w-0">
          <h3 className="break-words font-semibold leading-5 [overflow-wrap:anywhere]">{ticket.title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Trello ticket</p>
        </div>
      </div>
      {ticket.url && <ExternalLink className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
    </Wrapper>
  );
}

function ProviderItem({ item, providerLabel }) {
  const Wrapper = item.url ? "a" : "div";

  return (
    <Wrapper
      className={cn(
        "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 overflow-hidden rounded-md border bg-background px-3 py-2.5 text-foreground",
        item.url && externalSurfaceClassName,
      )}
      href={item.url || undefined}
      target={item.url ? "_blank" : undefined}
      rel={item.url ? "noreferrer" : undefined}
      title={item.url ? `Open ${providerLabel} activity` : undefined}
      onClick={item.url ? (event) => {
        event.preventDefault();
        void openExternalUrl(item.url);
      } : undefined}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 max-w-full break-words font-medium [overflow-wrap:anywhere]">{item.title}</span>
          {item.author && <span className="min-w-0 max-w-full break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">@{String(item.author).replace(/^@/, "")}</span>}
        </div>
        {item.actions.length > 0 && <ActionBadges actions={item.actions} className="mt-2" />}
      </div>
      {item.url && <ExternalLink className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
    </Wrapper>
  );
}

function SummaryRow({ label, icon: Icon, labelClassName, children }) {
  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-start">
      <div className={cn("flex items-center gap-1.5 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground", labelClassName)}>
        <Icon className="size-3.5" />
        {label}
      </div>
      {children}
    </div>
  );
}

function ActionBadges({ actions, className }) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {actions.map((action) => (
        <Badge className={activityActionClassName(action)} variant="outline" key={action}>
          {action}
        </Badge>
      ))}
    </div>
  );
}

function providerLabelClassName(provider) {
  if (provider === "gitlab") return "text-orange-700 dark:text-orange-300";
  if (provider === "github") return "text-slate-700 dark:text-slate-300";
  return undefined;
}
