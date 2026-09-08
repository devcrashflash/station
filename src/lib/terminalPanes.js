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

function spatialTerminalPaneId(node, currentPaneId, direction, ratioOverrides, allowWrap) {
  if (!node || !["left", "right", "up", "down"].includes(direction)) return null;
  const panes = flattenPaneLayout(node, ratioOverrides).panes;
  if (panes.length < 2) return null;
  const current = panes.find(({ pane }) => pane.paneId === currentPaneId);
  if (!current) return null;

  const epsilon = 1e-9;
  const horizontal = direction === "left" || direction === "right";
  const start = (bounds) => horizontal ? bounds.left : bounds.top;
  const end = (bounds) => start(bounds) + (horizontal ? bounds.width : bounds.height);
  const crossStart = (bounds) => horizontal ? bounds.top : bounds.left;
  const crossEnd = (bounds) => crossStart(bounds) + (horizontal ? bounds.height : bounds.width);
  const crossCenter = (bounds) => (crossStart(bounds) + crossEnd(bounds)) / 2;
  const negative = direction === "left" || direction === "up";
  const candidates = panes.filter(({ pane }) => pane.paneId !== currentPaneId);
  let directional = candidates.filter((candidate) => (
    negative
      ? end(candidate) <= start(current) + epsilon
      : start(candidate) >= end(current) - epsilon
  ));
  let wrapped = false;

  if (directional.length === 0) {
    if (!allowWrap) return null;
    wrapped = true;
    const extreme = negative
      ? Math.max(...candidates.map(end))
      : Math.min(...candidates.map(start));
    directional = candidates.filter((candidate) => (
      Math.abs((negative ? end(candidate) : start(candidate)) - extreme) <= epsilon
    ));
  }

  const score = (candidate, index) => {
    const overlap = Math.min(crossEnd(current), crossEnd(candidate))
      - Math.max(crossStart(current), crossStart(candidate));
    const gap = wrapped ? 0 : negative
      ? start(current) - end(candidate)
      : start(candidate) - end(current);
    return [overlap > epsilon ? 0 : 1, gap, Math.abs(crossCenter(candidate) - crossCenter(current)), index];
  };
  const ranked = directional.map((candidate) => ({
    candidate,
    score: score(candidate, panes.indexOf(candidate)),
  })).sort((left, right) => {
    for (let index = 0; index < left.score.length; index += 1) {
      if (left.score[index] !== right.score[index]) return left.score[index] - right.score[index];
    }
    return 0;
  });
  return ranked[0]?.candidate.pane.paneId || null;
}

export function adjacentTerminalPaneId(node, currentPaneId, direction, ratioOverrides = {}) {
  return spatialTerminalPaneId(node, currentPaneId, direction, ratioOverrides, true);
}

export function directlyReachableTerminalPaneId(node, currentPaneId, direction, ratioOverrides = {}) {
  return spatialTerminalPaneId(node, currentPaneId, direction, ratioOverrides, false);
}

export function terminalPaneShortcutTargets(node, currentPaneId, ratioOverrides = {}) {
  const targets = new Map();
  for (const direction of ["left", "right", "up", "down"]) {
    const directPaneId = directlyReachableTerminalPaneId(
      node,
      currentPaneId,
      direction,
      ratioOverrides,
    );
    const paneId = directPaneId || adjacentTerminalPaneId(
      node,
      currentPaneId,
      direction,
      ratioOverrides,
    );
    if (!paneId) continue;

    const current = targets.get(paneId);
    const direct = Boolean(directPaneId);
    if (!current || (direct && !current.direct)) {
      targets.set(paneId, { paneId, direction, direct });
    }
  }
  return [...targets.values()];
}

export function paneHasHorizontalSplitBelow(paneBounds, splits) {
  if (!paneBounds || !Array.isArray(splits)) return false;
  const epsilon = 1e-9;
  const paneBottom = paneBounds.top + paneBounds.height;
  const paneRight = paneBounds.left + paneBounds.width;

  return splits.some((split) => {
    if (split.axis !== "rows") return false;
    const splitBoundary = split.top + split.height * split.ratio;
    if (Math.abs(paneBottom - splitBoundary) > epsilon) return false;
    const splitRight = split.left + split.width;
    return Math.min(paneRight, splitRight) - Math.max(paneBounds.left, split.left) > epsilon;
  });
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
