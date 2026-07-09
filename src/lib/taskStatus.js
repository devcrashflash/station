export function isProviderBackedTask(task) {
  return (
    (task?.sourceProvider === "trello" && task?.sourceKind === "trello_card") ||
    (task?.sourceProvider === "github" && ["github_issue", "pull_request"].includes(task?.sourceKind)) ||
    (task?.sourceProvider === "gitlab" && ["gitlab_issue", "merge_request"].includes(task?.sourceKind))
  );
}

export function isTaskDone(task) {
  return !isProviderBackedTask(task) && task?.status === "done";
}
