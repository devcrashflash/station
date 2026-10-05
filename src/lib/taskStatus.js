import { externalLabelStyle } from "./externalLabels.js";
import { isClosedReviewState } from "./reviewSession.js";

export function isProviderBackedTask(task) {
  return (
    (task?.sourceProvider === "trello" && task?.sourceKind === "trello_card") ||
    (task?.sourceProvider === "github" && ["github_issue", "pull_request"].includes(task?.sourceKind)) ||
    (task?.sourceProvider === "gitlab" && ["gitlab_issue", "merge_request"].includes(task?.sourceKind))
  );
}

export function isTaskDone(task) {
  const isReviewRequest =
    (task?.sourceProvider === "github" && task?.sourceKind === "pull_request") ||
    (task?.sourceProvider === "gitlab" && task?.sourceKind === "merge_request");

  if (isReviewRequest) return isClosedReviewState(task?.status);
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
