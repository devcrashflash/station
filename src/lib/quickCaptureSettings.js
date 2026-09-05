import {
  TERMINAL_SHORTCUT_ACTIONS,
  normalizeTerminalShortcuts,
  shortcutsMatch,
} from "./terminalShortcuts.js";

const WORKSPACE_SHORTCUTS = Object.freeze([
  { code: "KeyI", label: "Smart Inbox" },
  { code: "KeyB", label: "AI Agents" },
  { code: "KeyP", label: "project switching" },
  { code: "KeyT", label: "new terminal" },
  { code: "KeyW", label: "close terminal" },
  ...Array.from({ length: 10 }, (_, index) => ({
    code: `Digit${index}`,
    label: index === 0 ? "Main workspace navigation" : `terminal ${index} navigation`,
  })),
]);

export function quickCaptureStatus(settings) {
  if (settings?.enabled !== true) {
    return { label: "Disabled", variant: "secondary" };
  }
  if (settings?.registered === true) {
    return { label: "Active", variant: "secondary" };
  }
  return { label: "Unavailable", variant: "destructive" };
}

export function quickCaptureShortcutConflict(shortcut, terminalShortcuts, platform) {
  const workspaceConflict = WORKSPACE_SHORTCUTS.find((entry) => (
    shortcutsMatch(shortcut, `Control+${entry.code}`, platform)
    || shortcutsMatch(shortcut, `Super+${entry.code}`, platform)
  ));
  if (workspaceConflict) return { kind: "workspace", label: workspaceConflict.label };

  const normalizedTerminalShortcuts = normalizeTerminalShortcuts(terminalShortcuts, platform);
  const terminalConflict = TERMINAL_SHORTCUT_ACTIONS.find((action) => (
    shortcutsMatch(shortcut, normalizedTerminalShortcuts[action.id], platform)
  ));
  return terminalConflict
    ? { kind: "terminal", label: terminalConflict.label }
    : null;
}
