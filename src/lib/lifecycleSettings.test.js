import assert from "node:assert/strict";
import test from "node:test";

import { api } from "./api.js";
import {
  DEFAULT_LIFECYCLE_SETTINGS,
  lifecycleSettingsFromChangePayload,
  normalizeLifecycleSettings,
} from "./lifecycleSettings.js";

test("normalizes lifecycle support and launch state", () => {
  assert.deepEqual(normalizeLifecycleSettings(), DEFAULT_LIFECYCLE_SETTINGS);
  assert.deepEqual(normalizeLifecycleSettings({ launchAtLogin: true, supported: false }), {
    launchAtLogin: false,
    supported: false,
  });
  assert.deepEqual(normalizeLifecycleSettings({ launchAtLogin: true, supported: true }), {
    launchAtLogin: true,
    supported: true,
  });
});

test("uses unsupported lifecycle fallbacks outside the desktop app", async () => {
  assert.deepEqual(await api.lifecycleSettings(), DEFAULT_LIFECYCLE_SETTINGS);
  assert.deepEqual(
    await api.saveLifecycleSettings({ launchAtLogin: true }),
    DEFAULT_LIFECYCLE_SETTINGS,
  );
});

test("normalizes lifecycle settings change event payloads", () => {
  assert.deepEqual(
    lifecycleSettingsFromChangePayload({ launchAtLogin: true, supported: true }),
    { launchAtLogin: true, supported: true },
  );
  assert.deepEqual(
    lifecycleSettingsFromChangePayload({ launchAtLogin: true, supported: false }),
    DEFAULT_LIFECYCLE_SETTINGS,
  );
});
