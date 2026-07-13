export function shortcutModifier() {
  if (typeof navigator === "undefined") return "Ctrl";

  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  return /mac/i.test(platform) ? "⌘" : "Ctrl";
}
