import test from "node:test";
import assert from "node:assert/strict";
import { jiraWorklogFromActivity, formatJiraLoggedTime, deduplicateJiraWorklogActivities } from "./jira.js";
import { buildDaySummaryModel, daySummaryModelToMarkdown, filterDaySummaryModelBySearch } from "./activitySummary.js";
import { activityActionLabel, activityActionFilterKey, activityEventKindLabel, timelineItemsToCsv } from "./activity.js";
import { filterTimelineItemsBySearch } from "./activitySearch.js";

function worklog(id, seconds = 7200, { site = "studio", connection = "account-a", updated = "2026-11-20T10:00:00.000+0100", note = "Investigated login", fetchedAt = 100 } = {}) {
  return { id: `${connection}-${id}`, provider: "jira", connectionId: connection, eventType: "worklog", externalId: `worklog:${id}`,
    actionLabel: `Logged ${formatJiraLoggedTime(seconds)} on APP-42`, title: "Fix login", actor: "Alex", occurredAt: 1_795_165_200_000, fetchedAt,
    targetUrl: `https://${site}.atlassian.net/browse/APP-42?focusedWorklogId=${id}`,
    rawJson: JSON.stringify({ issue: { id: "100", fields: { summary: "Fix login", project: { id: "20" } } }, event: { id, timeSpentSeconds: seconds, updated }, worklogNote: note }) };
}

test("worklogs display actual hours and minutes independently of Jira's day length", () => {
  assert.equal(formatJiraLoggedTime(90061), "25h 1m 1s");
  assert.equal(formatJiraLoggedTime(5400), "1h 30m");
  assert.equal(formatJiraLoggedTime(0), "0m");
  const entry = jiraWorklogFromActivity(worklog("1"));
  assert.equal(entry.seconds, 7200);
  assert.equal(entry.note, "Investigated login");
  assert.equal(entry.id, "studio.atlassian.net:worklog:1");
  assert.equal(jiraWorklogFromActivity({ ...worklog("bad"), rawJson: "broken" }), null);
});

test("worklogs have their own action filter and retain duration in CSV exports", () => {
  const a = worklog("1");
  assert.equal(activityActionLabel(a), "Logged 2h on APP-42");
  assert.equal(activityActionFilterKey(a), "Logged time");
  assert.equal(activityActionFilterKey(worklog("2", 3600)), "Logged time");
  assert.equal(activityEventKindLabel(a), "Worklog");
  const csv = timelineItemsToCsv([{ type: "activity", value: a }]);
  assert.match(csv, /Logged 2h on APP-42/);
  assert.match(csv, /Investigated login/);
  assert.equal(filterTimelineItemsBySearch([{ type: "activity", value: a }], "investigated").length, 1);
});

test("equal-duration worklogs remain separate entries with a summed hours total", () => {
  const summary = buildDaySummaryModel({ activities: [worklog("1"), worklog("2")] });
  assert.equal(summary.jiraLoggedSeconds, 14400);
  assert.equal(summary.jiraWorklogCount, 2);
  assert.equal(summary.sections[0].tickets[0].worklogs.length, 2);
  assert.deepEqual(summary.sections[0].tickets[0].ticketActions, []);
  const markdown = daySummaryModelToMarkdown(summary);
  assert.match(markdown, /Jira hours logged: 4h/);
  assert.equal(markdown.match(/Jira: logged 2h/g).length, 2);
  assert.match(markdown, /Investigated login/);
});

test("multiple accounts do not double-count the same Jira worklog", () => {
  const a = worklog("1");
  const b = worklog("1", 7200, { connection: "account-b" });
  assert.equal(deduplicateJiraWorklogActivities([a, b]).length, 1);
  const summary = buildDaySummaryModel({ activities: [a, b] });
  assert.equal(summary.jiraLoggedSeconds, 7200);
  assert.equal(summary.jiraWorklogCount, 1);
});

test("edited worklogs prefer the newest Jira version even if a stale account syncs later", () => {
  const stale = worklog("1", 7200, { connection: "account-b", fetchedAt: 999 });
  const edited = worklog("1", 3600, { updated: "2026-11-21T10:00:00.000+0100", fetchedAt: 1, note: "Corrected entry" });
  const summary = buildDaySummaryModel({ activities: [edited, stale] });
  assert.equal(summary.jiraLoggedSeconds, 3600);
  assert.equal(summary.sections[0].tickets[0].worklogs[0].note, "Corrected entry");
});

test("identical worklog IDs on different Jira sites remain distinct", () => {
  const summary = buildDaySummaryModel({ activities: [worklog("1"), worklog("1", 3600, { site: "other" })] });
  assert.equal(summary.jiraLoggedSeconds, 10800);
  assert.equal(summary.jiraWorklogCount, 2);
  assert.equal(summary.sections[0].tickets.length, 2);
});

test("summary search includes worklog notes and recalculates visible totals", () => {
  const summary = buildDaySummaryModel({ activities: [worklog("1"), worklog("2", 3600, { site: "other", note: "Write documentation" })] });
  const filtered = filterDaySummaryModelBySearch(summary, "documentation");
  assert.equal(filtered.jiraLoggedSeconds, 3600);
  assert.equal(filtered.jiraWorklogCount, 1);
  const empty = filterDaySummaryModelBySearch(summary, "not found");
  assert.equal(empty.jiraLoggedSeconds, 0);
  assert.equal(empty.jiraWorklogCount, 0);
});
