export function filterTasksByTitle(tasks = [], query = "") {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return tasks;

  return tasks.filter((task) => (
    (task.title || "").toLocaleLowerCase().includes(normalizedQuery)
  ));
}
