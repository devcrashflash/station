import assert from "node:assert/strict";
import test from "node:test";

import {
  AppUpdateManager,
  LAST_AUTOMATIC_UPDATE_CHECK_STORAGE_KEY,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_HISTORY_STORAGE_KEY,
  formatLastAutomaticUpdateCheck,
  readLastAutomaticUpdateCheck,
  updateProgress,
} from "./appUpdater.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeUpdate(version = "0.10.12") {
  return {
    version,
    body: "Changes",
    date: "2026-08-17T10:00:00Z",
    closeCalls: 0,
    async close() {
      this.closeCalls += 1;
    },
    async downloadAndInstall() {},
  };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test("browser mode never loads desktop updater APIs or schedules checks", async () => {
  let calls = 0;
  let scheduled = 0;
  const manager = new AppUpdateManager({
    desktop: false,
    adapter: {
      async getVersion() { calls += 1; },
      async check() { calls += 1; },
    },
    setIntervalFn() { scheduled += 1; },
  });

  await manager.start();
  await manager.check({ manual: true });

  assert.equal(calls, 0);
  assert.equal(scheduled, 0);
  assert.equal(manager.snapshot().supported, false);
});

test("startup checks immediately and schedules the six-hour interval", async () => {
  let checks = 0;
  let scheduledDelay = null;
  let intervalCallback = null;
  const storage = memoryStorage();
  let now = 1_800_000_000_000;
  const manager = new AppUpdateManager({
    desktop: true,
    currentVersion: "0.10.11",
    adapter: {
      async check() { checks += 1; return null; },
    },
    setIntervalFn(callback, delay) {
      intervalCallback = callback;
      scheduledDelay = delay;
      return 1;
    },
    clearIntervalFn() {},
    storage,
    nowFn: () => now,
  });

  assert.equal(manager.snapshot().currentVersion, "0.10.11");
  await manager.start();
  assert.equal(checks, 1);
  assert.equal(scheduledDelay, UPDATE_CHECK_INTERVAL_MS);
  assert.equal(manager.snapshot().currentVersion, "0.10.11");
  assert.equal(manager.snapshot().lastAutomaticCheckAt, now);
  assert.equal(readLastAutomaticUpdateCheck(storage), now);

  now += UPDATE_CHECK_INTERVAL_MS;
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checks, 2);
  assert.equal(manager.snapshot().lastAutomaticCheckAt, now);
  await manager.stop();
});

test("restores the last automatic check and does not replace it for manual checks or failures", async () => {
  const previous = 1_700_000_000_000;
  const storage = memoryStorage({
    [LAST_AUTOMATIC_UPDATE_CHECK_STORAGE_KEY]: String(previous),
  });
  let fail = false;
  const manager = new AppUpdateManager({
    desktop: true,
    adapter: {
      async check() {
        if (fail) throw new Error("offline");
        return null;
      },
    },
    storage,
    nowFn: () => 1_800_000_000_000,
  });

  assert.equal(manager.snapshot().lastAutomaticCheckAt, previous);
  await manager.check({ manual: true });
  assert.equal(manager.snapshot().lastAutomaticCheckAt, previous);

  fail = true;
  await manager.check();
  assert.equal(manager.snapshot().lastAutomaticCheckAt, previous);
  assert.equal(readLastAutomaticUpdateCheck(storage), previous);
});

test("formats automatic update checks in local time and handles missing values", () => {
  const value = Date.UTC(2026, 8, 24, 17, 30);
  const expected = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

  assert.equal(formatLastAutomaticUpdateCheck(value), expected);
  assert.equal(formatLastAutomaticUpdateCheck(null), "Never");
  assert.equal(formatLastAutomaticUpdateCheck("invalid"), "Never");
});

test("concurrent automatic checks share one updater request", async () => {
  const result = deferred();
  let checks = 0;
  const manager = new AppUpdateManager({
    desktop: true,
    adapter: {
      async check() { checks += 1; return result.promise; },
    },
  });

  const first = manager.check();
  const second = manager.check();
  assert.equal(checks, 1);
  result.resolve(null);
  await Promise.all([first, second]);
  assert.equal(checks, 1);
});

test("restarting the manager replaces a stale startup check", async () => {
  const firstResult = deferred();
  let checks = 0;
  const manager = new AppUpdateManager({
    desktop: true,
    currentVersion: "0.10.11",
    adapter: {
      async check() {
        checks += 1;
        return checks === 1 ? firstResult.promise : null;
      },
    },
    setIntervalFn() { return checks; },
    clearIntervalFn() {},
  });

  const firstStart = manager.start();
  await new Promise((resolve) => setImmediate(resolve));
  const stop = manager.stop();
  const secondStart = manager.start();
  firstResult.resolve(fakeUpdate());
  await Promise.all([firstStart, stop, secondStart]);

  assert.equal(checks, 2);
  assert.equal(manager.snapshot().promptOpen, false);
  await manager.stop();
});

test("automatic prompts occur once per version while manual checks can re-offer", async () => {
  const updates = [fakeUpdate(), fakeUpdate(), fakeUpdate()];
  const manager = new AppUpdateManager({
    desktop: true,
    adapter: { async check() { return updates.shift(); } },
  });

  await manager.check();
  assert.equal(manager.snapshot().promptOpen, true);
  await manager.check();
  assert.equal(manager.snapshot().promptOpen, true);
  await manager.dismiss();
  assert.equal(manager.snapshot().promptOpen, false);

  await manager.check();
  assert.equal(manager.snapshot().promptOpen, false);
  assert.equal(updates.length, 0);

  updates.push(fakeUpdate());
  await manager.check({ manual: true });
  assert.equal(manager.snapshot().promptOpen, true);
  assert.equal(manager.snapshot().update.version, "0.10.12");
});

test("automatic and manual check failures are reported without opening a prompt", async () => {
  const manager = new AppUpdateManager({
    desktop: true,
    adapter: { async check() { throw new Error("offline"); } },
  });

  await manager.check();
  assert.match(manager.snapshot().message, /Could not check for updates: offline/);
  assert.equal(manager.snapshot().promptOpen, false);

  await manager.check({ manual: true });
  assert.match(manager.snapshot().message, /Could not check for updates: offline/);
});

test("download progress is accumulated and capped", () => {
  let progress = updateProgress(
    { downloaded: 0, total: 0, percent: null },
    { event: "Started", data: { contentLength: 100 } },
  );
  progress = updateProgress(progress, { event: "Progress", data: { chunkLength: 40 } });
  assert.deepEqual(progress, { downloaded: 40, total: 100, percent: 40 });
  progress = updateProgress(progress, { event: "Progress", data: { chunkLength: 80 } });
  assert.equal(progress.percent, 100);
  assert.equal(updateProgress(progress, { event: "Finished" }).percent, 100);
});

test("install reports progress, retries failures, and relaunches after success", async () => {
  const update = fakeUpdate();
  let attempts = 0;
  update.downloadAndInstall = async (onEvent) => {
    attempts += 1;
    if (attempts === 1) throw new Error("disk full");
    onEvent({ event: "Started", data: { contentLength: 10 } });
    onEvent({ event: "Progress", data: { chunkLength: 10 } });
    onEvent({ event: "Finished" });
  };
  let relaunches = 0;
  const manager = new AppUpdateManager({
    desktop: true,
    adapter: {
      async check() { return update; },
      async relaunch() { relaunches += 1; },
    },
  });

  await manager.check();
  await manager.install();
  assert.equal(manager.snapshot().phase, "error");
  assert.match(manager.snapshot().message, /disk full/);

  await manager.install();
  assert.equal(attempts, 2);
  assert.equal(manager.snapshot().progress.percent, 100);
  assert.equal(relaunches, 1);
});

test("manual and failed automatic checks persist attempts, successes, and the latest failure", async () => {
  const storage = memoryStorage();
  let now = 1_800_000_000_000;
  let fail = false;
  const adapter = { async check() { if (fail) throw new Error("offline"); return null; } };
  const manager = new AppUpdateManager({ desktop: true, storage, adapter, nowFn: () => now });
  await manager.check({ manual: true });
  assert.equal(manager.snapshot().lastCheckAttemptAt, now);
  assert.equal(manager.snapshot().lastSuccessfulCheckAt, now);
  assert.equal(manager.snapshot().lastCheckSource, "manual");
  assert.equal(manager.snapshot().lastAutomaticCheckAt, null);
  const successAt = now;
  now += 1000;
  fail = true;
  await manager.check();
  const restored = new AppUpdateManager({ desktop: true, storage, adapter });
  assert.equal(restored.snapshot().lastCheckAttemptAt, now);
  assert.equal(restored.snapshot().lastCheckSource, "automatic");
  assert.equal(restored.snapshot().lastSuccessfulCheckAt, successAt);
  assert.deepEqual(restored.snapshot().lastCheckError, { at: now, message: "offline" });
  assert.equal(restored.snapshot().promptOpen, false);
  now += 1000;
  fail = false;
  await manager.check();
  assert.equal(manager.snapshot().lastSuccessfulCheckAt, now);
  assert.equal(manager.snapshot().lastCheckError.message, "offline");
  assert.equal(manager.snapshot().message, "Station is up to date.");
});

test("legacy successful automatic check is preserved without inventing installation history", () => {
  const previous = 1_700_000_000_000;
  const manager = new AppUpdateManager({ desktop: true, adapter: {}, storage: memoryStorage({
    [LAST_AUTOMATIC_UPDATE_CHECK_STORAGE_KEY]: String(previous),
  }) });
  assert.equal(manager.snapshot().lastSuccessfulCheckAt, previous);
  assert.equal(manager.snapshot().lastCheckAttemptAt, null);
  assert.equal(manager.snapshot().lastInstalledUpdate, null);
});

test("invalid stored history and inaccessible storage do not prevent update checks", async () => {
  for (const storage of [
    memoryStorage({ [UPDATE_HISTORY_STORAGE_KEY]: "broken json" }),
    memoryStorage({ [UPDATE_HISTORY_STORAGE_KEY]: JSON.stringify({ lastCheckAttemptAt: "bad", lastCheckError: { at: -1 }, lastInstalledUpdate: { at: 12 } }) }),
    { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } },
  ]) {
    const manager = new AppUpdateManager({ desktop: true, storage, adapter: { async check() { return null; } }, nowFn: () => 1234 });
    assert.equal(manager.snapshot().lastCheckAttemptAt, null);
    assert.equal(manager.snapshot().lastInstalledUpdate, null);
    await manager.check();
    assert.equal(manager.snapshot().lastSuccessfulCheckAt, 1234);
  }
});

test("checks and dismissal cannot interrupt installation or trigger duplicate installs", async () => {
  const download = deferred();
  const update = fakeUpdate();
  let installs = 0;
  let checks = 0;
  update.downloadAndInstall = async () => { installs += 1; await download.promise; };
  const manager = new AppUpdateManager({ desktop: true, adapter: {
    async check() { checks += 1; return update; }, async relaunch() {},
  } });
  await manager.check();
  const installation = manager.install();
  await manager.check();
  await manager.check({ manual: true });
  await manager.install();
  await manager.dismiss();
  assert.equal(checks, 1);
  assert.equal(installs, 1);
  assert.equal(update.closeCalls, 0);
  assert.equal(manager.snapshot().phase, "installing");
  assert.equal(manager.snapshot().promptOpen, true);
  download.resolve();
  await installation;
  assert.equal(manager.snapshot().phase, "restarting");
  await manager.check();
  assert.equal(checks, 1);
});

test("installation waits for a pending check before using its resource", async () => {
  const result = deferred();
  const update = fakeUpdate();
  let installs = 0;
  let checks = 0;
  update.downloadAndInstall = async () => { installs += 1; };
  const manager = new AppUpdateManager({ desktop: true, adapter: {
    async check() { checks += 1; return checks === 1 ? update : result.promise; }, async relaunch() {},
  } });
  await manager.check();
  const checking = manager.check();
  await manager.install();
  assert.equal(installs, 0);
  assert.equal(manager.snapshot().phase, "checking");
  result.resolve(fakeUpdate());
  await checking;
  await manager.install();
  assert.ok(manager.snapshot().lastInstalledUpdate);
});

test("installation is persisted before relaunch and restart retry never reinstalls", async () => {
  const storage = memoryStorage();
  const update = fakeUpdate("0.10.17");
  let installs = 0;
  let restarts = 0;
  update.downloadAndInstall = async () => { installs += 1; };
  const adapter = {
    async check() { return update; },
    async relaunch() {
      restarts += 1;
      const history = JSON.parse(storage.getItem(UPDATE_HISTORY_STORAGE_KEY));
      assert.deepEqual(history.lastInstalledUpdate, { version: "0.10.17", at: 1234 });
      if (restarts === 1) throw new Error("restart blocked");
    },
  };
  const manager = new AppUpdateManager({ desktop: true, storage, adapter, nowFn: () => 1234 });
  await manager.check();
  await manager.install();
  assert.equal(manager.snapshot().phase, "restart-required");
  assert.match(manager.snapshot().message, /Update installed, but Station could not restart/);
  const restored = new AppUpdateManager({ desktop: true, storage, adapter, currentVersion: "0.10.17" });
  assert.deepEqual(restored.snapshot().lastInstalledUpdate, { version: "0.10.17", at: 1234 });
  await manager.dismiss();
  await manager.check();
  assert.equal(manager.snapshot().phase, "restart-required");
  await manager.install();
  assert.equal(installs, 1);
  assert.equal(restarts, 2);
});

test("failed installation preserves the previously recorded installation", async () => {
  const storage = memoryStorage({ [UPDATE_HISTORY_STORAGE_KEY]: JSON.stringify({ lastInstalledUpdate: { version: "0.10.15", at: 1000 } }) });
  const update = fakeUpdate();
  update.downloadAndInstall = async () => { throw new Error("disk full"); };
  const manager = new AppUpdateManager({ desktop: true, storage, adapter: { async check() { return update; } } });
  await manager.check();
  await manager.install();
  assert.equal(manager.snapshot().phase, "error");
  assert.deepEqual(manager.snapshot().lastInstalledUpdate, { version: "0.10.15", at: 1000 });
  assert.deepEqual(JSON.parse(storage.getItem(UPDATE_HISTORY_STORAGE_KEY)).lastInstalledUpdate, { version: "0.10.15", at: 1000 });
});
