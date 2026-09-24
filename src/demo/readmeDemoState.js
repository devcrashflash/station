// README capture fixture
//
// Start `pnpm dev`, then open http://localhost:1420/?demo=readme at 1440x900.
// The fixture is loaded only by the development build and replaces browser storage
// on each demo-page refresh so captures stay deterministic and contain no user data.

const STORAGE_KEY = "devcrashflash-station-state";
const THEME_STORAGE_KEY = "dcf-theme-preference-v1";

function at(day, hours, minutes = 0) {
  const timestamp = new Date(day);
  timestamp.setHours(hours, minutes, 0, 0);
  return timestamp.getTime();
}

function localDate(day) {
  const year = day.getFullYear();
  const month = String(day.getMonth() + 1).padStart(2, "0");
  const date = String(day.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}

export function createReadmeDemoState(day = new Date()) {
  const date = localDate(day);
  const githubConnection = "connection_github_demo";
  const gitlabConnection = "connection_gitlab_demo";
  const trelloConnection = "connection_trello_demo";

  return {
    projects: [
      {
        id: "project_launchpad",
        name: "Launchpad",
        icon: "Rocket",
        color: "#7c3aed",
        createdAt: at(day, 8, 0),
        updatedAt: at(day, 11, 20),
      },
      {
        id: "project_horizon",
        name: "Horizon",
        icon: "Telescope",
        color: "#0891b2",
        createdAt: at(day, 8, 5),
        updatedAt: at(day, 10, 40),
      },
    ],
    connections: [
      { id: githubConnection, name: "GitHub Demo", provider: "github", baseUrl: "https://github.com", createdAt: at(day, 8), updatedAt: at(day, 8) },
      { id: gitlabConnection, name: "GitLab Demo", provider: "gitlab", baseUrl: "https://gitlab.example.com", createdAt: at(day, 8), updatedAt: at(day, 8) },
      { id: trelloConnection, name: "Trello Demo", provider: "trello", baseUrl: "https://api.trello.com", createdAt: at(day, 8), updatedAt: at(day, 8) },
    ],
    projectConnections: {
      project_launchpad: [githubConnection, trelloConnection],
      project_horizon: [gitlabConnection],
    },
    resources: [
      { id: "resource_orbit", projectId: "project_launchpad", provider: "github", kind: "github_repo", externalId: "github.com/launchpad-labs/orbit", url: "https://github.com/launchpad-labs/orbit", name: "launchpad-labs/orbit", iconUrl: null, connectionId: githubConnection },
      { id: "resource_board", projectId: "project_launchpad", provider: "trello", kind: "trello_board", externalId: "launch-board", url: "https://trello.com/b/launch-board", name: "Launch roadmap", iconUrl: null, connectionId: trelloConnection },
      { id: "resource_console", projectId: "project_horizon", provider: "gitlab", kind: "gitlab_repo", externalId: "gitlab.example.com/horizon/console", url: "https://gitlab.example.com/horizon/console", name: "horizon/console", iconUrl: null, connectionId: gitlabConnection },
    ],
    localResources: [
      { id: "local_orbit", projectId: "project_launchpad", provider: "github", repoUrl: "https://github.com/launchpad-labs/orbit", path: "/Users/demo/Projects/orbit", name: "orbit", createdAt: at(day, 8, 10), updatedAt: at(day, 8, 10) },
    ],
    tasks: [
      {
        id: "task_review_checkout",
        projectId: "project_launchpad",
        title: "Review streamlined checkout flow",
        body: "## Goal\n\nReview the new checkout flow before the release candidate is cut.\n\n- Confirm keyboard navigation\n- Check the loading and empty states\n- Leave inline feedback for anything blocking launch",
        status: "open",
        sourceUrl: "https://github.com/launchpad-labs/orbit/pull/482",
        createdAt: at(day, 11, 12),
        updatedAt: at(day, 11, 22),
      },
      {
        id: "task_release_notes",
        projectId: "project_launchpad",
        title: "Draft launch-day release notes",
        body: "Summarize the workflow improvements and include the new keyboard shortcuts.",
        status: "open",
        sourceUrl: null,
        createdAt: at(day, 10, 35),
        updatedAt: at(day, 10, 35),
      },
      {
        id: "task_observability",
        projectId: "project_horizon",
        title: "Add latency budget dashboard",
        body: "Track p50, p95, and p99 latency for the ingest pipeline.",
        status: "open",
        sourceUrl: "https://gitlab.example.com/horizon/console/-/issues/91",
        createdAt: at(day, 9, 45),
        updatedAt: at(day, 10, 5),
      },
      {
        id: "task_onboarding",
        projectId: "project_launchpad",
        title: "Polish first-run onboarding",
        body: "Improve project creation guidance and empty states.",
        status: "done",
        sourceUrl: null,
        createdAt: at(day, 8, 25),
        updatedAt: at(day, 9, 5),
      },
    ],
    taskLinks: [
      {
        taskId: "task_review_checkout",
        provider: "github",
        kind: "pull_request",
        externalId: "launchpad-labs/orbit#482",
        url: "https://github.com/launchpad-labs/orbit/pull/482",
        connectionId: githubConnection,
        externalTitle: "Streamline checkout and confirmation",
        externalBody: "Reduces checkout friction and adds accessible progress feedback.",
        externalState: "open",
        fetchedAt: at(day, 11, 21),
        files: [],
        comments: [
          { id: "comment_1", kind: "comment", author: "Maya Chen", body: "The keyboard flow is ready for a final pass.", createdAt: at(day, 11, 2), updatedAt: at(day, 11, 2), url: "https://github.com/launchpad-labs/orbit/pull/482#issuecomment-demo" },
        ],
        labels: [
          { name: "ready for review", color: "#0e8a16" },
          { name: "release", color: "#7c3aed" },
        ],
      },
      { taskId: "task_observability", provider: "gitlab", kind: "gitlab_issue", externalId: "horizon/console#91", url: "https://gitlab.example.com/horizon/console/-/issues/91", connectionId: gitlabConnection, externalTitle: "Add latency budget dashboard", externalBody: null, externalState: "opened", fetchedAt: at(day, 10), files: [], comments: [], labels: [{ name: "observability", color: "#0891b2" }] },
    ],
    taskRelations: [
      { id: "relation_release", sourceTaskId: "task_review_checkout", targetTaskId: "task_release_notes", relationType: "blocks", createdAt: at(day, 11, 18), updatedAt: at(day, 11, 18) },
    ],
    smartInboxTodos: [
      {
        id: "todo_pr_507",
        kind: "text",
        title: "https://github.com/launchpad-labs/orbit/pull/507",
        rawText: "https://github.com/launchpad-labs/orbit/pull/507",
        filePath: null,
        fileName: null,
        mimeType: null,
        fileMissing: false,
        createdAt: at(day, 11, 26),
        updatedAt: at(day, 11, 26),
      },
      {
        id: "todo_release_checklist",
        kind: "text",
        title: "Turn the release checklist into launch tasks",
        rawText: "Turn the release checklist into launch tasks\nCoordinate owners before tomorrow's go/no-go meeting.",
        filePath: null,
        fileName: null,
        mimeType: null,
        fileMissing: false,
        createdAt: at(day, 10, 48),
        updatedAt: at(day, 10, 48),
      },
    ],
    smartInboxProviderItems: [
      { provider: "github", connectionId: githubConnection, connectionName: "GitHub Demo", sourceId: "launchpad-labs/orbit", sourceName: "launchpad-labs/orbit", externalId: "launchpad-labs/orbit#482", number: 482, title: "Streamline checkout and confirmation", url: "https://github.com/launchpad-labs/orbit/pull/482", repoPath: "launchpad-labs/orbit", contextPath: "launchpad-labs/orbit", contextDetail: "Maya Chen requested your review", sortSource: "review_requested", sortAt: at(day, 11, 24), reviewRequestedAt: at(day, 11, 24), updatedAt: at(day, 11, 20) },
      { provider: "gitlab", connectionId: gitlabConnection, connectionName: "GitLab Demo", sourceId: "horizon/console", sourceName: "horizon/console", externalId: "horizon/console!118", number: 118, title: "Add trace sampling controls", url: "https://gitlab.example.com/horizon/console/-/merge_requests/118", repoPath: "horizon/console", contextPath: "horizon/console", contextDetail: "Review requested", sortSource: "updated", sortAt: at(day, 10, 52), updatedAt: at(day, 10, 52) },
      { provider: "trello", connectionId: trelloConnection, connectionName: "Trello Demo", sourceId: "launch-roadmap", sourceName: "Launch roadmap", externalId: "card-launch-copy", number: null, title: "Finalize launch announcement copy", url: "https://trello.com/c/demoLaunch", contextPath: "Launch roadmap", contextDetail: "Doing", sortSource: "updated", sortAt: at(day, 9, 55), updatedAt: at(day, 9, 55) },
    ],
    smartInboxProviderSources: [],
    pullRequests: [],
    reviewCommentDrafts: [],
    aiPrompts: [
      { id: "prompt_review", name: "Review implementation", agentType: "codex", agentOrigin: "desktop", icon: "search-code", promptText: "Review this task implementation and call out correctness, UX, and test gaps." },
      { id: "prompt_plan", name: "Plan next steps", agentType: "claude", agentOrigin: "cli", icon: "list-checks", promptText: "Create a focused implementation plan for this task." },
    ],
    directories: [],
    activities: [
      { id: "activity_pr", provider: "github", connectionId: githubConnection, connectionName: "GitHub Demo", eventType: "PullRequestReviewEvent", actionLabel: "Reviewed", actor: "Maya Chen", title: "Streamline checkout and confirmation", externalId: "launchpad-labs/orbit#482", targetUrl: "https://github.com/launchpad-labs/orbit/pull/482", subjectJson: JSON.stringify({ html_url: "https://github.com/launchpad-labs/orbit/pull/482" }), rawJson: "{}", occurredAt: at(day, 9, 20) },
      { id: "activity_card", provider: "trello", connectionId: trelloConnection, connectionName: "Trello Demo", eventType: "updateCard", actionLabel: "Moved: Ready for launch", actor: "Jordan Lee", title: "Finalize launch announcement copy", externalId: "demoLaunch", targetUrl: "https://trello.com/c/demoLaunch", rawJson: JSON.stringify({ data: { old: { idList: "doing" }, listBefore: { name: "Doing" }, listAfter: { name: "Ready for launch" }, card: { name: "Finalize launch announcement copy", shortLink: "demoLaunch" } } }), occurredAt: at(day, 10, 15) },
      { id: "activity_push", provider: "gitlab", connectionId: gitlabConnection, connectionName: "GitLab Demo", eventType: "Push Hook", actionLabel: "Pushed", actor: "Avery Patel", title: "Add trace sampling controls", externalId: "horizon/console!118", targetUrl: "https://gitlab.example.com/horizon/console/-/merge_requests/118", rawJson: "{}", occurredAt: at(day, 11, 5) },
    ],
    activitySyncRuns: [
      { connectionId: githubConnection, connectionName: "GitHub Demo", provider: "github", date, status: "success", warning: null, syncedAt: at(day, 11, 28) },
      { connectionId: gitlabConnection, connectionName: "GitLab Demo", provider: "gitlab", date, status: "success", warning: null, syncedAt: at(day, 11, 28) },
      { connectionId: trelloConnection, connectionName: "Trello Demo", provider: "trello", date, status: "success", warning: null, syncedAt: at(day, 11, 28) },
    ],
    calendarAccounts: [
      { id: "calendar_demo", provider: "caldav", authType: "basic", name: "Launchpad Calendar", serverUrl: "https://calendar.example.com", username: "demo@example.com", hasCredential: false, calendarEnabled: true, calendars: [{ id: "calendar_launchpad", name: "Launchpad", color: "#7c3aed", enabled: true }], createdAt: at(day, 8), updatedAt: at(day, 8) },
    ],
    calendarEvents: [
      { id: "event_standup", accountId: "calendar_demo", collectionId: "calendar_launchpad", calendarName: "Launchpad", calendarColor: "#7c3aed", title: "Launch readiness stand-up", startAt: at(day, 9, 30), endAt: at(day, 10), allDay: false, location: "Studio · Room Orbit", joinUrl: "https://meet.example.com/launch-readiness", eventUrl: "https://calendar.example.com/events/launch-readiness", organizer: "Maya Chen" },
      { id: "event_demo", accountId: "calendar_demo", collectionId: "calendar_launchpad", calendarName: "Launchpad", calendarColor: "#0891b2", title: "Checkout flow demo", startAt: at(day, 14), endAt: at(day, 14, 45), allDay: false, location: "", joinUrl: "https://meet.example.com/checkout-demo", eventUrl: "https://calendar.example.com/events/checkout-demo", organizer: "Jordan Lee" },
    ],
    calendarSyncRuns: [
      { accountId: "calendar_demo", accountName: "Launchpad Calendar", collectionId: "calendar_launchpad", collectionName: "Launchpad", provider: "caldav", date, status: "success", warning: null, syncedAt: at(day, 11, 28) },
    ],
    browserSettings: { detectedBrowserBundleId: null, browserBundleId: null },
    commandSettings: { reviewEnabled: true },
    aiSessionSettings: { codexEnabled: true, claudeEnabled: true },
    aiSessionArchives: [],
    terminalSettings: { profileDirectory: "/Users/demo/Projects", inactivePaneOpacity: 0.65, closeTerminalsOnAppExit: false, copyOnSelection: true, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontFace: null, fontWeight: 400, fontStyle: "normal", fontSize: 13, lineHeight: 100, horizontalSpacing: 100, scrollbackLines: 10000, shortcuts: {} },
  };
}

export function seedReadmeDemoState(storage = window.localStorage, day = new Date()) {
  const state = createReadmeDemoState(day);
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
  storage.setItem(THEME_STORAGE_KEY, "light");
  return state;
}
