export function reviewRequestInput(item) {
  return item?.url?.trim() || "";
}

export function reviewRequestSubtitle(item) {
  const parts = [
    item?.repoPath,
    item?.number ? requestNumberLabel(item.provider, item.number) : null,
    item?.connectionName,
    reviewRequestDateLabel(item),
  ];
  return parts.filter(Boolean).join(" · ");
}

function requestNumberLabel(provider, number) {
  return provider === "gitlab" ? `!${number}` : `#${number}`;
}

function reviewRequestDateLabel(item) {
  const timestamp = item?.sortAt || item?.reviewRequestedAt || item?.updatedAt || item?.createdAt;
  if (!timestamp) return "";

  const label = {
    review_requested: "Review requested",
    updated: "Updated",
    created: "Created",
  }[item?.sortSource] || "Updated";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";

  return `${label} ${date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })}, ${date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}
