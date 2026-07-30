import { activityActionLabel, isTrelloListMoveActivity } from "./activity.js";
import { calendarEventOpenUrl, calendarEventTimeLabel } from "./calendar.js";

const TRELLO_CARD_URL_PATTERN = /https?:\/\/(?:www\.)?trello\.com\/c\/([A-Za-z0-9_-]+)(?:\/[^\s)\]>"']*)?/gi;

export function extractTrelloCardUrls(value = "") {
  const urls = new Map();
  for (const match of String(value).matchAll(TRELLO_CARD_URL_PATTERN)) {
    const externalId = match[1];
    urls.set(externalId, `https://trello.com/c/${externalId}`);
  }
  return [...urls].map(([externalId, url]) => ({ externalId, url }));
}

export function trelloTicketUrlsForActivities(activities = []) {
  const cachedTicketMetadata = new Map();
  for (const activity of activities) {
    if (activity?.provider !== "trello") continue;
    const ticket = ticketFromTrelloActivity(activity);
    if (!ticket) continue;
    const raw = safeJson(activity.rawJson);
    const cachedTitle = raw?.data?.card?.name || activity.title;
    const current = cachedTicketMetadata.get(ticket.externalId) || { hasTitle: false, hasBoard: false };
    cachedTicketMetadata.set(ticket.externalId, {
      hasTitle: current.hasTitle || Boolean(String(cachedTitle || "").trim()),
      hasBoard: current.hasBoard || Boolean(ticket.boardExternalId || ticket.boardName),
    });
  }

  const urls = new Map();
  for (const activity of activities) {
    for (const ticket of trelloTicketReferencesForActivity(activity)) {
      const cached = cachedTicketMetadata.get(ticket.externalId);
      if (cached?.hasTitle && cached.hasBoard) continue;
      urls.set(ticket.externalId, ticket.url);
    }
  }
  return [...urls.values()];
}

export function trelloTicketReferencesForActivity(activity) {
  const subject = activitySubject(activity);
  if (activity?.provider === "gitlab") {
    return extractTrelloCardUrls(subject?.description || "");
  }
  if (activity?.provider === "github" && isGithubPullRequestSubject(activity, subject)) {
    return extractTrelloCardUrls(subject?.body || "");
  }
  return [];
}

export function trelloTicketExternalIdForActivity(activity) {
  return ticketFromTrelloActivity(activity)?.externalId || null;
}

export function filterMoveOnlyTrelloTicketActivities(activities = [], hideMoveOnlyTickets = false) {
  return filterOnlyTrelloTicketActivities(activities, hideMoveOnlyTickets, isTrelloListMoveActivity);
}

export function filterChangedOnlyTrelloTicketActivities(activities = [], hideChangedOnlyTickets = false) {
  return filterOnlyTrelloTicketActivities(
    activities,
    hideChangedOnlyTickets,
    (activity) => activityActionLabel(activity) === "Changed",
  );
}

function filterOnlyTrelloTicketActivities(activities, enabled, matchesOnlyActivity) {
  if (!enabled) return [...activities];

  const trelloActivitiesByTicket = new Map();
  const relatedTicketIds = new Set();

  for (const activity of activities) {
    if (activity.provider === "trello") {
      const ticketId = trelloTicketExternalIdForActivity(activity);
      if (!ticketId) continue;
      if (!trelloActivitiesByTicket.has(ticketId)) trelloActivitiesByTicket.set(ticketId, []);
      trelloActivitiesByTicket.get(ticketId).push(activity);
      continue;
    }

    for (const reference of trelloTicketReferencesForActivity(activity)) {
      relatedTicketIds.add(reference.externalId);
    }
  }

  const hiddenTicketIds = new Set();
  for (const [ticketId, ticketActivities] of trelloActivitiesByTicket) {
    if (!relatedTicketIds.has(ticketId) && ticketActivities.every(matchesOnlyActivity)) {
      hiddenTicketIds.add(ticketId);
    }
  }

  return activities.filter((activity) => (
    activity.provider !== "trello"
    || !hiddenTicketIds.has(trelloTicketExternalIdForActivity(activity))
  ));
}

export function buildDaySummaryModel({
  activities = [],
  calendarEvents = [],
  projects = [],
  resources = [],
  resolvedTickets = [],
} = {}) {
  const summaryActivities = filterMergeGeneratedGitlabPushes(activities);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const orderedProjectIds = projects.map((project) => project.id);
  const ticketById = new Map(resolvedTickets.map((ticket) => [ticket.externalId, { ...ticket }]));
  const sections = new Map();
  const mergeRequestRelations = mergeRequestRelationsForActivities(summaryActivities);

  const ensureSection = (projectId) => {
    const key = projectId && projectById.has(projectId) ? projectId : "__unknown__";
    if (!sections.has(key)) sections.set(key, { tickets: new Map(), unknown: new Map() });
    return sections.get(key);
  };

  for (const activity of [...summaryActivities].sort(compareActivityTime)) {
    if (activity.provider !== "trello") continue;
    const ticket = ticketFromTrelloActivity(activity);
    if (!ticket) continue;
    ticketById.set(ticket.externalId, mergeTicketMetadata(ticketById.get(ticket.externalId), ticket));
  }

  for (const activity of [...summaryActivities].sort(compareActivityTime)) {
    if (activity.provider === "trello") {
      const ticket = ticketFromTrelloActivity(activity);
      if (!ticket) continue;
      const completeTicket = mergeTicketMetadata(ticketById.get(ticket.externalId), ticket);
      const projectId = projectForTicket(completeTicket, resources);
      const bucket = ensureTicketBucket(ensureSection(projectId), completeTicket);
      addAction(bucket.trelloActions, activity);
      continue;
    }

    const ownSubject = activitySubject(activity);
    const relatedMergeRequest = relatedMergeRequestForActivity(activity, mergeRequestRelations);
    const subject = relatedMergeRequest?.subject || ownSubject;
    const refEvent = codeActivityRefEvent(activity);
    const unmatchedRefEvent = !subject ? refEvent : null;
    const entity = activityEntity(activity, subject, unmatchedRefEvent);
    const summaryLabel = refEvent
      ? (unmatchedRefEvent
          ? `${refEvent.actionLabel}: ${refEvent.ref}`
          : refEvent.actionLabel)
      : null;
    const repositoryProjectId = projectForCodeActivity(activity, subject, resources);
    const ticketRefs = relatedMergeRequest?.ticketRefs || trelloTicketReferencesForActivity(activity);

    if (ticketRefs.length > 0) {
      for (const reference of ticketRefs) {
        const ticket = ticketById.get(reference.externalId) || {
          externalId: reference.externalId,
          title: `Trello ticket ${reference.externalId}`,
          url: reference.url,
        };
        const projectId = projectForTicket(ticket, resources) || repositoryProjectId;
        const bucket = ensureTicketBucket(ensureSection(projectId), ticket);
        addEntityActivity(bucket.entities, entity, activity, summaryLabel);
      }
      continue;
    }

    addEntityActivity(ensureSection(repositoryProjectId).unknown, entity, activity, summaryLabel);
  }

  const sectionOrder = [
    ...orderedProjectIds.filter((projectId) => sections.has(projectId)),
    ...(sections.has("__unknown__") ? ["__unknown__"] : []),
  ];

  const projectSections = [];
  for (const projectId of sectionOrder) {
    const section = sections.get(projectId);
    if (!section || (section.tickets.size === 0 && section.unknown.size === 0)) continue;
    projectSections.push({
      id: projectId,
      name: projectId === "__unknown__" ? "Unknown" : projectById.get(projectId)?.name || "Unknown",
      isUnknown: projectId === "__unknown__",
      tickets: [...section.tickets.values()].map((ticket) => ({
        externalId: ticket.externalId,
        title: ticket.title || `Trello ticket ${ticket.externalId}`,
        url: ticket.url || `https://trello.com/c/${ticket.externalId}`,
        ticketActions: ticket.trelloActions.map((action) => action.label),
        providers: groupEntitiesByProvider(ticket.entities),
      })),
      unknownProviders: groupEntitiesByProvider(section.unknown),
    });
  }

  return {
    sections: projectSections,
    meetings: [...calendarEvents].sort(compareCalendarTime).map((event) => ({
      id: event.id || event.uid || `${event.startAt}:${event.title}`,
      title: event.title || event.uid || "Meeting",
      timeLabel: calendarEventTimeLabel(event),
      url: calendarEventOpenUrl(event),
      calendarName: event.calendarName || null,
    })),
  };
}

export function filterDaySummaryModelBySearch(summary, query = "") {
  const normalizedQuery = String(query).trim().toLocaleLowerCase();
  if (!normalizedQuery || !summary) return summary;

  const sections = summary.sections.flatMap((section) => {
    if (summaryValuesMatch(normalizedQuery, [section.name])) return [section];

    const tickets = section.tickets.flatMap((ticket) => {
      if (summaryValuesMatch(normalizedQuery, [ticket.title, ...ticket.ticketActions])) return [ticket];

      const providers = filterSummaryProviders(ticket.providers, normalizedQuery);
      return providers.length > 0 ? [{ ...ticket, providers }] : [];
    });
    const unknownProviders = filterSummaryProviders(section.unknownProviders, normalizedQuery);

    return tickets.length > 0 || unknownProviders.length > 0
      ? [{ ...section, tickets, unknownProviders }]
      : [];
  });
  const meetings = summaryValuesMatch(normalizedQuery, ["Meetings"])
    ? summary.meetings
    : summary.meetings.filter((meeting) => summaryValuesMatch(normalizedQuery, [
        meeting.title,
        meeting.calendarName,
        meeting.timeLabel,
      ]));

  return { ...summary, sections, meetings };
}

function filterSummaryProviders(providers, query) {
  return providers.flatMap((provider) => {
    if (summaryValuesMatch(query, [provider.label])) return [provider];

    const items = provider.items.filter((item) => summaryValuesMatch(query, [
      item.title,
      item.author,
      ...item.actions,
    ]));
    return items.length > 0 ? [{ ...provider, items }] : [];
  });
}

function summaryValuesMatch(query, values) {
  return values.some((value) => String(value || "").toLocaleLowerCase().includes(query));
}

function filterMergeGeneratedGitlabPushes(activities) {
  const mergedTargets = new Set();

  for (const activity of activities) {
    if (activity?.provider !== "gitlab") continue;
    const subject = activitySubject(activity);
    if (!isMergeRequestSubject(activity, subject) || String(subject?.state || "").toLowerCase() !== "merged") {
      continue;
    }

    const projectId = subject.target_project_id ?? subject.project_id;
    const targetBranch = normalizeBranch(subject.target_branch);
    const mergeCommitSha = normalizeCommitSha(subject.merge_commit_sha);
    if (projectId == null || !targetBranch || !mergeCommitSha) continue;
    mergedTargets.add(gitlabMergeTargetKey(projectId, targetBranch, mergeCommitSha));
  }

  if (mergedTargets.size === 0) return [...activities];
  return activities.filter((activity) => {
    if (activity?.provider !== "gitlab") return true;
    const raw = safeJson(activity.rawJson);
    const refEvent = codeActivityRefEvent(activity);
    if (refEvent?.actionLabel !== "Pushed" || refEvent.refType !== "branch") return true;

    const projectId = raw?.project_id;
    const commitTo = normalizeCommitSha(raw?.push_data?.commit_to);
    if (projectId == null || !commitTo) return true;
    return !mergedTargets.has(gitlabMergeTargetKey(projectId, refEvent.ref, commitTo));
  });
}

function gitlabMergeTargetKey(projectId, targetBranch, commitSha) {
  return `${String(projectId)}:${targetBranch}:${commitSha}`;
}

function normalizeCommitSha(value) {
  return String(value || "").trim().toLowerCase() || null;
}

export function buildDaySummaryMarkdown(input = {}) {
  return daySummaryModelToMarkdown(buildDaySummaryModel(input));
}

export function daySummaryModelToMarkdown(summary) {
  const output = [];

  for (const section of summary.sections) {
    output.push(`# ${markdownText(section.name)}`, "");
    for (const ticket of section.tickets) {
      output.push(`## ${markdownText(ticket.title)} ([here](${ticket.url}))`, "");
      if (ticket.ticketActions.length > 0) {
        output.push(`- Ticket: ${ticket.ticketActions.map(markdownText).join(", ")}`);
      }
      output.push(...renderProviderGroups(ticket.providers));
      output.push("");
    }
    if (section.unknownProviders.length > 0) {
      output.push("## Unknown", "", ...renderProviderGroups(section.unknownProviders), "");
    }
  }

  if (summary.meetings.length > 0) {
    output.push("# Meetings", "");
    for (const meeting of summary.meetings) {
      const label = `${markdownText(meeting.timeLabel)} ${markdownText(meeting.title)}`;
      output.push(`- ${label}${meeting.url ? ` ([join](${meeting.url}))` : ""}`);
    }
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function ensureTicketBucket(section, ticket) {
  if (!section.tickets.has(ticket.externalId)) {
    section.tickets.set(ticket.externalId, { ...ticket, entities: new Map(), trelloActions: [] });
  } else {
    Object.assign(section.tickets.get(ticket.externalId), ticket);
  }
  return section.tickets.get(ticket.externalId);
}

function addEntityActivity(entities, entity, activity, label = null) {
  if (!entities.has(entity.key)) entities.set(entity.key, { ...entity, actions: [] });
  addAction(entities.get(entity.key).actions, activity, label);
}

function addAction(actions, activity, overrideLabel = null) {
  const rawLabel = overrideLabel || summaryActionLabel(activity);
  const label = rawLabel ? `${rawLabel[0].toLocaleLowerCase()}${rawLabel.slice(1)}` : "activity";
  if (!actions.some((action) => action.label === label)) {
    actions.push({ label, occurredAt: activity.occurredAt || 0 });
    actions.sort(compareSummaryAction);
  }
}

const SUMMARY_ACTION_TIE_ORDER = new Map([
  ["commented", 0],
  ["approved", 1],
  ["merged", 2],
  ["deleted", 3],
]);

function compareSummaryAction(left, right) {
  const timeDelta = left.occurredAt - right.occurredAt;
  if (timeDelta !== 0) return timeDelta;
  const rankDelta = (SUMMARY_ACTION_TIE_ORDER.get(left.label) ?? Number.MAX_SAFE_INTEGER)
    - (SUMMARY_ACTION_TIE_ORDER.get(right.label) ?? Number.MAX_SAFE_INTEGER);
  return rankDelta || left.label.localeCompare(right.label);
}

function summaryActionLabel(activity) {
  const label = activityActionLabel(activity);
  if (activity.provider !== "trello" || !label.toLowerCase().startsWith("moved")) return label;
  const raw = safeJson(activity.rawJson);
  const before = raw?.data?.listBefore?.name;
  const after = raw?.data?.listAfter?.name || raw?.data?.list?.name;
  return before && after ? `Moved: ${before} -> ${after}` : label;
}

function groupEntitiesByProvider(entities) {
  const providers = new Map();
  for (const entity of entities.values()) {
    if (!providers.has(entity.provider)) {
      providers.set(entity.provider, {
        provider: entity.provider,
        label: providerLabel(entity.provider),
        items: [],
      });
    }
    providers.get(entity.provider).items.push({
      key: entity.key,
      title: entity.title || "Activity",
      url: entity.url,
      author: entity.author,
      actions: entity.actions.map((action) => action.label),
    });
  }
  return [...providers.values()].sort((left, right) => providerOrder(left.provider) - providerOrder(right.provider));
}

function renderProviderGroups(providers) {
  const lines = [];
  for (const provider of providers) {
    lines.push(`- ${provider.label}:`);
    for (const entity of provider.items) {
      const title = markdownText(entity.title);
      const linkedTitle = entity.url ? `[${title}](${entity.url})` : title;
      const author = entity.author ? ` — ${formatAuthor(entity.author)}` : "";
      const actions = entity.actions.length > 0
        ? ` (${entity.actions.map(markdownText).join(", ")})`
        : "";
      lines.push(`  - ${linkedTitle}${author}${actions}`);
    }
  }
  return lines;
}

function activityEntity(activity, subject, unmatchedRefEvent = null) {
  const url = subject?.web_url || subject?.html_url || activity.targetUrl || null;
  const subjectAuthor = subject?.author?.username || subject?.author?.login || subject?.user?.login || null;
  const isGithubReview = activity.provider === "github"
    && String(activity.eventType || "").toLowerCase().includes("pullrequestreview");
  const author = isGithubReview ? activity.actor || subjectAuthor : subjectAuthor || activity.actor || null;
  if (unmatchedRefEvent) {
    const repository = codeActivityRepository(activity, null);
    const projectName = codeActivityProjectName(activity, unmatchedRefEvent.ref);
    return {
      key: `${activity.provider}:${repository || `project:${projectName || "unknown"}`}`,
      provider: activity.provider,
      title: projectName || repository || activity.title || "Project",
      url,
      author,
    };
  }
  return {
    key: url || `${activity.provider}:${activity.externalId || activity.id}`,
    provider: activity.provider,
    title: subject?.title || activity.title || activity.externalId,
    url,
    author,
  };
}

function mergeRequestRelationsForActivities(activities) {
  return activities.flatMap((activity) => {
    if (activity?.provider !== "gitlab" && activity?.provider !== "github") return [];
    const subject = activitySubject(activity);
    if (!isMergeRequestSubject(activity, subject)) return [];
    const branch = mergeRequestBranch(subject, activity.provider);
    if (!branch) return [];
    return [{
      provider: activity.provider,
      branch,
      repository: codeActivityRepository(activity, subject),
      subject,
      ticketRefs: trelloTicketReferencesForActivity({ ...activity, subjectJson: subject }),
      occurredAt: activity.occurredAt || 0,
    }];
  });
}

function relatedMergeRequestForActivity(activity, relations) {
  const refEvent = codeActivityRefEvent(activity);
  if (!refEvent || refEvent.refType !== "branch") return null;
  const branch = refEvent.ref;
  const repository = codeActivityRepository(activity, activitySubject(activity));
  const matches = relations.filter((relation) => (
    relation.provider === activity.provider
    && relation.branch === branch
    && (!repository || !relation.repository || relation.repository === repository)
  ));
  matches.sort((left, right) => (
    Math.abs((activity.occurredAt || 0) - left.occurredAt)
    - Math.abs((activity.occurredAt || 0) - right.occurredAt)
  ));
  return matches[0] || null;
}

function isMergeRequestSubject(activity, subject) {
  if (!subject) return false;
  if (activity.provider === "github") return isGithubPullRequestSubject(activity, subject);
  const url = subject.web_url || activity.targetUrl || "";
  return Boolean(subject.source_branch)
    || /\/merge_requests\/\d+/i.test(url)
    || String(activity.eventType || "").toLowerCase().includes("mergerequest");
}

function codeActivityRefEvent(activity) {
  if (activity?.provider !== "gitlab" && activity?.provider !== "github") return null;
  const raw = safeJson(activity.rawJson);
  const refType = String(raw?.payload?.ref_type || raw?.push_data?.ref_type || "branch").toLowerCase();
  if (refType !== "branch" && refType !== "tag") return null;
  const ref = normalizeRef(raw?.payload?.ref || raw?.push_data?.ref, refType);
  if (!ref) return null;

  const eventType = String(activity.eventType || "").toLowerCase();
  const rawAction = String(
    raw?.action_name
    || raw?.push_data?.action
    || raw?.payload?.action
    || activity.actionLabel
    || "",
  ).toLowerCase();
  let actionLabel = null;
  if (eventType === "createevent" || rawAction.includes("pushed new") || rawAction.includes("create")) {
    actionLabel = refType === "tag" ? "Created tag" : "Created branch";
  } else if (eventType === "deleteevent" || /delete|remove|destroy/.test(rawAction)) {
    actionLabel = "Deleted";
  } else if (eventType === "pushevent" || rawAction.includes("push")) {
    actionLabel = "Pushed";
  }
  return actionLabel ? { actionLabel, ref, refType } : null;
}

function mergeRequestBranch(subject, provider) {
  return normalizeBranch(provider === "github" ? subject?.head?.ref : subject?.source_branch);
}

function codeActivityBranch(activity) {
  const refEvent = codeActivityRefEvent(activity);
  return refEvent?.refType === "branch" ? refEvent.ref : null;
}

function normalizeBranch(value) {
  return String(value || "").replace(/^refs\/heads\//, "").trim() || null;
}

function normalizeRef(value, refType) {
  const prefix = refType === "tag" ? /^refs\/tags\// : /^refs\/heads\//;
  return String(value || "").replace(prefix, "").trim() || null;
}

function codeActivityRepository(activity, subject) {
  const raw = safeJson(activity.rawJson);
  if (activity.provider === "github") {
    const name = subject?.base?.repo?.full_name
      || subject?.head?.repo?.full_name
      || raw?.repo?.name;
    return name ? String(name).toLowerCase() : repositoryIdentity(subject?.html_url || activity.targetUrl, "github");
  }
  const projectId = subject?.project_id || raw?.project_id;
  if (projectId != null) return `project:${projectId}`;
  const path = raw?.project?.path_with_namespace;
  return path ? String(path).toLowerCase() : repositoryIdentity(subject?.web_url || activity.targetUrl, "gitlab");
}

function codeActivityProjectName(activity, branch) {
  const raw = safeJson(activity.rawJson);
  if (activity.provider === "github") {
    return String(raw?.repo?.name || "").split("/").filter(Boolean).at(-1) || null;
  }
  const projectName = raw?.project_name || raw?.project?.name;
  if (projectName) return String(projectName).split(" / ").at(-1).trim();
  const pathName = String(raw?.project?.path_with_namespace || "").split("/").filter(Boolean).at(-1);
  if (pathName) return pathName;
  return activity.title && activity.title !== branch ? activity.title : null;
}

function providerLabel(provider) {
  return { gitlab: "GitLab", github: "GitHub" }[provider] || provider || "Activity";
}

function providerOrder(provider) {
  return { gitlab: 0, github: 1 }[provider] ?? 10;
}

function activitySubject(activity) {
  const subject = safeJson(activity.subjectJson);
  if (activity.provider === "github") {
    const raw = safeJson(activity.rawJson);
    return githubPullRequestSubject(activity, subject, raw)
      || subject
      || raw?.payload?.pull_request
      || raw?.payload?.issue
      || null;
  }
  if (subject) return subject;
  if (activity.provider === "gitlab" && String(activity.eventType || "").toLowerCase().includes("mergerequest")) {
    return safeJson(activity.rawJson);
  }
  return null;
}

function githubPullRequestSubject(activity, subject, raw) {
  const eventType = String(activity?.eventType || "").toLowerCase();
  const rawSubject = raw?.payload?.pull_request || raw?.payload?.issue || null;
  const candidate = subject || rawSubject;
  const isPullRequest = eventType.includes("pullrequest")
    || Boolean(candidate?.pull_request)
    || Boolean(raw?.payload?.issue?.pull_request)
    || /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(activity?.targetUrl || "");
  if (!isPullRequest) return null;

  const identity = githubPullRequestIdentity(candidate, raw, activity?.targetUrl);
  if (!identity) return candidate;
  const { repository, number } = identity;
  const htmlUrl = candidate?.html_url || `https://github.com/${repository}/pull/${number}`;
  const title = candidate?.title || `${repository} PR #${number}`;
  return { ...(candidate || {}), title, html_url: htmlUrl };
}

function githubPullRequestIdentity(subject, raw, targetUrl) {
  const urls = [
    subject?.html_url,
    subject?.url,
    subject?.pull_request?.html_url,
    subject?.pull_request?.url,
    raw?.payload?.comment?.pull_request_url,
    raw?.payload?.comment?._links?.pull_request?.href,
    raw?.payload?.review?.pull_request_url,
    raw?.payload?.review?._links?.pull_request?.href,
    targetUrl,
  ];
  for (const url of urls) {
    const identity = githubPullRequestIdentityFromUrl(url);
    if (identity) return identity;
  }

  const repository = raw?.repo?.name
    || subject?.base?.repo?.full_name
    || subject?.head?.repo?.full_name;
  const number = subject?.number || raw?.payload?.number || raw?.payload?.pull_request?.number;
  return repository && number ? { repository, number: String(number) } : null;
}

function githubPullRequestIdentityFromUrl(value) {
  const url = String(value || "");
  const webMatch = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
  if (webMatch) return { repository: webMatch[1], number: webMatch[2] };
  const apiMatch = url.match(/api\.github\.com\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)/i);
  return apiMatch ? { repository: apiMatch[1], number: apiMatch[2] } : null;
}

function isGithubPullRequestSubject(activity, subject) {
  const eventType = String(activity?.eventType || "").toLowerCase();
  const url = subject?.html_url || activity?.targetUrl || "";
  return eventType.includes("pullrequest")
    || Boolean(subject?.pull_request)
    || /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(url);
}

function ticketFromTrelloActivity(activity) {
  const raw = safeJson(activity.rawJson);
  const externalId = raw?.data?.card?.shortLink || extractTrelloCardUrls(activity.targetUrl)[0]?.externalId;
  if (!externalId) return null;
  return {
    externalId,
    title: raw?.data?.card?.name || activity.title || `Trello ticket ${externalId}`,
    url: `https://trello.com/c/${externalId}`,
    boardExternalId: raw?.data?.board?.shortLink || raw?.data?.board?.id || null,
    boardName: raw?.data?.board?.name || null,
    connectionId: activity.connectionId || null,
  };
}

function projectForTicket(ticket, resources) {
  return resources.find((resource) => {
    if (resource.provider !== "trello" || resource.kind !== "trello_board") return false;
    const identities = [resource.externalId, boardIdentityFromUrl(resource.url)].filter(Boolean);
    return identities.includes(ticket.boardExternalId) || (ticket.boardName && resource.name === ticket.boardName);
  })?.projectId || null;
}

function projectForCodeActivity(activity, subject, resources) {
  const url = subject?.web_url || subject?.html_url || activity.targetUrl;
  const repository = repositoryIdentity(url, activity.provider);
  if (!repository) return null;
  const expectedKind = activity.provider === "gitlab" ? "gitlab_repo" : activity.provider === "github" ? "github_repo" : null;
  return resources.find((resource) => (
    resource.provider === activity.provider
    && resource.kind === expectedKind
    && repositoryIdentity(resource.url || resource.externalId, activity.provider) === repository
  ))?.projectId || null;
}

function repositoryIdentity(value, provider) {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const marker = provider === "gitlab" ? parts.indexOf("-") : -1;
    const repoParts = provider === "gitlab"
      ? (marker >= 0 ? parts.slice(0, marker) : parts)
      : parts.slice(0, 2);
    if (repoParts.length < 2) return null;
    repoParts[repoParts.length - 1] = repoParts.at(-1).replace(/\.git$/, "");
    return `${url.host.toLowerCase()}/${repoParts.join("/").toLowerCase()}`;
  } catch {
    return String(value).replace(/^https?:\/\//, "").replace(/\.git\/?$/, "").replace(/\/$/, "").toLowerCase();
  }
}

function boardIdentityFromUrl(value) {
  return String(value || "").match(/trello\.com\/b\/([^/?#]+)/i)?.[1] || null;
}

function safeJson(value) {
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

function mergeTicketMetadata(base = {}, next = {}) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (value != null && value !== "") merged[key] = value;
  }
  return merged;
}

function formatAuthor(value) {
  const author = markdownText(value);
  return author.startsWith("@") ? author : `@${author}`;
}

function markdownText(value) {
  return String(value ?? "").replace(/([\\[\]])/g, "\\$1").replace(/[\r\n]+/g, " ").trim();
}

function compareActivityTime(left, right) {
  return (left.occurredAt || 0) - (right.occurredAt || 0) || String(left.id || "").localeCompare(String(right.id || ""));
}

function compareCalendarTime(left, right) {
  return Number(Boolean(right.allDay)) - Number(Boolean(left.allDay)) || (left.startAt || 0) - (right.startAt || 0);
}
