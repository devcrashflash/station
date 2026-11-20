import test from "node:test";
import assert from "node:assert/strict";
import { parseSmartInput } from "./smartInputParser.js";
import { extractJiraIssueUrls, jiraTicketFromActivity } from "./jira.js";
import { api, selectBestConnection, validateConnectionForTest } from "./api.js";
import { isProviderBackedTask, isTaskDone } from "./taskStatus.js";
import { latestDashboardTasks } from "./dashboardTasks.js";
import { buildDaySummaryModel, jiraTicketUrlsForActivities, daySummaryModelToMarkdown } from "./activitySummary.js";
import { ACTIVITY_SYNC_PROVIDERS, timelineItemsToCsv } from "./activity.js";
import { buildAllSmartInboxItems } from "./smartInboxAll.js";

const site = "https://studio.atlassian.net";
const connection = { id: "jira-a", provider: "jira", baseUrl: site, token: "read-only", jira: { email: "a@example.com", tokenMode: "scoped" } };
function activity(host = "studio", overrides = {}) {
  return { id: `activity-${host}`, provider: "jira", connectionId: "jira-a", eventType: "changed", actionLabel: "Changed status: Done", title: "Ship it", targetUrl: `https://${host}.atlassian.net/browse/APP-42`, occurredAt: 100,
    rawJson: JSON.stringify({ issue: { id: "100", key: "APP-42", fields: { summary: "Ship it", project: { id: "20", key: "APP", name: "Application" } } } }), ...overrides };
}

test("Jira issue URLs retain site identity and normalize issue keys", () => {
  const parsed = parseSmartInput(`${site}/browse/app-42?focusedCommentId=5`);
  assert.equal(parsed.kind, "jira_issue");
  assert.equal(parsed.externalId, "studio.atlassian.net:APP-42");
  assert.equal(parsed.provider, "jira");
  assert.notEqual(parsed.externalId, parseSmartInput("https://other.atlassian.net/browse/APP-42").externalId);
  for (const url of ["https://atlassian.net.evil.test/browse/APP-42", "https://jira.example.org/browse/APP-42", "APP-42", "http://studio.atlassian.net/browse/APP-42"]) assert.notEqual(parseSmartInput(url).provider, "jira");
});

test("Jira project links support Cloud project and project-config URLs", () => {
  for (const path of ["/jira/software/projects/APP/boards/1", "/jira/software/c/projects/APP/boards/1", "/jira/core/projects/APP/board", "/plugins/servlet/project-config/APP", "/projects/APP"]) {
    const parsed = parseSmartInput(site + path);
    assert.equal(parsed.kind, "jira_project");
    assert.equal(parsed.externalId, "studio.atlassian.net:APP");
  }
});

test("Jira account selection requires exact enabled site and explicit choice for ambiguity", () => {
  const parsed = parseSmartInput(`${site}/browse/APP-42`);
  const second = { ...connection, id: "jira-b" };
  const other = { ...connection, id: "other", baseUrl: "https://other.atlassian.net" };
  assert.equal(selectBestConnection([connection, other], ["other"], parsed), null);
  assert.equal(selectBestConnection([connection, second], [connection.id, second.id], parsed), null);
  assert.equal(selectBestConnection([connection, second], [connection.id, second.id], { ...parsed, connectionId: second.id }).id, second.id);
  assert.equal(selectBestConnection([connection, second], [connection.id], { ...parsed, connectionId: second.id }), null);
});

test("Jira read-only credentials validate without requiring write access", () => {
  assert.equal(validateConnectionForTest(connection), "");
  assert.equal(validateConnectionForTest({ ...connection, jira: { email: "a@example.com", tokenMode: "unscoped" } }), "");
  assert.match(validateConnectionForTest({ ...connection, jira: { tokenMode: "scoped" } }), /email/);
  assert.match(validateConnectionForTest({ ...connection, baseUrl: `${site}/rest/api/3` }), /site URL/);
});

test("Jira completion uses category rather than a localized workflow status name", () => {
  const done = { id: "done", sourceProvider: "jira", sourceKind: "jira_issue", status: "Erledigt", statusCategory: "done", createdAt: 100 };
  const open = { ...done, id: "open", status: "Done", statusCategory: "indeterminate" };
  assert.equal(isProviderBackedTask(done), true);
  assert.equal(isTaskDone(done), true);
  assert.equal(isTaskDone(open), false);
  assert.deepEqual(latestDashboardTasks([done, open]).map((t) => t.id), ["open"]);
});

test("Jira references require complete URLs and distinguish identical keys across sites", () => {
  const refs = extractJiraIssueUrls(`APP-42 ${site}/browse/APP-42?x=1 ${site}/browse/APP-42 https://other.atlassian.net/browse/APP-42.`);
  assert.equal(refs.length, 2);
  assert.notEqual(refs[0].externalId, refs[1].externalId);
  assert.equal(extractJiraIssueUrls("APP-42 https://fake.atlassian.net.evil/browse/APP-42").length, 0);
  assert.equal(jiraTicketFromActivity(activity()).projectExternalId, "studio.atlassian.net:20");
});

test("Jira activities and related pull requests share a project ticket summary", () => {
  const jira = activity();
  const pr = { id: "pr", provider: "github", eventType: "PullRequestEvent", actionLabel: "Opened", title: "Implement it", occurredAt: 200, targetUrl: "https://github.com/org/repo/pull/3", subjectJson: JSON.stringify({ number: 3, title: "Implement it", html_url: "https://github.com/org/repo/pull/3", body: `Fixes ${site}/browse/APP-42` }) };
  const summary = buildDaySummaryModel({ activities: [jira, pr, activity("other")], projects: [{ id: "station", name: "Station" }], resources: [{ provider: "jira", kind: "jira_project", externalId: "studio.atlassian.net:20", projectId: "station" }] });
  assert.equal(summary.sections.length, 2);
  const section = summary.sections.find((s) => s.id === "station");
  assert.equal(section.tickets.length, 1);
  assert.equal(section.tickets[0].providers[0].provider, "github");
  assert.deepEqual(section.tickets[0].ticketActions, ["changed status: Done"]);
  assert.match(daySummaryModelToMarkdown(summary), /Ship it/);
  assert.deepEqual(jiraTicketUrlsForActivities([jira, pr]), []);
  assert.deepEqual(jiraTicketUrlsForActivities([pr]), [`${site}/browse/APP-42`]);
});

test("Jira participates in activity refresh, CSV exports and the combined Smart Inbox", () => {
  assert.equal(ACTIVITY_SYNC_PROVIDERS.has("jira"), true);
  assert.match(timelineItemsToCsv([{ type: "activity", value: activity() }]), /Jira/);
  const items = buildAllSmartInboxItems({ providerItems: { jira: { items: [{ externalId: "studio.atlassian.net:100", title: "Ship it", sortAt: 100 }] } } });
  assert.equal(items[0].category, "jira");
});

test("browser preview refuses remote Jira creation explicitly", async () => {
  await assert.rejects(api.listJiraIssueTypes({}), /desktop app/);
  await assert.rejects(api.convertTaskToJiraTicket({}), /desktop app/);
});


test("Jira summaries retain immutable issue identity after a key change", () => {
  const old = activity();
  const renamed = activity("studio", { id: "renamed", targetUrl: `${site}/browse/NEW-7`, occurredAt: 200 });
  const summary = buildDaySummaryModel({ activities: [old, renamed] });
  assert.equal(summary.sections[0].tickets.length, 1);
  assert.equal(summary.sections[0].tickets[0].externalId, "jira:studio.atlassian.net:100");
});
