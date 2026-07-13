function createdAtValue(task) {
  if (Number.isFinite(task?.createdAt)) return task.createdAt;
  if (task?.createdAt == null || task.createdAt === "") return Number.NEGATIVE_INFINITY;

  const parsed = Date.parse(task?.createdAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export function sortDashboardTasks(tasks = []) {
  return [...tasks].sort((left, right) => {
    const leftCreatedAt = createdAtValue(left);
    const rightCreatedAt = createdAtValue(right);
    if (leftCreatedAt !== rightCreatedAt) return rightCreatedAt > leftCreatedAt ? 1 : -1;
    return String(left?.id || "").localeCompare(String(right?.id || ""));
  });
}

export function latestDashboardTasks(tasks = [], limit = 20) {
  return sortDashboardTasks(tasks).slice(0, Math.max(0, limit));
}

export function dashboardTaskProjectName(task, projects = []) {
  if (!task?.projectId) return "Unassigned";
  return projects.find((project) => project.id === task.projectId)?.name || "Unassigned";
}

export function dashboardTaskCreatedAt(task) {
  const value = createdAtValue(task);
  if (!Number.isFinite(value)) return "Creation date unavailable";

  return `Created ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))}`;
}
