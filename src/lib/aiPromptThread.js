export function aiPromptWorkspaceOptions(localResources = []) {
  const optionsByPath = new Map();

  for (const resource of localResources) {
    const path = resource?.path?.trim();
    if (!path) continue;
    optionsByPath.set(path, {
      id: `repository:${resource.id}`,
      kind: "repository",
      name: resource.name || path,
      path,
      detail: resource.repoUrl || "Linked repository",
    });
  }

  return [...optionsByPath.values()].sort((left, right) => (
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  ));
}
