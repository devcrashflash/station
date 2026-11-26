export function defaultQuickstartRules() {
  return [
    { id: "docker-compose", name: "Docker Compose", enabled: true, paths: ["docker-compose.yml", "compose.yml", "docker-compose.yaml", "compose.yaml"], matchMode: "any", command: "docker compose up", position: "right" },
    { id: "symfony", name: "Symfony", enabled: true, paths: ["public/index.php"], matchMode: "any", command: "symfony serve", position: "right" },
  ];
}

export function validateQuickstartRules(rules) {
  if (!Array.isArray(rules)) throw new Error("Quickstart rules must be a list.");
  const ids = new Set();
  for (const rule of rules) {
    if (!rule.id?.trim() || ids.has(rule.id)) throw new Error("Quickstart rules must have unique IDs.");
    ids.add(rule.id);
    if (!rule.name?.trim() || !rule.command?.trim() || rule.command.includes("\0")) {
      throw new Error("Every Quickstart rule needs a name and a command without null characters.");
    }
    if (!["any", "all"].includes(rule.matchMode) || !["left", "right", "top", "bottom"].includes(rule.position)) {
      throw new Error("Choose a valid Quickstart matching mode and position.");
    }
    if (!Array.isArray(rule.paths) || !rule.paths.length) {
      throw new Error("Every Quickstart rule needs at least one path condition.");
    }
    for (const path of rule.paths) {
      if (typeof path !== "string" || !path.trim() || /[\0\r\n]/.test(path)
        || path.startsWith("~") || path.split(/[\\/]/).includes("..")) {
        throw new Error("Quickstart conditions must use relative paths or absolute directories, without '..' or home expansion.");
      }
      const absolute = path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
      if (absolute) {
        if (!/[\\/]$/.test(path)) {
          throw new Error(`Absolute file checks are not supported. End the directory condition '${path}' with '/'.`);
        }
      } else if (path.startsWith("\\") || path.includes(":")) {
        throw new Error("Quickstart conditions must use relative paths or native absolute directories ending in '/'.");
      }
    }
  }
  return rules;
}

export function canHandleQuickstartShortcut(event, shortcutMatches) {
  // xterm's hidden textarea is the only editable element that should receive this action.
  return shortcutMatches && !event.repeat && !event.defaultPrevented
    && Boolean(event.target?.classList?.contains("xterm-helper-textarea"));
}

export function migrateLegacyComposeQuickstartRules(rules) {
  const updated = defaultQuickstartRules()[0];
  const legacy = { ...updated, paths: ["docker-compose.yml", "compose.yml"] };
  return rules.map((rule) => Object.entries(legacy).every(([key, value]) => JSON.stringify(rule[key]) === JSON.stringify(value))
    ? { ...rule, paths: [...updated.paths] }
    : rule);
}

export function clearQuickstartDismissalOnDirectoryChange(dismissed, context) {
  if (!context || !dismissed[context.tabId] || dismissed[context.tabId].cwd === context.cwd) return dismissed;
  const remaining = { ...dismissed };
  delete remaining[context.tabId];
  return remaining;
}
