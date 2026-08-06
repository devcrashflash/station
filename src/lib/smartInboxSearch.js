function normalizedSearchText(values) {
  return values
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLocaleLowerCase();
}

function taskProjectName(task, projects) {
  if (!task?.projectId) return "Unassigned";
  return projects.find((project) => project.id === task.projectId)?.name || "Unassigned";
}

function itemSearchText(tab, item, projects) {
  if (tab === "todos") {
    return normalizedSearchText([
      item.title,
      item.rawText,
      item.fileName,
      item.filePath,
    ]);
  }

  if (tab === "tasks") {
    return normalizedSearchText([
      item.title,
      taskProjectName(item, projects),
    ]);
  }

  if (tab === "latest-files") {
    return normalizedSearchText([
      item.name,
      item.directoryName,
      item.relativePath,
      item.path,
    ]);
  }

  return normalizedSearchText([
    item.title,
    item.contextPath,
    item.repoPath,
    item.contextDetail,
    item.number,
    item.number ? `${tab === "gitlab" ? "!" : "#"}${item.number}` : null,
    item.connectionName,
  ]);
}

export function filterSmartInboxItems(tab, items = [], query = "", projects = []) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return items;

  return items.filter((item) => (
    itemSearchText(tab, item, projects).includes(normalizedQuery)
  ));
}

export function filterAllSmartInboxItems(items = [], query = "", projects = []) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return items;

  return items.filter(({ category, item }) => (
    itemSearchText(category, item, projects).includes(normalizedQuery)
  ));
}
