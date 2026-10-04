export const DEFAULT_LIFECYCLE_SETTINGS = Object.freeze({
  launchAtLogin: false,
  supported: false,
});
export const LIFECYCLE_SETTINGS_CHANGED_EVENT = "lifecycle-settings-changed";

export function normalizeLifecycleSettings(settings) {
  const supported = settings?.supported === true;
  return {
    launchAtLogin: supported && settings?.launchAtLogin === true,
    supported,
  };
}

export function lifecycleSettingsFromChangePayload(payload) {
  return normalizeLifecycleSettings(payload);
}
