const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeExternalLabelColor(color) {
  const value = String(color || "").trim();
  if (!HEX_COLOR.test(value)) return null;
  if (value.length === 4) {
    return `#${value.slice(1).split("").map((part) => `${part}${part}`).join("")}`.toLowerCase();
  }
  return value.toLowerCase();
}

export function externalLabelForeground(color) {
  const normalized = normalizeExternalLabelColor(color);
  if (!normalized) return null;
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance > 0.58 ? "#111827" : "#ffffff";
}

export function externalLabelStyle(color) {
  const backgroundColor = normalizeExternalLabelColor(color);
  if (!backgroundColor) return undefined;
  return {
    backgroundColor,
    color: externalLabelForeground(backgroundColor),
  };
}
