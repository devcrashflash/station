import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalDirectorySync } from "./terminalDirectorySync.js";

function clock() {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    schedule: (callback, delay) => {
      const id = ++nextId;
      timers.set(id, { at: time + delay, callback });
      return id;
    },
    cancel: (id) => timers.delete(id),
    async advance(ms) {
      time += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.callback();
        }
      }
      await Promise.resolve();
    },
    count: () => timers.size,
  };
}

test("directory probes debounce output, throttle bursts, and never poll idle panes", async () => {
  const timing = clock();
  let calls = 0;
  const sync = createTerminalDirectorySync(() => { calls++; }, timing);
  sync.request();
  await timing.advance(100);
  sync.request();
  await timing.advance(249);
  assert.equal(calls, 0);
  await timing.advance(1);
  assert.equal(calls, 1);
  sync.request();
  await timing.advance(999);
  assert.equal(calls, 1);
  await timing.advance(1);
  assert.equal(calls, 2);
  await timing.advance(10000);
  assert.equal(calls, 2);
  assert.equal(timing.count(), 0);
  sync.dispose();
});

test("directory probes serialize in-flight requests and cancel work on disposal", async () => {
  const timing = clock();
  let calls = 0;
  let finish;
  const sync = createTerminalDirectorySync(() => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  }, timing);
  sync.request();
  await timing.advance(250);
  assert.equal(calls, 1);
  sync.request();
  sync.request();
  assert.equal(timing.count(), 0);
  finish();
  await Promise.resolve();
  assert.equal(timing.count(), 1);
  sync.dispose();
  await timing.advance(2000);
  sync.request();
  assert.equal(calls, 1);
  assert.equal(timing.count(), 0);
});

test("directory probes recover after a pane lookup fails", async () => {
  const timing = clock();
  let calls = 0;
  const sync = createTerminalDirectorySync(() => {
    calls++;
    throw new Error("pane exited");
  }, timing);
  sync.request();
  await timing.advance(250);
  sync.request();
  await timing.advance(1000);
  assert.equal(calls, 2);
  sync.dispose();
});
