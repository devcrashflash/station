import { useCallback, useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";

export const THEME_STORAGE_KEY = "dcf-theme-preference-v1";
export const THEME_CHANGED_EVENT = "app-theme-changed";
export const THEME_PREFERENCES = ["system", "light", "dark"];

export function normalizeThemePreference(value) {
  return THEME_PREFERENCES.includes(value) ? value : "system";
}

export function resolveTheme(preference, systemPrefersDark) {
  const normalized = normalizeThemePreference(preference);
  return normalized === "system" ? (systemPrefersDark ? "dark" : "light") : normalized;
}

export function readThemePreference(storage = globalThis.localStorage) {
  try {
    return normalizeThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function writeThemePreference(preference, storage = globalThis.localStorage) {
  const normalized = normalizeThemePreference(preference);
  try {
    storage?.setItem(THEME_STORAGE_KEY, normalized);
  } catch {
    // Theme changes still apply for this session when storage is unavailable.
  }
  return normalized;
}

export function applyDocumentTheme(theme, documentRef = globalThis.document) {
  const effectiveTheme = theme === "dark" ? "dark" : "light";
  documentRef?.documentElement?.classList.toggle("dark", effectiveTheme === "dark");
  if (documentRef?.documentElement?.style) {
    documentRef.documentElement.style.colorScheme = effectiveTheme;
  }
  return effectiveTheme;
}

export function themeFromChangePayload(payload) {
  return payload?.effectiveTheme === "dark" || payload?.effectiveTheme === "light"
    ? payload.effectiveTheme
    : null;
}

export function applyThemeChangePayload(payload, documentRef = globalThis.document) {
  const effectiveTheme = themeFromChangePayload(payload);
  return effectiveTheme ? applyDocumentTheme(effectiveTheme, documentRef) : null;
}

function systemPrefersDark(windowRef = globalThis.window) {
  return Boolean(windowRef?.matchMedia?.("(prefers-color-scheme: dark)").matches);
}

export function initializeTheme({ storage = globalThis.localStorage, windowRef = globalThis.window, documentRef = globalThis.document } = {}) {
  const preference = readThemePreference(storage);
  return applyDocumentTheme(resolveTheme(preference, systemPrefersDark(windowRef)), documentRef);
}

export function subscribeToSystemThemeChanges(mediaQuery, onChange) {
  mediaQuery.addEventListener?.("change", onChange);
  return () => mediaQuery.removeEventListener?.("change", onChange);
}

async function applyNativeTheme(preference) {
  if (!globalThis.window?.__TAURI_INTERNALS__) return;
  try {
    const { setTheme } = await import("@tauri-apps/api/app");
    await setTheme(preference === "system" ? null : preference);
  } catch (error) {
    console.warn("Could not apply the native window theme.", error);
  }
}

async function emitThemeChange(effectiveTheme) {
  if (!globalThis.window?.__TAURI_INTERNALS__) return;
  try {
    await emit(THEME_CHANGED_EVENT, { effectiveTheme });
  } catch (error) {
    console.warn("Could not synchronize the app theme.", error);
  }
}

export function useSynchronizedTheme() {
  const [effectiveTheme, setEffectiveTheme] = useState(() => (
    resolveTheme(readThemePreference(), systemPrefersDark())
  ));

  useEffect(() => {
    let disposed = false;
    let unlisten = null;

    async function subscribe() {
      if (!globalThis.window?.__TAURI_INTERNALS__) return;
      const dispose = await listen(THEME_CHANGED_EVENT, ({ payload }) => {
        if (disposed) return;
        const nextTheme = applyThemeChangePayload(payload);
        if (nextTheme) setEffectiveTheme(nextTheme);
      });
      if (disposed) dispose();
      else unlisten = dispose;
    }

    applyDocumentTheme(effectiveTheme);
    subscribe().catch((error) => {
      console.warn("Could not subscribe to app theme changes.", error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return effectiveTheme;
}

export function useTheme() {
  const [preference, setStoredPreference] = useState(() => readThemePreference());
  const [effectiveTheme, setEffectiveTheme] = useState(() => (
    resolveTheme(preference, systemPrefersDark())
  ));

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    function applyTheme() {
      const nextTheme = resolveTheme(preference, mediaQuery.matches);
      applyDocumentTheme(nextTheme);
      setEffectiveTheme(nextTheme);
      void emitThemeChange(nextTheme);
    }

    applyTheme();
    applyNativeTheme(preference);

    if (preference !== "system") return undefined;
    return subscribeToSystemThemeChanges(mediaQuery, applyTheme);
  }, [preference]);

  const setPreference = useCallback((nextPreference) => {
    const normalized = writeThemePreference(nextPreference);
    setStoredPreference(normalized);
  }, []);

  return { preference, effectiveTheme, setPreference };
}
