export const TERMINAL_SHELL_INTEGRATION_DESKTOP_REQUIRED_STATUS = {
  shell: null,
  shellPath: null,
  supported: false,
  targetConfigPath: null,
  startupFilePath: null,
  installed: false,
  managedFileInstalled: false,
  sourceBlockInstalled: false,
  message: "Shift+Enter shell integration requires the desktop app.",
};

export function terminalShellIntegrationStatusText(status) {
  if (!status) return "Checking shell integration…";
  if (!status.supported) return status.message || "Shell integration is unavailable for this shell.";
  const shell = status.shell || "detected shell";
  return status.installed
    ? `Installed for ${shell}.`
    : `Available for ${shell}, not installed.`;
}

export function terminalShellIntegrationDetailText(status) {
  if (!status?.supported) {
    return status?.message || "Station can install this integration for fish, zsh, and bash.";
  }
  if (status.installed) {
    return "Open a new terminal session, or source your shell startup file, before testing Shift+Enter in an existing shell.";
  }
  return "Install adds only Station-managed shell files and source blocks. Shift+Enter keeps sending CSI-u at the terminal level.";
}

export function terminalShellIntegrationBadgeVariant(status) {
  if (!status?.supported) return "secondary";
  return status.installed ? "default" : "outline";
}

export function terminalShellIntegrationBadgeText(status) {
  if (!status) return "Checking";
  if (!status.supported) return "Unsupported";
  return status.installed ? "Installed" : "Not installed";
}
