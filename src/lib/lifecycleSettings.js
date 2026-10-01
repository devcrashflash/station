export const DEFAULT_LIFECYCLE_SETTINGS = Object.freeze({
  launchAtLogin: false,
  supported: false,
});

export function normalizeLifecycleSettings(settings) {
  const supported = settings?.supported === true;
  return {
    launchAtLogin: supported && settings?.launchAtLogin === true,
    supported,
  };
}
