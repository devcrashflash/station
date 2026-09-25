import assert from "node:assert/strict";
import test from "node:test";

import {
  AppUpdateManager,
  LAST_AUTOMATIC_UPDATE_CHECK_STORAGE_KEY,
  UPDATE_CHECK_INTERVAL_MS,
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
    adapter: {
      async getVersion() { return "0.10.11"; },
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
    adapter: {
      async getVersion() { return "0.10.11"; },
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

test("automatic check errors stay silent and manual errors are reported", async () => {
  const manager = new AppUpdateManager({
    desktop: true,
    adapter: { async check() { throw new Error("offline"); } },
  });

  await manager.check();
  assert.equal(manager.snapshot().message, "Updates are checked automatically.");

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
