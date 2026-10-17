export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const LAST_AUTOMATIC_UPDATE_CHECK_STORAGE_KEY = "dcf-last-automatic-update-check-v1";
export const UPDATE_HISTORY_STORAGE_KEY = "dcf-update-history-v1";
export const BUILD_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null;

export function readLastAutomaticUpdateCheck(storage = globalThis.window?.localStorage) {
  try {
    const value = Number(storage?.getItem(LAST_AUTOMATIC_UPDATE_CHECK_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeLastAutomaticUpdateCheck(value, storage = globalThis.window?.localStorage) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  try {
    storage?.setItem(LAST_AUTOMATIC_UPDATE_CHECK_STORAGE_KEY, String(timestamp));
  } catch {
    // The in-memory timestamp still updates when persistent storage is unavailable.
  }
  return timestamp;
}

export function formatLastAutomaticUpdateCheck(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Never";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function readUpdateHistory(storage) {
  let history;
  try {
    history = JSON.parse(storage?.getItem(UPDATE_HISTORY_STORAGE_KEY) || "null");
  } catch {
    // Older installations and unavailable storage have no history yet.
  }
  const timestamp = (value) => Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : null;
  return {
    lastCheckAttemptAt: timestamp(history?.lastCheckAttemptAt),
    lastCheckSource: history?.lastCheckSource === "manual" ? "manual" : "automatic",
    lastSuccessfulCheckAt: timestamp(history?.lastSuccessfulCheckAt) || readLastAutomaticUpdateCheck(storage),
    lastCheckError: timestamp(history?.lastCheckError?.at) && typeof history?.lastCheckError?.message === "string"
      ? { at: history.lastCheckError.at, message: history.lastCheckError.message } : null,
    lastInstalledUpdate: timestamp(history?.lastInstalledUpdate?.at) && typeof history?.lastInstalledUpdate?.version === "string"
      ? { at: history.lastInstalledUpdate.at, version: history.lastInstalledUpdate.version } : null,
  };
}

export function updateProgress(current, event) {
  if (event?.event === "Started") {
    const total = Number(event.data?.contentLength) || 0;
    return { downloaded: 0, total, percent: total ? 0 : null };
  }
  if (event?.event === "Progress") {
    const downloaded = current.downloaded + (Number(event.data?.chunkLength) || 0);
    return {
      downloaded,
      total: current.total,
      percent: current.total ? Math.min(100, Math.round((downloaded / current.total) * 100)) : null,
    };
  }
  if (event?.event === "Finished") {
    return { ...current, percent: 100 };
  }
  return current;
}

function updateMetadata(update) {
  return update ? {
    version: update.version,
    body: update.body || "",
    date: update.date || null,
  } : null;
}

function errorMessage(error) {
  return error?.message || String(error);
}

export class AppUpdateManager {
  constructor({
    desktop,
    adapter,
    intervalMs = UPDATE_CHECK_INTERVAL_MS,
    setIntervalFn = globalThis.setInterval,
    clearIntervalFn = globalThis.clearInterval,
    storage = globalThis.window?.localStorage,
    nowFn = Date.now,
    currentVersion = BUILD_VERSION,
  }) {
    this.desktop = desktop;
    this.adapter = adapter;
    this.intervalMs = intervalMs;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.storage = storage;
    this.nowFn = nowFn;
    this.listeners = new Set();
    this.promptedVersions = new Set();
    this.updateResource = null;
    this.inFlightCheck = null;
    this.inFlightRunId = null;
    this.timerId = null;
    this.runId = 0;
    this.running = false;
    this.state = {
      supported: desktop,
      currentVersion: desktop ? currentVersion : null,
      lastAutomaticCheckAt: desktop ? readLastAutomaticUpdateCheck(storage) : null,
      ...readUpdateHistory(desktop ? storage : null),
      phase: "idle",
      message: desktop ? "Updates are checked automatically." : "Updates require the desktop app.",
      update: null,
      promptOpen: false,
      progress: { downloaded: 0, total: 0, percent: null },
    };
  }

  snapshot = () => this.state;

  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  emit(patch) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  recordHistory(patch) {
    const { lastCheckAttemptAt, lastCheckSource, lastSuccessfulCheckAt, lastCheckError, lastInstalledUpdate } = { ...this.state, ...patch };
    try {
      this.storage?.setItem(UPDATE_HISTORY_STORAGE_KEY, JSON.stringify({
        lastCheckAttemptAt, lastCheckSource, lastSuccessfulCheckAt, lastCheckError, lastInstalledUpdate,
      }));
    } catch {
      // History remains available for this session if storage is unavailable.
    }
    this.emit(patch);
  }

  get installationActive() {
    return ["installing", "restarting", "restart-required"].includes(this.state.phase);
  }

  async start() {
    if (!this.desktop || this.running) return;
    this.running = true;
    const runId = ++this.runId;
    this.timerId = this.setIntervalFn(() => {
      this.check({ manual: false }).catch(() => {});
    }, this.intervalMs);

    if (this.running && runId === this.runId) {
      await this.check({ manual: false });
    }
  }

  async stop() {
    this.running = false;
    this.runId += 1;
    if (this.timerId !== null) {
      this.clearIntervalFn(this.timerId);
      this.timerId = null;
    }
    if (!this.installationActive) await this.releaseUpdate();
  }

  async releaseUpdate() {
    const update = this.updateResource;
    this.updateResource = null;
    if (update?.close) {
      try {
        await update.close();
      } catch {
        // Resource cleanup must not make the application unusable.
      }
    }
  }

  async check({ manual = false } = {}) {
    if (!this.desktop || this.installationActive) return null;
    if (this.inFlightCheck) {
      const inFlightRunId = this.inFlightRunId;
      await this.inFlightCheck;
      if (manual || (this.running && inFlightRunId !== this.runId)) {
        return this.check({ manual });
      }
      return null;
    }

    const checkRunId = this.runId;
    this.inFlightRunId = checkRunId;
    this.inFlightCheck = this.performCheck({ manual, checkRunId });
    try {
      return await this.inFlightCheck;
    } finally {
      this.inFlightCheck = null;
      this.inFlightRunId = null;
    }
  }

  async performCheck({ manual, checkRunId }) {
    const previousPhase = this.state.update ? "available" : "idle";
    this.recordHistory({ lastCheckAttemptAt: this.nowFn(), lastCheckSource: manual ? "manual" : "automatic" });
    this.emit({
      phase: "checking",
      message: manual ? "Checking for updates…" : this.state.message,
    });

    try {
      const update = await this.adapter.check();
      if (checkRunId !== this.runId) {
        await update?.close?.();
        return null;
      }

      if (!manual) {
        const lastAutomaticCheckAt = writeLastAutomaticUpdateCheck(this.nowFn(), this.storage);
        if (lastAutomaticCheckAt) this.emit({ lastAutomaticCheckAt });
      }
      this.recordHistory({ lastSuccessfulCheckAt: this.nowFn() });

      if (!update) {
        await this.releaseUpdate();
        this.emit({
          phase: "idle",
          message: "Station is up to date.",
          update: null,
          promptOpen: false,
        });
        return null;
      }

      const metadata = updateMetadata(update);
      const alreadyPrompted = this.promptedVersions.has(metadata.version);
      if (alreadyPrompted && !manual) {
        await update.close?.();
        const keepCurrentPrompt = Boolean(
          this.updateResource
          && this.state.update?.version === metadata.version
          && this.state.promptOpen,
        );
        this.emit({
          phase: "available",
          message: `Station ${metadata.version} is available.`,
          update: metadata,
          promptOpen: keepCurrentPrompt,
        });
        return metadata;
      }

      await this.releaseUpdate();
      this.updateResource = update;
      this.promptedVersions.add(metadata.version);
      this.emit({
        phase: "available",
        message: `Station ${metadata.version} is available.`,
        update: metadata,
        promptOpen: true,
        progress: { downloaded: 0, total: 0, percent: null },
      });
      return metadata;
    } catch (error) {
      if (checkRunId !== this.runId) return null;
      this.recordHistory({ lastCheckError: { at: this.nowFn(), message: errorMessage(error) } });
      this.emit({
        phase: previousPhase,
        message: `Could not check for updates: ${errorMessage(error)}`,
      });
      return null;
    }
  }

  async dismiss() {
    if (["installing", "restarting"].includes(this.state.phase)) return;
    await this.releaseUpdate();
    this.emit({ promptOpen: false });
  }

  async install() {
    if (this.state.phase === "restart-required") return this.restart();
    if (!this.updateResource || this.installationActive || this.inFlightCheck) return;
    const version = this.state.update.version;
    this.emit({
      phase: "installing",
      message: `Installing Station ${this.state.update.version}…`,
      progress: { downloaded: 0, total: 0, percent: null },
    });

    try {
      await this.updateResource.downloadAndInstall((event) => {
        const progress = updateProgress(this.state.progress, event);
        this.emit({ progress });
      });
    } catch (error) {
      this.emit({
        phase: "error",
        message: `Could not install the update: ${errorMessage(error)}`,
        promptOpen: true,
      });
      return;
    }
    this.recordHistory({ lastInstalledUpdate: { version, at: this.nowFn() } });
    await this.restart();
  }

  async restart() {
    this.emit({ phase: "restarting", message: "Update installed. Restarting Station…" });
    try {
      await this.adapter.relaunch();
    } catch (error) {
      this.emit({
        phase: "restart-required",
        message: `Update installed, but Station could not restart: ${errorMessage(error)}. Restart Station to use the new version.`,
        promptOpen: true,
      });
    }
  }
}

export function createTauriUpdateAdapter() {
  let modulesPromise;
  const modules = () => {
    modulesPromise ||= Promise.all([
      import("@tauri-apps/plugin-updater"),
      import("@tauri-apps/plugin-process"),
    ]);
    return modulesPromise;
  };

  return {
    async check() {
      const [updater] = await modules();
      return updater.check();
    },
    async relaunch() {
      const [, process] = await modules();
      return process.relaunch();
    },
  };
}
