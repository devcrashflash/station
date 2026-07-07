export const DEFAULT_PROJECT_COLOR = "#2563eb";

export const PROJECT_COLOR_OPTIONS = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#ca8a04",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#475569",
];

const hexColorPattern = /^#[0-9a-f]{6}$/i;

export function normalizeProjectColor(color) {
  const trimmed = color?.trim() || "";
  return hexColorPattern.test(trimmed) ? trimmed.toLowerCase() : DEFAULT_PROJECT_COLOR;
}

export function getProjectInitial(name) {
  return name?.trim().at(0)?.toLocaleUpperCase() || "?";
}
