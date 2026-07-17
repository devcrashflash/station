import test from "node:test";
import assert from "node:assert/strict";

import { api } from "./api.js";
import {
  buildDaySummaryMarkdown,
  extractTrelloCardUrls,
  filterChangedOnlyTrelloTicketActivities,
  filterMoveOnlyTrelloTicketActivities,
  trelloTicketReferencesForActivity,
  trelloTicketUrlsForActivities,
} from "./activitySummary.js";

test("extracts canonical Trello card URLs from descriptions", () => {
  assert.deepEqual(
    extractTrelloCardUrls("See https://trello.com/c/abc123/a-slug?x=1 and https://www.trello.com/c/xyz789/"),
    [
      { externalId: "abc123", url: "https://trello.com/c/abc123" },
      { externalId: "xyz789", url: "https://trello.com/c/xyz789" },
    ],
  );
});

test("extracts ticket relationships from GitLab descriptions and GitHub bodies", () => {
  const gitlab = {
    provider: "gitlab",
    subjectJson: JSON.stringify({ description: "Tracks https://trello.com/c/gitlab-card" }),
  };
  const github = {
    provider: "github",
    eventType: "PullRequestEvent",
    subjectJson: JSON.stringify({ body: "Tracks https://trello.com/c/github-card/a-slug" }),
  };

  assert.deepEqual(trelloTicketReferencesForActivity(gitlab), [
    { externalId: "gitlab-card", url: "https://trello.com/c/gitlab-card" },
  ]);
  assert.deepEqual(trelloTicketReferencesForActivity(github), [
    { externalId: "github-card", url: "https://trello.com/c/github-card" },
  ]);
  assert.deepEqual(trelloTicketUrlsForActivities([gitlab, github]), [
    "https://trello.com/c/gitlab-card",
    "https://trello.com/c/github-card",
  ]);
  assert.deepEqual(trelloTicketReferencesForActivity({
    provider: "github",
    eventType: "IssuesEvent",
    subjectJson: JSON.stringify({ body: "Mentions https://trello.com/c/not-a-pr" }),
  }), []);
});

test("hides only move-only Trello tickets without visible code relationships", () => {
  const trello = (id, actionLabel, rawJson = null) => ({
    id: `${id}:${actionLabel}`,
    provider: "trello",
    actionLabel,
    targetUrl: `https://trello.com/c/${id}`,
    rawJson: rawJson || JSON.stringify({ data: { card: { shortLink: id, name: id } } }),
  });
  const activities = [
    trello("hidden", "Moved: Done"),
    trello("commented", "Moved: Done"),
    trello("commented", "Commented"),
    trello("gitlab-linked", "Moved: Done"),
    trello("github-linked", "Moved: Done"),
    { id: "unknown-card", provider: "trello", actionLabel: "Moved: Done", rawJson: "{bad json" },
    {
      id: "gitlab-related",
      provider: "gitlab",
      subjectJson: JSON.stringify({ description: "https://trello.com/c/gitlab-linked" }),
    },
    {
      id: "github-related",
      provider: "github",
      eventType: "PullRequestEvent",
      subjectJson: JSON.stringify({ body: "https://trello.com/c/github-linked" }),
    },
    { id: "unrelated", provider: "github", subjectJson: JSON.stringify({ body: "No ticket" }) },
  ];

  assert.deepEqual(
    filterMoveOnlyTrelloTicketActivities(activities, true).map((activity) => activity.id),
    activities.filter((activity) => activity.id !== "hidden:Moved: Done").map((activity) => activity.id),
  );
  const withoutRelatedConnections = activities.filter((activity) => (
    activity.provider !== "github" && activity.provider !== "gitlab"
  ));
  assert.deepEqual(
    filterMoveOnlyTrelloTicketActivities(withoutRelatedConnections, true).map((activity) => activity.id),
    ["commented:Moved: Done", "commented:Commented", "unknown-card"],
  );
  assert.deepEqual(filterMoveOnlyTrelloTicketActivities(activities, false), activities);
});

test("hides only changed-only Trello tickets without visible code relationships", () => {
  const trello = (id, actionLabel, rawJson = null) => ({
    id: `${id}:${actionLabel}`,
    provider: "trello",
    actionLabel,
    targetUrl: `https://trello.com/c/${id}`,
    rawJson: rawJson || JSON.stringify({ data: { card: { shortLink: id, name: id } } }),
  });
  const activities = [
    trello("hidden", "Changed"),
    trello("normalized", "Updated"),
    trello("move-only", "Moved: Done"),
    trello("commented", "Changed"),
    trello("commented", "Commented"),
    trello("mixed", "Changed"),
    trello("mixed", "Moved: Done"),
    trello("gitlab-linked", "Changed"),
    trello("github-linked", "Changed"),
    { id: "unknown-card", provider: "trello", actionLabel: "Changed", rawJson: "{bad json" },
    {
      id: "gitlab-related",
      provider: "gitlab",
      subjectJson: JSON.stringify({ description: "https://trello.com/c/gitlab-linked" }),
    },
    {
      id: "github-related",
      provider: "github",
      eventType: "PullRequestEvent",
      subjectJson: JSON.stringify({ body: "https://trello.com/c/github-linked" }),
    },
  ];

  assert.deepEqual(
    filterChangedOnlyTrelloTicketActivities(activities, true).map((activity) => activity.id),
    activities
      .filter((activity) => !["hidden:Changed", "normalized:Updated"].includes(activity.id))
      .map((activity) => activity.id),
  );
  assert.deepEqual(
    filterChangedOnlyTrelloTicketActivities(
      filterMoveOnlyTrelloTicketActivities(activities, true),
      true,
    ).map((activity) => activity.id),
    activities
      .filter((activity) => !["hidden:Changed", "normalized:Updated", "move-only:Moved: Done"].includes(activity.id))
      .map((activity) => activity.id),
  );
  assert.deepEqual(filterChangedOnlyTrelloTicketActivities(activities, false), activities);
});

test("groups GitHub pull requests beneath referenced Trello tickets", () => {
  const markdown = buildDaySummaryMarkdown({
    activities: [{
      id: "github-pr",
      provider: "github",
      actionLabel: "Merged",
      subjectJson: JSON.stringify({
        title: "Ship GitHub feature",
        body: "Tracks https://trello.com/c/github-card",
        html_url: "https://github.com/acme/app/pull/10",
        user: { login: "octocat" },
      }),
    }],
    resolvedTickets: [{
      externalId: "github-card",
      title: "GitHub ticket",
      url: "https://trello.com/c/github-card",
    }],
  });

  assert.match(markdown, /## GitHub ticket/);
  assert.match(markdown, /- GitHub:\n  - \[Ship GitHub feature\].*— @octocat \(merged\)/);
  assert.doesNotMatch(markdown, /## Unknown/);
});

test("groups hydrated unlinked GitLab comments and merges under project Unknown", () => {
  const mergeRequest = {
    id: 2175,
    title: "Fix timeprofile validator",
    description: "No Trello ticket",
    web_url: "https://gitlab.example.com/acme/app/-/merge_requests/2175",
    author: { username: "author" },
  };
  const markdown = buildDaySummaryMarkdown({
    projects: [{ id: "project-a", name: "Project A" }],
    resources: [{
      projectId: "project-a",
      provider: "gitlab",
      kind: "gitlab_repo",
      url: "https://gitlab.example.com/acme/app",
    }],
    activities: [
      {
        id: "comment",
        provider: "gitlab",
        eventType: "DiscussionNote",
        actionLabel: "Commented",
        occurredAt: 1,
        subjectJson: JSON.stringify(mergeRequest),
        targetUrl: `${mergeRequest.web_url}#note_1`,
      },
      {
        id: "merged",
        provider: "gitlab",
        eventType: "MergeRequest",
        actionLabel: "Merged",
        occurredAt: 2,
        subjectJson: JSON.stringify(mergeRequest),
        targetUrl: mergeRequest.web_url,
      },
    ],
  });

  assert.match(markdown, /^# Project A\n\n## Unknown/);
  assert.match(markdown, /\[Fix timeprofile validator\].*\(commented, merged\)/);
  assert.equal((markdown.match(/\[Fix timeprofile validator\]/g) || []).length, 1);
});

test("keeps grouped merge request actions chronological", () => {
  const mergeRequest = {
    id: 8732,
    title: "Add visit state badge to code card",
    web_url: "https://gitlab.example.com/acme/app/-/merge_requests/2178",
    author: { username: "author" },
  };
  const activity = (id, actionLabel, occurredAt) => ({
    id,
    provider: "gitlab",
    eventType: actionLabel === "Approved" ? "MergeRequestApproval" : "MergeRequest",
    actionLabel,
    occurredAt,
    subjectJson: JSON.stringify(mergeRequest),
    targetUrl: mergeRequest.web_url,
  });

  const markdown = buildDaySummaryMarkdown({
    activities: [
      activity("merged", "Merged", 3),
      activity("commented", "Commented", 2),
      activity("deleted", "Deleted", 4),
      activity("approved", "Approved", 1),
    ],
  });

  assert.match(markdown, /\(approved, commented, merged, deleted\)/);
});

test("uses lifecycle order to break grouped action timestamp ties", () => {
  const mergeRequest = {
    id: 41,
    title: "Tied activity",
    web_url: "https://gitlab.example.com/acme/app/-/merge_requests/41",
  };
  const activities = ["Deleted", "Merged", "Approved", "Commented"].map((actionLabel) => ({
    id: actionLabel,
    provider: "gitlab",
    eventType: "MergeRequest",
    actionLabel,
    occurredAt: 1,
    subjectJson: JSON.stringify(mergeRequest),
    targetUrl: mergeRequest.web_url,
  }));

  const markdown = buildDaySummaryMarkdown({ activities });

  assert.match(markdown, /\(commented, approved, merged, deleted\)/);
});

test("groups branch pushes and deletes with their related merge request and ticket", () => {
  const mergeRequest = {
    id: 41,
    iid: 9,
    project_id: 55,
    source_branch: "feature/card-summary",
    title: "Improve card summary",
    description: "Tracks https://trello.com/c/summary-card",
    web_url: "https://gitlab.example.com/acme/app/-/merge_requests/9",
    author: { username: "alex" },
  };
  const gitlabEvent = (id, actionLabel, occurredAt) => ({
    id,
    provider: "gitlab",
    actionLabel,
    occurredAt,
    title: "feature/card-summary",
    rawJson: JSON.stringify({
      project_id: 55,
      action_name: actionLabel.toLowerCase(),
      push_data: { ref: "feature/card-summary", ref_type: "branch" },
    }),
  });

  const markdown = buildDaySummaryMarkdown({
    activities: [
      gitlabEvent("push", "Pushed", 1),
      {
        id: "merge",
        provider: "gitlab",
        eventType: "MergeRequest",
        actionLabel: "Merged",
        occurredAt: 2,
        subjectJson: JSON.stringify(mergeRequest),
      },
      gitlabEvent("delete", "Deleted", 3),
    ],
    resolvedTickets: [{
      externalId: "summary-card",
      title: "Summary ticket",
      url: "https://trello.com/c/summary-card",
    }],
  });

  assert.match(markdown, /## Summary ticket/);
  assert.match(markdown, /\[Improve card summary\]\(https:\/\/gitlab\.example\.com\/acme\/app\/-\/merge_requests\/9\).*\(pushed, merged, deleted\)/);
  assert.doesNotMatch(markdown, /## Unknown/);
  assert.doesNotMatch(markdown, /feature\/card-summary/);
});

test("hides GitLab target-branch pushes emitted by merged merge requests", () => {
  const mergedRequest = ({ id, projectId, sourceBranch, title, author, ticket = null }) => ({
    id: `mr-${id}`,
    provider: "gitlab",
    eventType: "MergeRequest",
    actionLabel: "Merged",
    actor: "alexander",
    occurredAt: id,
    subjectJson: JSON.stringify({
      id,
      project_id: projectId,
      target_project_id: projectId,
      source_branch: sourceBranch,
      target_branch: "main",
      merge_commit_sha: `merge-${id}`,
      state: "merged",
      title,
      description: ticket ? `Tracks https://trello.com/c/${ticket}` : "",
      web_url: `https://gitlab.example.com/acme/project-${projectId}/-/merge_requests/${id}`,
      author: { username: author },
      merged_by: { username: "alexander" },
    }),
  });
  const push = ({ id, projectId, ref = "main", commitTo, title }) => ({
    id,
    provider: "gitlab",
    eventType: "Project",
    actionLabel: "Pushed",
    actor: "alexander",
    occurredAt: id,
    title,
    rawJson: JSON.stringify({
      project_id: projectId,
      project_name: `Acme / ${title}`,
      action_name: "pushed to",
      push_data: { action: "pushed", ref, ref_type: "branch", commit_to: commitTo },
    }),
  });

  const markdown = buildDaySummaryMarkdown({
    activities: [
      mergedRequest({
        id: 573,
        projectId: 102,
        sourceBranch: "enhancement/date-time-range-handling",
        title: "Fix date-time range handling",
        author: "alexander",
      }),
      push({ id: 574, projectId: 102, commitTo: "MERGE-573", title: "Extranet" }),
      mergedRequest({
        id: 284,
        projectId: 101,
        sourceBranch: "update-deps",
        title: "Update deps",
        author: "patrick.gasser",
        ticket: "deps-ticket",
      }),
      push({ id: 285, projectId: 101, commitTo: "merge-284", title: "Int3grate App" }),
      push({ id: 600, projectId: 200, commitTo: "direct-main", title: "Direct Push" }),
    ],
    resolvedTickets: [{ externalId: "deps-ticket", title: "Dependency ticket" }],
  });

  assert.match(markdown, /Fix date-time range handling.*\(merged\)/);
  assert.match(markdown, /## Dependency ticket/);
  assert.match(markdown, /Update deps.*@patrick\.gasser \(merged\)/);
  assert.match(markdown, /Direct Push.*\(pushed: main\)/);
  assert.doesNotMatch(markdown, /Extranet/);
  assert.doesNotMatch(markdown, /Int3grate App/);
});

test("retains GitLab pushes that do not exactly match a merged target", () => {
  const mergeRequest = {
    id: "merged",
    provider: "gitlab",
    eventType: "MergeRequest",
    actionLabel: "Merged",
    subjectJson: JSON.stringify({
      project_id: 55,
      target_project_id: 55,
      source_branch: "feature/exact-match",
      target_branch: "main",
      merge_commit_sha: "merge-sha",
      state: "merged",
      title: "Exact match",
      web_url: "https://gitlab.example.com/acme/app/-/merge_requests/9",
    }),
  };
  const push = (id, projectId, ref, commitTo, projectName) => ({
    id,
    provider: "gitlab",
    eventType: "Project",
    actionLabel: "Pushed",
    title: projectName,
    rawJson: JSON.stringify({
      project_id: projectId,
      project_name: `Acme / ${projectName}`,
      action_name: "pushed to",
      push_data: { action: "pushed", ref, ref_type: "branch", commit_to: commitTo },
    }),
  });
  const projectMismatch = buildDaySummaryMarkdown({
    activities: [mergeRequest, push("project-mismatch", 56, "main", "merge-sha", "Project mismatch")],
  });
  const branchMismatch = buildDaySummaryMarkdown({
    activities: [mergeRequest, push("branch-mismatch", 55, "release", "merge-sha", "Branch mismatch")],
  });
  const shaMismatch = buildDaySummaryMarkdown({
    activities: [mergeRequest, push("sha-mismatch", 55, "main", "other-sha", "SHA mismatch")],
  });

  assert.match(projectMismatch, /Project mismatch.*\(pushed: main\)/);
  assert.match(branchMismatch, /Branch mismatch.*\(pushed: release\)/);
  assert.match(shaMismatch, /SHA mismatch.*\(pushed: main\)/);
});

test("groups GitHub branch pushes with their related pull request", () => {
  const pullRequest = {
    title: "Ship GitHub branch",
    body: "Tracks https://trello.com/c/github-branch",
    html_url: "https://github.com/acme/app/pull/12",
    head: { ref: "feature/github-branch", repo: { full_name: "acme/app" } },
    base: { repo: { full_name: "acme/app" } },
    user: { login: "octocat" },
  };
  const markdown = buildDaySummaryMarkdown({
    activities: [
      {
        id: "github-push",
        provider: "github",
        eventType: "PushEvent",
        actionLabel: "Pushed",
        occurredAt: 1,
        rawJson: JSON.stringify({ repo: { name: "acme/app" }, payload: { ref: "refs/heads/feature/github-branch" } }),
      },
      {
        id: "github-pr",
        provider: "github",
        eventType: "PullRequestEvent",
        actionLabel: "Merged",
        occurredAt: 2,
        subjectJson: JSON.stringify(pullRequest),
      },
    ],
    resolvedTickets: [{ externalId: "github-branch", title: "GitHub branch ticket" }],
  });

  assert.match(markdown, /## GitHub branch ticket/);
  assert.match(markdown, /\[Ship GitHub branch\].*\(pushed, merged\)/);
  assert.doesNotMatch(markdown, /## Unknown/);
});

test("groups unmatched branch activity by project with unique branch-qualified actions", () => {
  const branchActivity = (id, actionLabel, branch, projectId = 55, projectName = "Acme / Int3grate") => ({
    id,
    provider: "gitlab",
    actionLabel,
    occurredAt: id,
    title: "Int3grate",
    targetUrl: "https://gitlab.example.com/acme/int3grate",
    rawJson: JSON.stringify({
      project_id: projectId,
      project_name: projectName,
      push_data: { ref: branch, ref_type: "branch" },
    }),
  });
  const markdown = buildDaySummaryMarkdown({
    activities: [
      branchActivity(1, "Pushed", "feature/first"),
      branchActivity(2, "Pushed", "feature/second"),
      branchActivity(3, "Deleted", "feature/first"),
      branchActivity(4, "Pushed", "feature/first"),
      branchActivity(5, "Pushed", "main", 99, "Acme / Other"),
    ],
  });

  assert.match(markdown, /\[Int3grate\].*\(pushed: feature\/first, pushed: feature\/second, deleted: feature\/first\)/);
  assert.match(markdown, /\[Other\].*\(pushed: main\)/);
  assert.equal((markdown.match(/pushed: feature\/first/g) || []).length, 1);
  assert.equal((markdown.match(/\[Int3grate\]/g) || []).length, 1);
});

test("summarizes newly created branches and tags under their project", () => {
  const createdRef = (id, refType, ref) => ({
    id,
    provider: "gitlab",
    eventType: "Project",
    actionLabel: "Project",
    occurredAt: id,
    actor: "alex",
    title: "Int3grate",
    rawJson: JSON.stringify({
      project_id: 55,
      project_name: "Acme / Int3grate",
      action_name: "pushed new",
      push_data: { action: "created", ref, ref_type: refType },
    }),
  });
  const markdown = buildDaySummaryMarkdown({
    activities: [
      createdRef(1, "branch", "feature/new-summary"),
      createdRef(2, "tag", "prod-20260717"),
    ],
  });

  assert.match(markdown, /Int3grate.*\(created branch: feature\/new-summary, created tag: prod-20260717\)/);
});

test("groups unmatched GitHub ref activity by repository", () => {
  const githubRef = (id, eventType, actionLabel, ref, refType = "branch") => ({
    id,
    provider: "github",
    eventType,
    actionLabel,
    occurredAt: id,
    actor: "octocat",
    title: "Commit title",
    targetUrl: "https://github.com/acme/app",
    rawJson: JSON.stringify({
      repo: { name: "acme/app" },
      payload: { ref, ref_type: refType },
    }),
  });
  const markdown = buildDaySummaryMarkdown({
    activities: [
      githubRef(1, "PushEvent", "Pushed", "refs/heads/main"),
      githubRef(2, "DeleteEvent", "Deleted", "feature/old"),
      githubRef(3, "CreateEvent", "Created", "v1.0.0", "tag"),
    ],
  });

  assert.match(markdown, /\[app\]\(https:\/\/github\.com\/acme\/app\).*— @octocat \(pushed: main, deleted: feature\/old, created tag: v1\.0\.0\)/);
  assert.equal((markdown.match(/\[app\]/g) || []).length, 1);
});

test("ticket resolution failures remain usable in the web fallback", async () => {
  const result = await api.resolveTrelloTickets({ urls: ["https://trello.com/c/abc123"] });

  assert.deepEqual(result.tickets, []);
  assert.match(result.warnings[0], /requires the desktop app/i);
});

test("builds project, ticket, unknown, global unknown, and meeting sections", () => {
  const projects = [
    { id: "project-a", name: "Project A" },
    { id: "project-b", name: "Project B" },
  ];
  const resources = [
    { projectId: "project-a", provider: "trello", kind: "trello_board", externalId: "board-a", connectionId: "trello-1" },
    { projectId: "project-a", provider: "gitlab", kind: "gitlab_repo", url: "https://gitlab.example.com/acme/app" },
    { projectId: "project-b", provider: "github", kind: "github_repo", url: "https://github.com/acme/web" },
  ];
  const mr = {
    id: 41,
    title: "Ship feature",
    description: "Tracks https://trello.com/c/card-one/ship and https://trello.com/c/card-two",
    web_url: "https://gitlab.example.com/acme/app/-/merge_requests/41",
    author: { username: "mr-author" },
  };
  const activities = [
    {
      id: "trello-action",
      provider: "trello",
      connectionId: "trello-1",
      actionLabel: "Moved: Done",
      occurredAt: 1,
      targetUrl: "https://trello.com/c/card-one",
      rawJson: JSON.stringify({ data: { card: { shortLink: "card-one", name: "Ticket One" }, board: { shortLink: "board-a", name: "Board A" }, listBefore: { name: "Doing" }, listAfter: { name: "Done" } } }),
    },
    { id: "mr-comment", provider: "gitlab", eventType: "Note", actionLabel: "Commented", actor: "alex", occurredAt: 2, subjectJson: JSON.stringify(mr), targetUrl: mr.web_url },
    { id: "mr-merge", provider: "gitlab", eventType: "MergeRequest", actionLabel: "Merged", actor: "alex", occurredAt: 3, subjectJson: JSON.stringify(mr), targetUrl: mr.web_url },
    {
      id: "github-merge",
      provider: "github",
      eventType: "PullRequestEvent",
      actionLabel: "Merged",
      actor: "github-author",
      occurredAt: 4,
      title: "Fix web",
      targetUrl: "https://github.com/acme/web/pull/9",
      rawJson: JSON.stringify({ payload: { pull_request: { title: "Fix web", html_url: "https://github.com/acme/web/pull/9", user: { login: "github-author" } } } }),
    },
    { id: "unmapped", provider: "github", actionLabel: "Created", actor: "alex", occurredAt: 5, title: "Other", targetUrl: "https://github.com/other/repo/issues/1" },
  ];

  const markdown = buildDaySummaryMarkdown({
    activities,
    projects,
    resources,
    resolvedTickets: [
      { externalId: "card-one", title: "Ticket One", url: "https://trello.com/c/card-one", boardExternalId: "board-a", connectionId: "trello-1" },
      { externalId: "card-two", title: "Ticket Two", url: "https://trello.com/c/card-two", boardExternalId: "board-a", connectionId: "trello-1" },
    ],
    calendarEvents: [{ title: "Standup", startAt: new Date(2026, 6, 17, 9).getTime(), endAt: new Date(2026, 6, 17, 9, 30).getTime(), joinUrl: "https://meet.example/standup" }],
  });

  assert.match(markdown, /^# Project A/);
  assert.match(markdown, /## Ticket One \(\[here\]\(https:\/\/trello\.com\/c\/card-one\)\)/);
  assert.match(markdown, /- GitLab:\n  - \[Ship feature\].*— @mr-author \(commented, merged\)/);
  assert.match(markdown, /## Ticket Two[\s\S]*\[Ship feature\]/);
  assert.match(markdown, /- Ticket: moved: Doing -> Done/);
  assert.match(markdown, /# Project B[\s\S]*## Unknown[\s\S]*\[Fix web\]/);
  assert.match(markdown, /# Unknown[\s\S]*\[Other\]/);
  assert.match(markdown, /# Meetings[\s\S]*Standup \(\[join\]\(https:\/\/meet\.example\/standup\)\)/);
  assert.equal((markdown.match(/\[Ship feature\]/g) || []).length, 2);
});
