import { isTaskDone } from "./taskStatus.js";

export function filterTasksByTitle(tasks = [], query = "") {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return tasks;

  return tasks.filter((task) => (
    (task.title || "").toLocaleLowerCase().includes(normalizedQuery)
  ));
}

export function orderTasksByCompletion(tasks = []) {
  const openTasks = [];
  const doneTasks = [];

  for (const task of tasks) {
    (isTaskDone(task) ? doneTasks : openTasks).push(task);
  }

  return [...openTasks, ...doneTasks];
}

export function preserveTaskOrder(tasks = [], taskIds = []) {
  if (!taskIds.length) return orderTasksByCompletion(tasks);

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const orderedTasks = taskIds.flatMap((taskId) => (
    tasksById.has(taskId) ? [tasksById.get(taskId)] : []
  ));

  if (!orderedTasks.length && tasks.length) return orderTasksByCompletion(tasks);

  const knownTaskIds = new Set(taskIds);
  return [
    ...orderedTasks,
    ...tasks.filter((task) => !knownTaskIds.has(task.id)),
  ];
}
