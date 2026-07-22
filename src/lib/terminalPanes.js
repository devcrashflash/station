export const TERMINAL_WORD_SEPARATORS = " ()[]{}',\"`|";

export function clampSplitRatio(ratio) {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(0.9, Math.max(0.1, ratio));
}

export function terminalFontZoomDelta(event, platform = globalThis.navigator?.platform || "") {
  if (event.type && event.type !== "keydown") return null;
  if (event.altKey) return null;
  const mac = platform.toLowerCase().startsWith("mac");
  const primaryModifier = mac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!primaryModifier) return null;

  const increase = (event.key === "+" && (event.code !== "NumpadAdd" || !event.shiftKey))
    || (event.key === "=" && !event.shiftKey)
    || (event.code === "NumpadAdd" && !event.shiftKey);
  if (increase) return 1;

  const decrease = (event.key === "-" || event.code === "NumpadSubtract") && !event.shiftKey;
  return decrease ? -1 : null;
}

export function terminalFontSizeWithZoom(fontSize, zoomOffset) {
  return Math.min(32, Math.max(1, fontSize + zoomOffset));
}

export function nextTerminalFontZoomOffset(fontSize, zoomOffset, delta) {
  const currentSize = terminalFontSizeWithZoom(fontSize, zoomOffset);
  if (delta < 0 && currentSize === 1) return 0;
  return terminalFontSizeWithZoom(currentSize, delta) - fontSize;
}

export function isTerminalClearShortcut(event, platform = globalThis.navigator?.platform || "") {
  return platform.toLowerCase().startsWith("mac")
    && event.type === "keydown"
    && event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && event.key.toLowerCase() === "k";
}

export function isTerminalSearchShortcut(event, platform = globalThis.navigator?.platform || "") {
  if (event.type && event.type !== "keydown") return false;
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return false;
  return platform.toLowerCase().startsWith("mac")
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export function copyableTerminalSelection(copyOnSelection, selection, searchOpen = false) {
  return copyOnSelection && !searchOpen && typeof selection === "string" && selection.length > 0
    ? selection
    : null;
}

export function paneIds(node) {
  if (!node) return [];
  if (node.type === "pane") return [node.paneId];
  if (node.type !== "split") return [];
  return [...paneIds(node.first), ...paneIds(node.second)];
}

export function flattenPaneLayout(node, ratioOverrides = {}, bounds = { left: 0, top: 0, width: 1, height: 1 }) {
  if (!node) return { panes: [], splits: [] };
  if (node.type === "pane") return { panes: [{ pane: node, ...bounds }], splits: [] };
  if (node.type !== "split") return { panes: [], splits: [] };

  const ratio = clampSplitRatio(ratioOverrides[node.splitId] ?? node.ratio);
  const firstBounds = node.axis === "columns"
    ? { ...bounds, width: bounds.width * ratio }
    : { ...bounds, height: bounds.height * ratio };
  const secondBounds = node.axis === "columns"
    ? { ...bounds, left: bounds.left + bounds.width * ratio, width: bounds.width * (1 - ratio) }
    : { ...bounds, top: bounds.top + bounds.height * ratio, height: bounds.height * (1 - ratio) };
  const first = flattenPaneLayout(node.first, ratioOverrides, firstBounds);
  const second = flattenPaneLayout(node.second, ratioOverrides, secondBounds);
  return {
    panes: [...first.panes, ...second.panes],
    splits: [
      ...first.splits,
      ...second.splits,
      { splitId: node.splitId, axis: node.axis, ratio, ...bounds },
    ],
  };
}

export function paneDropPosition(bounds, clientX, clientY) {
  if (!bounds || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const { left, top, width, height } = bounds;
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  if (clientX < left || clientX > left + width || clientY < top || clientY > top + height) return null;

  const distances = [
    ["left", (clientX - left) / width],
    ["right", (left + width - clientX) / width],
    ["top", (clientY - top) / height],
    ["bottom", (top + height - clientY) / height],
  ];
  return distances.reduce((nearest, candidate) => candidate[1] < nearest[1] ? candidate : nearest)[0];
}

export function terminalPaneDropTarget(sourcePaneId, targetPaneId, bounds, clientX, clientY) {
  if (!sourcePaneId || !targetPaneId || sourcePaneId === targetPaneId) return null;
  const position = paneDropPosition(bounds, clientX, clientY);
  return position ? { targetPaneId, position } : null;
}

export function parseOsc7Cwd(data, platform = globalThis.navigator?.platform || "") {
  try {
    const url = new URL(data);
    if (url.protocol !== "file:" || url.username || url.password || url.search || url.hash) return null;
    let path = decodeURIComponent(url.pathname);
    if (platform.toLowerCase().startsWith("win") && /^\/[a-zA-Z]:\//.test(path)) {
      path = path.slice(1);
    }
    if (!path) return null;
    return { host: url.hostname, path };
  } catch {
    return null;
  }
}
