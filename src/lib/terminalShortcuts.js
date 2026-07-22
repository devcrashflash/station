export const DEFAULT_TERMINAL_SHORTCUTS = Object.freeze({
  splitColumns: "CommandOrControl+KeyD",
  splitRows: "CommandOrControl+Shift+KeyD",
  search: "CommandOrControl+KeyF",
  clear: "Super+KeyK",
  zoomIn: "CommandOrControl+Equal",
  zoomOut: "CommandOrControl+Minus",
});

export const TERMINAL_SHORTCUT_ACTIONS = Object.freeze([
  { id: "splitColumns", label: "Split pane right" },
  { id: "splitRows", label: "Split pane down" },
  { id: "search", label: "Search terminal output" },
  { id: "clear", label: "Clear terminal" },
  { id: "zoomIn", label: "Increase font size" },
  { id: "zoomOut", label: "Decrease font size" },
]);

const MODIFIER_TOKENS = new Set([
  "alt",
  "option",
  "shift",
  "control",
  "ctrl",
  "super",
  "command",
  "cmd",
  "commandorcontrol",
  "commandorctrl",
  "cmdorcontrol",
  "cmdorctrl",
]);

function platformIsMac(platform) {
  const detected = platform ?? globalThis.navigator?.userAgentData?.platform ?? globalThis.navigator?.platform ?? "";
  return /mac/i.test(detected);
}

function shortcutParts(shortcut) {
  const tokens = String(shortcut || "").split("+").map((token) => token.trim()).filter(Boolean);
  const modifiers = { alt: false, control: false, meta: false, shift: false, primary: false };
  let code = "";
  for (const token of tokens) {
    switch (token.toLowerCase()) {
      case "alt":
      case "option":
        modifiers.alt = true;
        break;
      case "control":
      case "ctrl":
        modifiers.control = true;
        break;
      case "super":
      case "command":
      case "cmd":
        modifiers.meta = true;
        break;
      case "shift":
        modifiers.shift = true;
        break;
      case "commandorcontrol":
      case "commandorctrl":
      case "cmdorcontrol":
      case "cmdorctrl":
        modifiers.primary = true;
        break;
      default:
        if (code) return null;
        code = token;
    }
  }
  if (!code || !tokens.some((token) => MODIFIER_TOKENS.has(token.toLowerCase()))) return null;
  if (!modifiers.alt && !modifiers.control && !modifiers.meta && !modifiers.primary) return null;
  return { code, modifiers };
}

function resolvedParts(shortcut, platform) {
  const parts = shortcutParts(shortcut);
  if (!parts) return null;
  const isMac = platformIsMac(platform);
  return {
    code: parts.code.toLowerCase(),
    alt: parts.modifiers.alt,
    control: parts.modifiers.control || (parts.modifiers.primary && !isMac),
    meta: parts.modifiers.meta || (parts.modifiers.primary && isMac),
    shift: parts.modifiers.shift,
  };
}

function shortcutSignature(shortcut, platform) {
  const parts = resolvedParts(shortcut, platform);
  return parts && `${parts.control ? 1 : 0}${parts.alt ? 1 : 0}${parts.shift ? 1 : 0}${parts.meta ? 1 : 0}:${parts.code}`;
}

export function normalizeTerminalShortcuts(shortcuts = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_TERMINAL_SHORTCUTS).map(([id, fallback]) => [
    id,
    shortcutParts(shortcuts?.[id]) ? shortcuts[id] : fallback,
  ]));
}

export function matchesTerminalShortcut(event, shortcut, platform) {
  if (event.type && event.type !== "keydown") return false;
  const parts = resolvedParts(shortcut, platform);
  if (!parts || event.repeat) return false;
  return Boolean(event.ctrlKey) === parts.control
    && Boolean(event.altKey) === parts.alt
    && Boolean(event.shiftKey) === parts.shift
    && Boolean(event.metaKey) === parts.meta
    && String(event.code || "").toLowerCase() === parts.code;
}

export function terminalShortcutConflict(shortcuts, platform) {
  for (const action of TERMINAL_SHORTCUT_ACTIONS) {
    if (Object.prototype.hasOwnProperty.call(shortcuts || {}, action.id)
      && !shortcutParts(shortcuts[action.id])) {
      return { action: action.id, reserved: false, invalid: true };
    }
  }
  const normalized = normalizeTerminalShortcuts(shortcuts);
  const seen = new Map();
  for (const action of TERMINAL_SHORTCUT_ACTIONS) {
    const signature = shortcutSignature(normalized[action.id], platform);
    if (!signature) return { action: action.id, reserved: false, invalid: true };
    if (seen.has(signature)) {
      return { action: action.id, otherAction: seen.get(signature), reserved: false, invalid: false };
    }
    seen.set(signature, action.id);
  }

  const reserved = ["KeyT", "KeyW", ...Array.from({ length: 10 }, (_, index) => `Digit${index}`)]
    .map((code) => shortcutSignature(`CommandOrControl+${code}`, platform));
  for (const action of TERMINAL_SHORTCUT_ACTIONS) {
    if (reserved.includes(shortcutSignature(normalized[action.id], platform))) {
      return { action: action.id, reserved: true, invalid: false };
    }
  }
  return null;
}

export function terminalZoomDelta(event, shortcuts, platform) {
  const normalized = normalizeTerminalShortcuts(shortcuts);
  if (matchesTerminalShortcut(event, normalized.zoomIn, platform)) return 1;
  if (matchesTerminalShortcut(event, normalized.zoomOut, platform)) return -1;

  // Keep the historical aliases while the corresponding shortcut is unchanged.
  if (normalized.zoomIn === DEFAULT_TERMINAL_SHORTCUTS.zoomIn) {
    const isMac = platformIsMac(platform);
    const primary = isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (!event.altKey && primary) {
      if ((event.code === "Equal" && (event.key === "=" || event.key === "+"))
        || (event.code === "NumpadAdd" && !event.shiftKey)) return 1;
    }
  }
  if (normalized.zoomOut === DEFAULT_TERMINAL_SHORTCUTS.zoomOut) {
    const isMac = platformIsMac(platform);
    const primary = isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (!event.altKey && !event.shiftKey && primary && event.code === "NumpadSubtract") return -1;
  }
  return null;
}

export function setTerminalShortcutRecording(active) {
  if (typeof document === "undefined") return;
  if (active) document.documentElement.dataset.terminalShortcutRecording = "true";
  else delete document.documentElement.dataset.terminalShortcutRecording;
}

export function terminalShortcutRecordingActive() {
  return typeof document !== "undefined"
    && document.documentElement.dataset.terminalShortcutRecording === "true";
}
