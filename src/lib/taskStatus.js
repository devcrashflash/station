import { externalLabelStyle } from "./externalLabels.js";

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

export function taskStatusBadgeLabel(task) {
  if (!isProviderBackedTask(task) && (!task?.status || task.status === "open")) {
    return "new";
  }

  return task?.status || "new";
}

export function taskStatusBadgeStyle(task) {
  if (task?.sourceProvider !== "trello" || task?.sourceKind !== "trello_card") return undefined;
  return externalLabelStyle(task?.statusColor);
}
