export function clampSplitRatio(ratio) {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(0.9, Math.max(0.1, ratio));
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
