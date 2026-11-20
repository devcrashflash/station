export function extractJiraIssueUrls(value = "") {
  const tickets = new Map();
  for (const match of String(value).matchAll(/https:\/\/([a-z0-9-]+\.atlassian\.net)\/browse\/([A-Z][A-Z0-9_]*-\d+)(?=[/?#\s)\]>"',.]|$)/gi)) {
    const url = `https://${match[1].toLowerCase()}/browse/${match[2].toUpperCase()}`;
    tickets.set(url, { provider: "jira", externalId: `jira:${url}`, url, title: match[2].toUpperCase() });
  }
  return [...tickets.values()];
}

export function jiraTicketFromActivity(activity) {
  if (activity?.provider !== "jira") return null;
  const reference = extractJiraIssueUrls(activity.targetUrl)[0];
  if (!reference) return null;
  let raw;
  try { raw = JSON.parse(activity.rawJson || "{}"); } catch { raw = {}; }
  const issue = raw.issue || {};
  const project = issue.fields?.project;
  return { ...reference, externalId: issue.id ? `jira:${new URL(reference.url).hostname}:${issue.id}` : reference.externalId, referenceExternalId: reference.externalId, title: issue.fields?.summary || activity.title || reference.title,
    projectExternalId: project?.id ? `${new URL(reference.url).hostname}:${project.id}` : null,
    connectionId: activity.connectionId || null };
}

export function formatJiraLoggedTime(value) {
  const seconds = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const parts = [];
  if (Math.floor(seconds / 3600)) parts.push(`${Math.floor(seconds / 3600)}h`);
  if (Math.floor(seconds % 3600 / 60)) parts.push(`${Math.floor(seconds % 3600 / 60)}m`);
  if (seconds % 60) parts.push(`${seconds % 60}s`);
  return parts.join(" ") || "0m";
}

export function jiraWorklogFromActivity(activity) {
  if (activity?.provider !== "jira" || activity.eventType !== "worklog") return null;
  try {
    const raw = JSON.parse(activity.rawJson || "{}");
    const worklog = raw.event;
    if (!worklog?.id || !Number.isSafeInteger(worklog.timeSpentSeconds) || worklog.timeSpentSeconds < 0) return null;
    const site = new URL(activity.targetUrl).hostname;
    return {
      id: `${site}:worklog:${worklog.id}`,
      seconds: worklog.timeSpentSeconds,
      note: String(raw.worklogNote || "").trim(),
      author: activity.actor || "",
      startedAt: activity.occurredAt,
      updatedAt: Date.parse(String(worklog.updated || "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) || 0,
      fetchedAt: activity.fetchedAt || 0,
      url: activity.targetUrl,
    };
  } catch { return null; }
}

export function deduplicateJiraWorklogActivities(activities = []) {
  const latest = new Map();
  for (const activity of activities) {
    const worklog = jiraWorklogFromActivity(activity);
    if (!worklog) continue;
    const previous = latest.get(worklog.id);
    if (!previous || worklog.updatedAt > previous.worklog.updatedAt
      || (worklog.updatedAt === previous.worklog.updatedAt && worklog.fetchedAt >= previous.worklog.fetchedAt)) {
      latest.set(worklog.id, { activity, worklog });
    }
  }
  const seen = new Set();
  return activities.filter((activity) => {
    const worklog = jiraWorklogFromActivity(activity);
    if (!worklog) return true;
    if (latest.get(worklog.id).activity !== activity || seen.has(worklog.id)) return false;
    seen.add(worklog.id);
    return true;
  });
}
