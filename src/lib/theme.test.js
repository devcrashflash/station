import test from "node:test";
import assert from "node:assert/strict";

import {
  applyDocumentTheme,
  applyThemeChangePayload,
  initializeTheme,
  normalizeThemePreference,
  readThemePreference,
  resolveTheme,
  subscribeToSystemThemeChanges,
  themeFromChangePayload,
  THEME_STORAGE_KEY,
  writeThemePreference,
} from "./theme.js";

function memoryStorage(initialValue = null) {
  let value = initialValue;
  return {
    getItem(key) {
      assert.equal(key, THEME_STORAGE_KEY);
      return value;
    },
    setItem(key, nextValue) {
      assert.equal(key, THEME_STORAGE_KEY);
      value = nextValue;
    },
  };
}

function fakeDocument() {
  const classes = new Set();
  return {
    classes,
    documentElement: {
      classList: {
        toggle(name, enabled) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
      },
      style: {},
    },
  };
}

test("theme preferences validate and default to system", () => {
  assert.equal(normalizeThemePreference("dark"), "dark");
  assert.equal(normalizeThemePreference("light"), "light");
  assert.equal(normalizeThemePreference("sepia"), "system");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
});

test("theme preference persists with safe storage fallbacks", () => {
  const storage = memoryStorage("invalid");
  assert.equal(readThemePreference(storage), "system");
  assert.equal(writeThemePreference("dark", storage), "dark");
  assert.equal(readThemePreference(storage), "dark");
  assert.equal(readThemePreference({ getItem() { throw new Error("blocked"); } }), "system");
  assert.doesNotThrow(() => writeThemePreference("light", { setItem() { throw new Error("blocked"); } }));
});

test("document and initial system theme are applied", () => {
  const documentRef = fakeDocument();
  applyDocumentTheme("dark", documentRef);
  assert.equal(documentRef.classes.has("dark"), true);
  assert.equal(documentRef.documentElement.style.colorScheme, "dark");

  const effectiveTheme = initializeTheme({
    storage: memoryStorage("system"),
    windowRef: { matchMedia: () => ({ matches: false }) },
    documentRef,
  });
  assert.equal(effectiveTheme, "light");
  assert.equal(documentRef.classes.has("dark"), false);
  assert.equal(documentRef.documentElement.style.colorScheme, "light");
});

test("cross-webview theme payloads validate before applying", () => {
  const documentRef = fakeDocument();
  assert.equal(themeFromChangePayload({ effectiveTheme: "dark" }), "dark");
  assert.equal(themeFromChangePayload({ effectiveTheme: "light" }), "light");
  assert.equal(themeFromChangePayload({ effectiveTheme: "system" }), null);
  assert.equal(themeFromChangePayload(null), null);

  assert.equal(applyThemeChangePayload({ effectiveTheme: "dark" }, documentRef), "dark");
  assert.equal(documentRef.classes.has("dark"), true);
  assert.equal(applyThemeChangePayload({ effectiveTheme: "invalid" }, documentRef), null);
  assert.equal(documentRef.classes.has("dark"), true);
  assert.equal(applyThemeChangePayload({ effectiveTheme: "light" }, documentRef), "light");
  assert.equal(documentRef.classes.has("dark"), false);
});

test("system theme changes can be observed and unsubscribed", () => {
  let listener = null;
  const mediaQuery = {
    addEventListener(type, nextListener) {
      assert.equal(type, "change");
      listener = nextListener;
    },
    removeEventListener(type, nextListener) {
      assert.equal(type, "change");
      assert.equal(nextListener, listener);
      listener = null;
    },
  };
  let changes = 0;
  const unsubscribe = subscribeToSystemThemeChanges(mediaQuery, () => changes++);
  listener();
  assert.equal(changes, 1);
  unsubscribe();
  assert.equal(listener, null);
});
