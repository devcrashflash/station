const CATEGORY_ORDER = ["todos", "tasks", "latest-files", "github", "gitlab", "trello"];

function timestampValue(value) {
  if (Number.isFinite(value)) return value;
  if (value == null || value === "") return Number.NEGATIVE_INFINITY;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function firstTimestamp(...values) {
  for (const value of values) {
    const timestamp = timestampValue(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NEGATIVE_INFINITY;
}

function itemTimestamp(category, item) {
  if (category === "todos") {
    return firstTimestamp(item?.updatedAt, item?.createdAt);
  }
  if (category === "tasks") return timestampValue(item?.createdAt);
  if (category === "latest-files") return timestampValue(item?.modifiedAt);
  return firstTimestamp(
    item?.sortAt,
    item?.reviewRequestedAt,
    item?.updatedAt,
    item?.createdAt,
  );
}

function itemKey(category, item, index) {
  if (category === "latest-files") return `${category}:${item?.path || index}`;
  if (["github", "gitlab", "trello"].includes(category)) {
    return `${category}:${item?.externalId || item?.url || index}`;
  }
  return `${category}:${item?.id || index}`;
}

export function buildAllSmartInboxItems({
  todos = [],
  tasks = [],
  files = [],
  providerItems = {},
} = {}) {
  const itemsByCategory = {
    todos,
    tasks,
    "latest-files": files,
    github: providerItems.github?.items || [],
    gitlab: providerItems.gitlab?.items || [],
    trello: providerItems.trello?.items || [],
  };

  return CATEGORY_ORDER
    .flatMap((category, categoryIndex) => (
      itemsByCategory[category].map((item, sourceIndex) => ({
        category,
        item,
        key: itemKey(category, item, sourceIndex),
        sortAt: itemTimestamp(category, item),
        categoryIndex,
        sourceIndex,
      }))
    ))
    .sort((left, right) => {
      if (left.sortAt !== right.sortAt) return right.sortAt > left.sortAt ? 1 : -1;
      if (left.categoryIndex !== right.categoryIndex) return left.categoryIndex - right.categoryIndex;
      return left.sourceIndex - right.sourceIndex;
    });
}
