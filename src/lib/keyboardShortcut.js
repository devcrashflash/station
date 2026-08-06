export function shortcutModifier() {
  if (typeof navigator === "undefined") return "Ctrl";

  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  return /mac/i.test(platform) ? "⌘" : "Ctrl";
}

export function isPrimarySearchShortcut(
  event,
  platform = globalThis.navigator?.userAgentData?.platform
    || globalThis.navigator?.platform
    || "",
) {
  if (event.type && event.type !== "keydown") return false;
  if (event.altKey || event.shiftKey || event.key?.toLowerCase() !== "f") return false;

  return platform.toLowerCase().startsWith("mac")
    ? Boolean(event.metaKey && !event.ctrlKey)
    : Boolean(event.ctrlKey && !event.metaKey);
}

function platformIsMac(platform) {
  const detected = platform ?? (
    typeof navigator === "undefined"
      ? ""
      : navigator.userAgentData?.platform || navigator.platform || ""
  );
  return /mac/i.test(detected);
}

const MODIFIER_CODES = new Set([
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
]);

export function shortcutPreviewFromKeyboardEvent(event, { includeKey = true } = {}) {
  const modifiers = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Super");

  const usableKey = includeKey
    && event.key !== "Escape"
    && event.code
    && event.code !== "Unidentified"
    && !MODIFIER_CODES.has(event.code);
  return [...modifiers, usableKey ? event.code : null].filter(Boolean).join("+");
}

export function shortcutFromKeyboardEvent(event) {
  if (event.key === "Escape") return { status: "cancel" };
  if (MODIFIER_CODES.has(event.code)) return { status: "recording" };
  if (!event.code || event.code === "Unidentified") {
    return { status: "error", error: "That key cannot be used as a shortcut." };
  }
  if (!event.metaKey && !event.ctrlKey && !event.altKey) {
    return {
      status: "error",
      error: "Include Command, Control, Option, or Alt with another key.",
    };
  }

  return {
    status: "complete",
    shortcut: shortcutPreviewFromKeyboardEvent(event),
  };
}

function shortcutKeyLabel(token) {
  if (/^Key[A-Z]$/i.test(token)) return token.slice(3).toUpperCase();
  if (/^Digit[0-9]$/i.test(token)) return token.slice(5);
  const labels = {
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    Backquote: "`",
    Backslash: "\\",
    BracketLeft: "[",
    BracketRight: "]",
    Comma: ",",
    Equal: "=",
    Minus: "-",
    Period: ".",
    Quote: "'",
    Semicolon: ";",
    Slash: "/",
    Space: "Space",
  };
  return labels[token] || token;
}

export function formatShortcut(shortcut, platform) {
  const isMac = platformIsMac(platform);
  const tokens = String(shortcut || "").split("+").map((token) => token.trim()).filter(Boolean);
  const modifierState = { primary: false, control: false, alt: false, shift: false, super: false };
  let key = "";

  for (const token of tokens) {
    switch (token.toLowerCase()) {
      case "shift":
        modifierState.shift = true;
        break;
      case "control":
      case "ctrl":
        modifierState.control = true;
        break;
      case "alt":
      case "option":
        modifierState.alt = true;
        break;
      case "super":
      case "command":
      case "cmd":
        modifierState.super = true;
        break;
      case "commandorcontrol":
      case "commandorctrl":
      case "cmdorcontrol":
      case "cmdorctrl":
        modifierState.primary = true;
        break;
      default:
        key = shortcutKeyLabel(token);
    }
  }

  const modifiers = isMac
    ? [
        (modifierState.primary || modifierState.super) && "⌘",
        modifierState.control && "⌃",
        modifierState.alt && "⌥",
        modifierState.shift && "⇧",
      ].filter(Boolean)
    : [
        (modifierState.primary || modifierState.control) && "Ctrl",
        modifierState.alt && "Alt",
        modifierState.shift && "Shift",
        modifierState.super && "Super",
      ].filter(Boolean);
  return isMac ? `${modifiers.join("")}${key}` : [...modifiers, key].filter(Boolean).join("+");
}
