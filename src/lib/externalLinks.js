import { openUrl } from "@tauri-apps/plugin-opener";

export async function openExternalUrl(url) {
  if (!url) return;

  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    try {
      await openUrl(url);
      return;
    } catch {
      // Fall through to the regular browser behavior.
    }
  }

  window.open(url, "_blank", "noreferrer");
}
