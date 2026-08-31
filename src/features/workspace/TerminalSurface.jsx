import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

import {
  TERMINAL_WORD_SEPARATORS,
  clampSplitRatio,
  copyableTerminalSelection,
  flattenPaneLayout,
  nextTerminalFontZoomOffset,
  paneHasHorizontalSplitBelow,
  paneIds,
  parseOsc7Cwd,
  terminalFontSizeWithZoom,
  terminalPaneDropTarget,
} from "@/lib/terminalPanes";
import {
  DEFAULT_TERMINAL_SHORTCUTS,
  matchesTerminalShortcut,
  normalizeTerminalShortcuts,
  terminalShiftEnterSequence,
  terminalZoomDelta,
} from "@/lib/terminalShortcuts";
import { openExternalUrl } from "@/lib/externalLinks";
import {
  createTerminalFileLinkProvider,
  createTerminalLinkModifierController,
  isPrimaryTerminalLinkEvent,
} from "@/lib/terminalLinks";
import { terminalCellLetterSpacing } from "@/lib/terminalFonts";
import { useSynchronizedTheme } from "@/lib/theme";

const DARK_TERMINAL_THEME = {
  background: "#000000",
  foreground: "#f5f5f5",
  cursor: "#ffffff",
  cursorAccent: "#000000",
  selectionBackground: "rgba(59, 130, 246, 0.42)",
  selectionInactiveBackground: "rgba(59, 130, 246, 0.24)",
  selectionForeground: "#f8fafc",
  black: "#000000",
  red: "#bb0000",
  green: "#00bb00",
  yellow: "#bbbb00",
  blue: "#0000bb",
  magenta: "#bb00bb",
  cyan: "#00bbbb",
  white: "#bbbbbb",
  brightBlack: "#555555",
  brightRed: "#ff5555",
  brightGreen: "#55ff55",
  brightYellow: "#ffff55",
  brightBlue: "#5555ff",
  brightMagenta: "#ff55ff",
  brightCyan: "#55ffff",
  brightWhite: "#ffffff",
};

const LIGHT_TERMINAL_THEME = {
  background: "#fffefa",
  foreground: "#202124",
  cursor: "#202124",
  selectionBackground: "rgba(37, 99, 235, 0.28)",
  selectionInactiveBackground: "rgba(37, 99, 235, 0.16)",
  selectionForeground: "#111827",
};

const TERMINAL_SEARCH_OPTIONS = {
  caseSensitive: false,
  regex: false,
  wholeWord: false,
  decorations: {
    matchBackground: "#facc15",
    matchBorder: "#eab308",
    matchOverviewRuler: "#eab308",
    activeMatchBackground: "#3b82f6",
    activeMatchBorder: "#93c5fd",
    activeMatchColorOverviewRuler: "#3b82f6",
  },
};

function bytesFromChannel(payload) {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  return new Uint8Array(payload || []);
}

function percent(value) {
  return `${value * 100}%`;
}

function syncTerminalScrollbackState(terminal) {
  terminal.element?.classList.toggle(
    "terminal-has-scrollback",
    terminal.buffer.active.baseY > 0,
  );
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for webviews that expose the Clipboard API without granting access.
    }
  }

  const previouslyFocused = document.activeElement;
  const textarea = document.createElement("textarea");
  try {
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    Object.assign(textarea.style, {
      position: "fixed",
      opacity: "0",
      pointerEvents: "none",
    });
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
  } catch {
    // Copy on selection is intentionally silent when no clipboard path is available.
  } finally {
    textarea.remove();
    if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
      previouslyFocused.focus({ preventScroll: true });
    }
  }
}

function openTerminalWithConsistentFontMeasurement(terminal, host) {
  const isWebKit = /AppleWebKit/i.test(navigator.userAgent)
    && !/(Chrome|Chromium|Edg)/i.test(navigator.userAgent);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
  if (!isWebKit || !descriptor?.configurable) {
    terminal.open(host);
    return;
  }

  // xterm 6 prefers OffscreenCanvas for cell sizing, but WebKit can resolve a
  // different local font there than in xterm's DOM renderer. Temporarily hide
  // the API while xterm opens so its supported DOM measurement fallback is
  // selected; restore it immediately after the synchronous initialization.
  try {
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      configurable: true,
      value: undefined,
      writable: true,
    });
    terminal.open(host);
  } finally {
    Object.defineProperty(globalThis, "OffscreenCanvas", descriptor);
  }
}

function measureTerminalCharacterWidth(host, fontFamily, fontWeight, fontStyle, fontSize) {
  const probe = document.createElement("span");
  probe.textContent = "W".repeat(32);
  Object.assign(probe.style, {
    position: "absolute",
    visibility: "hidden",
    whiteSpace: "pre",
    letterSpacing: "0",
    fontFamily,
    fontWeight: String(fontWeight),
    fontStyle,
    fontSize: `${fontSize}px`,
    fontKerning: "none",
    fontVariantLigatures: "none",
  });
  host.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 32;
  probe.remove();
  return width;
}

function TerminalPane({
  tabId,
  pane,
  active,
  focused,
  titled,
  splitBelow,
  bounds,
  dragging,
  onMoveStart,
  searchOpen,
  onRequestSearch,
  onCloseSearch,
  copyOnSelection,
  shortcuts,
  effectiveTheme,
  fontFamily,
  fontWeight,
  fontStyle,
  fontSize,
  lineHeight,
  horizontalSpacing,
  scrollbackLines,
}) {
  const hostRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const searchRef = useRef(null);
  const serializeRef = useRef(null);
  const searchInputRef = useRef(null);
  const serializedStateRef = useRef("");
  const attachmentIdRef = useRef(null);
  const teardownRef = useRef(null);
  const transitionRef = useRef(Promise.resolve());
  const desiredActiveRef = useRef(active);
  const focusedRef = useRef(focused);
  const copyOnSelectionRef = useRef(copyOnSelection);
  const searchOpenRef = useRef(searchOpen);
  const searchQueryRef = useRef("");
  const requestSearchRef = useRef(onRequestSearch);
  const closeSearchRef = useRef(onCloseSearch);
  const shortcutsRef = useRef(shortcuts);
  const mountedRef = useRef(true);
  const startupReadyTimerRef = useRef(0);
  const [lifecycle, setLifecycle] = useState({ running: true, exitCode: null, error: "" });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState({ resultIndex: -1, resultCount: 0 });

  focusedRef.current = focused;
  copyOnSelectionRef.current = copyOnSelection;
  searchOpenRef.current = searchOpen;
  searchQueryRef.current = searchQuery;
  requestSearchRef.current = onRequestSearch;
  closeSearchRef.current = onCloseSearch;
  shortcutsRef.current = shortcuts;

  function search(term, direction = "next", incremental = false) {
    const searchAddon = searchRef.current;
    if (!searchAddon) return;
    if (!term) {
      searchAddon.clearDecorations();
      terminalRef.current?.clearSelection();
      setSearchResult({ resultIndex: -1, resultCount: 0 });
      return;
    }
    const options = { ...TERMINAL_SEARCH_OPTIONS, incremental };
    if (direction === "previous") searchAddon.findPrevious(term, options);
    else searchAddon.findNext(term, options);
  }

  function closeSearch() {
    closeSearchRef.current();
  }

  const attach = useCallback(async (terminal, fit, command = "terminal_attach") => {
    if (!terminal || !fit) return;
    fit.fit();
    let receivedOutput = false;
    const scheduleStartupReady = (delay) => {
      clearTimeout(startupReadyTimerRef.current);
      startupReadyTimerRef.current = window.setTimeout(() => {
        invoke("terminal_surface_ready", { tabId, paneId: pane.paneId }).catch(() => {});
      }, delay);
    };
    const onOutput = new Channel((payload) => {
      receivedOutput = true;
      terminal.write(bytesFromChannel(payload), () => scheduleStartupReady(50));
    });
    const onEvent = new Channel((event) => {
      if (event.type === "exited") {
        setLifecycle({ running: false, exitCode: event.exitCode, error: "" });
      } else if (event.type === "error") {
        setLifecycle((current) => ({ ...current, running: false, error: event.message }));
      }
    });
    setLifecycle({ running: true, exitCode: null, error: "" });
    const result = await invoke(command, {
      tabId,
      paneId: pane.paneId,
      cols: terminal.cols,
      rows: terminal.rows,
      onOutput,
      onEvent,
    });
    attachmentIdRef.current = result.attachmentId;
    // Interactive shells normally print a prompt. Keep a fallback for custom
    // shells with an empty prompt so a deferred terminal can still activate.
    if (!receivedOutput) scheduleStartupReady(1000);
  }, [pane.paneId, tabId]);

  async function createRenderer() {
    if (!hostRef.current || terminalRef.current) return;
    const terminal = new Terminal({
      // Search result highlighting uses xterm's decoration API, which remains
      // behind this flag in xterm 6 even when used by the official search addon.
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily,
      fontWeight,
      fontWeightBold: fontWeight < 700 ? 700 : 900,
      fontSize,
      linkHandler: {
        activate: (event, uri) => {
          if (isPrimaryTerminalLinkEvent(event)) void openExternalUrl(uri);
        },
      },
      lineHeight: lineHeight / 100,
      minimumContrastRatio: 4.5,
      scrollback: scrollbackLines,
      theme: effectiveTheme === "dark"
        ? DARK_TERMINAL_THEME
        : LIGHT_TERMINAL_THEME,
      wordSeparator: TERMINAL_WORD_SEPARATORS,
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    const serialize = new SerializeAddon();
    const webLinks = new WebLinksAddon((event, uri) => {
      if (isPrimaryTerminalLinkEvent(event)) void openExternalUrl(uri);
    });
    terminal.loadAddon(fit);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(serialize);
    terminal.loadAddon(webLinks);
    openTerminalWithConsistentFontMeasurement(terminal, hostRef.current);
    terminal.element.style.fontStyle = fontStyle;
    hostRef.current.style.fontStyle = fontStyle;
    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = searchAddon;
    serializeRef.current = serialize;
    const linkModifier = createTerminalLinkModifierController();
    const fileLinksDisposable = terminal.registerLinkProvider(createTerminalFileLinkProvider({
      terminal,
      linkModifier,
      shouldResolve: () => linkModifier.shouldResolveLinks(),
      resolvePaths: (candidates) => invoke("resolve_terminal_paths", {
        tabId,
        paneId: pane.paneId,
        candidates,
      }),
      openPath: (path) => invoke("open_terminal_path", {
        tabId,
        paneId: pane.paneId,
        path,
      }).catch(console.error),
    }));
    fit.fit();

    const characterWidth = measureTerminalCharacterWidth(
      hostRef.current,
      fontFamily,
      fontWeight,
      fontStyle,
      fontSize,
    );
    terminal.options.letterSpacing = terminalCellLetterSpacing(characterWidth, horizontalSpacing);
    if (serializedStateRef.current) {
      await new Promise((resolve) => terminal.write(serializedStateRef.current, resolve));
    }

    terminal.attachCustomKeyEventHandler((event) => {
      if (matchesTerminalShortcut(event, shortcutsRef.current.search)) {
        event.preventDefault();
        event.stopPropagation();
        if (searchOpenRef.current) {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        } else {
          requestSearchRef.current();
        }
        return false;
      }
      if (matchesTerminalShortcut(event, shortcutsRef.current.clear)) {
        event.preventDefault();
        event.stopPropagation();
        terminal.clear();
        syncTerminalScrollbackState(terminal);
        terminal.focus();
        return false;
      }
      const shiftEnterSequence = terminalShiftEnterSequence(event);
      if (shiftEnterSequence !== null) {
        event.preventDefault();
        event.stopPropagation();
        terminal.input(shiftEnterSequence);
        return false;
      }
      return true;
    });

    const searchResultDisposable = searchAddon.onDidChangeResults((result) => {
      setSearchResult(result);
    });
    const dataDisposable = terminal.onData((data) => {
      invoke("terminal_write", { tabId, paneId: pane.paneId, data }).catch(() => {});
    });
    const titleDisposable = terminal.onTitleChange((title) => {
      invoke("terminal_set_title", { tabId, paneId: pane.paneId, title }).catch(console.error);
    });
    const selectionDisposable = terminal.onSelectionChange(() => {
      if (!copyOnSelectionRef.current || !terminal.hasSelection()) return;
      const selection = copyableTerminalSelection(
        copyOnSelectionRef.current,
        terminal.getSelection(),
        searchOpenRef.current,
      );
      if (selection !== null) void copyTextToClipboard(selection);
    });
    const writeParsedDisposable = terminal.onWriteParsed(() => {
      syncTerminalScrollbackState(terminal);
    });
    const cwdDisposable = terminal.parser.registerOscHandler(7, (data) => {
      const cwd = parseOsc7Cwd(data);
      if (!cwd) return false;
      invoke("terminal_set_cwd", { tabId, paneId: pane.paneId, ...cwd }).catch(() => {});
      return true;
    });
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      syncTerminalScrollbackState(terminal);
      invoke("terminal_resize", {
        tabId,
        paneId: pane.paneId,
        cols: terminal.cols,
        rows: terminal.rows,
      }).catch(() => {});
    });
    resizeObserver.observe(hostRef.current);
    teardownRef.current = () => {
      clearTimeout(startupReadyTimerRef.current);
      resizeObserver.disconnect();
      searchResultDisposable.dispose();
      dataDisposable.dispose();
      titleDisposable.dispose();
      selectionDisposable.dispose();
      writeParsedDisposable.dispose();
      cwdDisposable.dispose();
      fileLinksDisposable.dispose();
      linkModifier.dispose();
      terminal.element?.classList.remove("terminal-has-scrollback");
    };

    syncTerminalScrollbackState(terminal);

    if (searchOpenRef.current && searchQueryRef.current) {
      searchAddon.findNext(searchQueryRef.current, { ...TERMINAL_SEARCH_OPTIONS, incremental: true });
    }

    if (pane.running === false && pane.exitCode !== null) {
      setLifecycle({ running: false, exitCode: pane.exitCode, error: "" });
      if (desiredActiveRef.current && focusedRef.current) {
        if (searchOpenRef.current) requestAnimationFrame(() => searchInputRef.current?.focus());
        else terminal.focus();
      }
      return;
    }
    try {
      await attach(terminal, fit);
    } catch (error) {
      if (terminalRef.current === terminal) {
        setLifecycle({ running: false, exitCode: null, error: error?.message || String(error) });
      }
    }
    // The focused prop can become true before an asynchronously-created
    // renderer exists. Restore focus once creation finishes so new tabs,
    // split panes, and reactivated terminal tabs accept input immediately.
    if (terminalRef.current === terminal && desiredActiveRef.current && focusedRef.current) {
      if (searchOpenRef.current) requestAnimationFrame(() => searchInputRef.current?.focus());
      else terminal.focus();
    }
  }

  async function disposeRenderer() {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const attachmentId = attachmentIdRef.current;
    if (attachmentId !== null) {
      await invoke("terminal_detach", {
        tabId,
        paneId: pane.paneId,
        attachmentId,
      }).catch(() => {});
    }
    await new Promise((resolve) => terminal.write("", resolve));
    if (terminalRef.current !== terminal) return;
    serializedStateRef.current = serializeRef.current?.serialize({ scrollback: scrollbackLines }) || "";
    teardownRef.current?.();
    teardownRef.current = null;
    terminal.dispose();
    terminalRef.current = null;
    fitRef.current = null;
    searchRef.current = null;
    serializeRef.current = null;
    attachmentIdRef.current = null;
  }

  useEffect(() => {
    desiredActiveRef.current = active;
    transitionRef.current = transitionRef.current.then(async () => {
      while (mountedRef.current && desiredActiveRef.current !== Boolean(terminalRef.current)) {
        if (desiredActiveRef.current) {
          await createRenderer();
          if (!terminalRef.current) break;
        } else {
          await disposeRenderer();
        }
      }
    }).catch(console.error);
  }, [active]);

  useEffect(() => () => {
    mountedRef.current = false;
    desiredActiveRef.current = false;
    transitionRef.current = transitionRef.current.then(disposeRenderer).catch(() => {});
  }, []);

  useEffect(() => {
    if (pane.running === false && pane.exitCode !== null) {
      setLifecycle({ running: false, exitCode: pane.exitCode, error: "" });
    }
  }, [pane.exitCode, pane.running]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = effectiveTheme === "dark"
      ? DARK_TERMINAL_THEME
      : LIGHT_TERMINAL_THEME;
    terminal.refresh(0, terminal.rows - 1);
  }, [effectiveTheme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit) return;
    terminal.element.style.fontStyle = fontStyle;
    hostRef.current.style.fontStyle = fontStyle;
    // Keep this value identical to the former CSS font-family input path.
    // WebKit's OffscreenCanvas can measure a different fallback when the
    // installed family is wrapped in an app-defined alias or extra quoting.
    terminal.options.fontFamily = fontFamily;
    terminal.options.fontWeight = fontWeight;
    terminal.options.fontWeightBold = fontWeight < 700 ? 700 : 900;
    terminal.options.fontSize = fontSize;
    terminal.options.lineHeight = lineHeight / 100;
    terminal.options.scrollback = scrollbackLines;
    const characterWidth = measureTerminalCharacterWidth(
      hostRef.current,
      fontFamily,
      fontWeight,
      fontStyle,
      fontSize,
    );
    terminal.options.letterSpacing = terminalCellLetterSpacing(characterWidth, horizontalSpacing);
    fit.fit();
    syncTerminalScrollbackState(terminal);
    terminal.refresh(0, terminal.rows - 1);
    invoke("terminal_resize", {
      tabId,
      paneId: pane.paneId,
      cols: terminal.cols,
      rows: terminal.rows,
    }).catch(() => {});
  }, [fontFamily, fontWeight, fontStyle, fontSize, lineHeight, horizontalSpacing, scrollbackLines, splitBelow, pane.paneId, tabId]);

  useEffect(() => {
    if (!focused) return;
    if (searchOpenRef.current) searchInputRef.current?.focus();
    else terminalRef.current?.focus();
  }, [focused]);

  useEffect(() => {
    if (searchOpen) {
      if (searchQuery) search(searchQuery, "next", true);
      const frame = requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return () => cancelAnimationFrame(frame);
    }
    searchRef.current?.clearDecorations();
    terminalRef.current?.clearSelection();
    setSearchResult({ resultIndex: -1, resultCount: 0 });
    if (focused) terminalRef.current?.focus();
    return undefined;
  }, [searchOpen]);

  function focus() {
    terminalRef.current?.focus();
    if (!focused) {
      invoke("focus_terminal_pane", { tabId, paneId: pane.paneId }).catch(console.error);
    }
  }

  async function restart() {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    terminal?.clear();
    if (terminal) syncTerminalScrollbackState(terminal);
    await attach(terminal, fit, "restart_terminal");
    focus();
  }

  return (
    <section
      className={`terminal-pane ${titled ? "terminal-pane-titled" : ""} ${splitBelow ? "terminal-pane-split-below" : ""} ${focused ? "terminal-pane-focused" : ""} ${dragging ? "terminal-pane-drag-source" : ""}`}
      onPointerDown={focus}
      data-pane-id={pane.paneId}
      style={{
        left: percent(bounds.left),
        top: percent(bounds.top),
        width: percent(bounds.width),
        height: percent(bounds.height),
      }}
    >
      {titled && (
        <div
          className="terminal-pane-title"
          title={`${pane.title} — drag to move pane`}
          onPointerDown={(event) => onMoveStart(event, pane.paneId)}
        >
          {pane.title}
        </div>
      )}
      <div ref={hostRef} className="terminal-host" />
      {searchOpen && (
        <div
          className="terminal-search"
          role="search"
          aria-label="Search terminal output"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            aria-label="Search terminal output"
            placeholder="Find"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              const value = event.target.value;
              setSearchQuery(value);
              searchQueryRef.current = value;
              search(value, "next", true);
            }}
            onKeyDown={(event) => {
              if (matchesTerminalShortcut(event, shortcuts.search)) {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.select();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeSearch();
              } else if (event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                search(searchQuery, event.shiftKey ? "previous" : "next");
              }
            }}
          />
          <span className="terminal-search-count" aria-live="polite">
            {searchResult.resultCount > 0 && searchResult.resultIndex >= 0
              ? `${searchResult.resultIndex + 1}/${searchResult.resultCount}`
              : searchResult.resultCount > 0 ? `–/${searchResult.resultCount}` : "0/0"}
          </span>
          <button
            type="button"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
            disabled={!searchQuery || searchResult.resultCount === 0}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => search(searchQuery, "previous")}
          >
            ↑
          </button>
          <button
            type="button"
            title="Next match (Enter)"
            aria-label="Next match"
            disabled={!searchQuery || searchResult.resultCount === 0}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => search(searchQuery, "next")}
          >
            ↓
          </button>
          <button
            type="button"
            title="Close search (Escape)"
            aria-label="Close search"
            onPointerDown={(event) => event.preventDefault()}
            onClick={closeSearch}
          >
            ×
          </button>
        </div>
      )}
      {!lifecycle.running && (
        <div className="terminal-exit-banner" role="status">
          <span>{lifecycle.error || `Process exited with code ${lifecycle.exitCode ?? 1}.`}</span>
          <button type="button" onClick={restart}>Restart</button>
          <button
            type="button"
            onClick={() => invoke("close_terminal_pane", { tabId, paneId: pane.paneId }).catch(console.error)}
          >
            Close
          </button>
        </div>
      )}
    </section>
  );
}

function TerminalDivider({ tabId, split, surfaceRef, onPreview }) {
  const frameRef = useRef(0);
  const pendingRatioRef = useRef(split.ratio);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  function startResize(event) {
    event.preventDefault();
    const surface = surfaceRef.current;
    if (!surface) return;
    const surfaceRect = surface.getBoundingClientRect();
    const rect = {
      left: surfaceRect.left + surfaceRect.width * split.left,
      top: surfaceRect.top + surfaceRect.height * split.top,
      width: surfaceRect.width * split.width,
      height: surfaceRect.height * split.height,
    };

    function ratioForPointer(pointerEvent) {
      const raw = split.axis === "columns"
        ? (pointerEvent.clientX - rect.left) / rect.width
        : (pointerEvent.clientY - rect.top) / rect.height;
      return clampSplitRatio(raw);
    }

    function move(pointerEvent) {
      pendingRatioRef.current = ratioForPointer(pointerEvent);
      if (frameRef.current) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0;
        onPreview(split.splitId, pendingRatioRef.current);
      });
    }

    function finish(pointerEvent) {
      move(pointerEvent);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      invoke("resize_terminal_split", {
        tabId,
        splitId: split.splitId,
        ratio: pendingRatioRef.current,
      }).catch(console.error);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  return (
    <div
      className={`terminal-divider terminal-divider-${split.axis}`}
      role="separator"
      aria-orientation={split.axis === "columns" ? "vertical" : "horizontal"}
      onPointerDown={startResize}
      style={split.axis === "columns" ? {
        left: percent(split.left + split.width * split.ratio),
        top: percent(split.top),
        height: percent(split.height),
      } : {
        left: percent(split.left),
        top: percent(split.top + split.height * split.ratio),
        width: percent(split.width),
      }}
    />
  );
}

const DEFAULT_TERMINAL_SETTINGS = {
  inactivePaneOpacity: 0.65,
  copyOnSelection: true,
  shortcuts: DEFAULT_TERMINAL_SHORTCUTS,
  typography: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontFace: null,
    fontWeight: 400,
    fontStyle: "normal",
    fontSize: 13,
    lineHeight: 100,
    horizontalSpacing: 100,
    scrollbackLines: 10_000,
  },
};

function normalizeTerminalSettings(settings = {}) {
  return {
    inactivePaneOpacity: settings.inactivePaneOpacity ?? 0.65,
    copyOnSelection: settings.copyOnSelection ?? true,
    shortcuts: normalizeTerminalShortcuts(settings.shortcuts),
    typography: {
      fontFamily: settings.fontFamily || DEFAULT_TERMINAL_SETTINGS.typography.fontFamily,
      fontFace: settings.fontFace || null,
      fontWeight: settings.fontWeight ?? 400,
      fontStyle: settings.fontStyle || "normal",
      fontSize: settings.fontSize ?? 13,
      lineHeight: settings.lineHeight ?? 100,
      horizontalSpacing: settings.horizontalSpacing ?? 100,
      scrollbackLines: settings.scrollbackLines ?? 10_000,
    },
  };
}

function TerminalTabSurface({
  tabId,
  layout,
  active,
  effectiveTheme,
  inactivePaneOpacity,
  copyOnSelection,
  shortcuts,
  typography,
  searchTarget,
  onRequestSearch,
  onCloseSearch,
}) {
  const [ratioOverrides, setRatioOverrides] = useState({});
  const [paneDrag, setPaneDrag] = useState(null);
  const surfaceRef = useRef(null);

  if (!layout) {
    return <main className={`terminal-surface ${active ? "terminal-surface-active" : "terminal-surface-inactive"}`} />;
  }

  const flattened = flattenPaneLayout(layout.root, ratioOverrides);
  const panesAreSplit = flattened.panes.length > 1;
  const previewPane = paneDrag?.targetPaneId
    ? flattened.panes.find(({ pane }) => pane.paneId === paneDrag.targetPaneId)
    : null;
  let previewBounds = previewPane ? {
    left: previewPane.left,
    top: previewPane.top,
    width: previewPane.width,
    height: previewPane.height,
  } : null;
  if (previewBounds && paneDrag.position === "left") {
    previewBounds.width /= 2;
  } else if (previewBounds && paneDrag.position === "right") {
    previewBounds.left += previewBounds.width / 2;
    previewBounds.width /= 2;
  } else if (previewBounds && paneDrag.position === "top") {
    previewBounds.height /= 2;
  } else if (previewBounds && paneDrag.position === "bottom") {
    previewBounds.top += previewBounds.height / 2;
    previewBounds.height /= 2;
  }

  function startPaneMove(event, sourcePaneId) {
    if (event.button !== 0 || !surfaceRef.current) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const dragHandle = event.currentTarget;
    let started = false;
    let currentDrop = null;
    try {
      dragHandle.setPointerCapture(pointerId);
    } catch {
      // Window-level listeners still provide a fallback when capture is unavailable.
    }

    function dropAt(pointerEvent) {
      const surface = surfaceRef.current;
      if (!surface) return null;
      const target = Array.from(surface.querySelectorAll(".terminal-pane")).find((element) => {
        if (element.dataset.paneId === sourcePaneId) return false;
        const rect = element.getBoundingClientRect();
        return pointerEvent.clientX >= rect.left
          && pointerEvent.clientX <= rect.right
          && pointerEvent.clientY >= rect.top
          && pointerEvent.clientY <= rect.bottom;
      });
      if (!target) return null;
      return terminalPaneDropTarget(
        sourcePaneId,
        target.dataset.paneId,
        target.getBoundingClientRect(),
        pointerEvent.clientX,
        pointerEvent.clientY,
      );
    }

    function move(pointerEvent) {
      if (!started && Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 5) return;
      started = true;
      pointerEvent.preventDefault();
      currentDrop = dropAt(pointerEvent);
      setPaneDrag((current) => {
        const next = { sourcePaneId, ...currentDrop };
        return current?.sourcePaneId === next.sourcePaneId
          && current?.targetPaneId === next.targetPaneId
          && current?.position === next.position
          ? current
          : next;
      });
    }

    function cleanup() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", keydown, true);
      try {
        if (dragHandle.hasPointerCapture(pointerId)) dragHandle.releasePointerCapture(pointerId);
      } catch {
        // Pointer capture may already have been released by the browser.
      }
      setPaneDrag(null);
    }

    function finish(pointerEvent) {
      if (started) currentDrop = dropAt(pointerEvent);
      cleanup();
      if (!started || !currentDrop) return;
      invoke("move_terminal_pane", {
        tabId,
        paneId: sourcePaneId,
        targetPaneId: currentDrop.targetPaneId,
        position: currentDrop.position,
      }).catch(console.error);
    }

    function cancel() {
      cleanup();
    }

    function keydown(keyEvent) {
      if (!started || keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      cancel();
    }

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", keydown, true);
  }

  return (
    <main
      ref={surfaceRef}
      className={`terminal-surface ${active ? "terminal-surface-active" : "terminal-surface-inactive"} ${paneDrag ? "terminal-surface-pane-dragging" : ""}`}
      aria-hidden={!active}
      style={{ "--inactive-pane-opacity": inactivePaneOpacity }}
    >
      {flattened.panes.map(({ pane, ...bounds }) => (
        <TerminalPane
          key={pane.paneId}
          tabId={tabId}
          pane={pane}
          active={active}
          bounds={bounds}
          focused={active && pane.paneId === layout.focusedPaneId}
          titled={panesAreSplit}
          splitBelow={paneHasHorizontalSplitBelow(bounds, flattened.splits)}
          dragging={pane.paneId === paneDrag?.sourcePaneId}
          onMoveStart={startPaneMove}
          searchOpen={searchTarget?.tabId === tabId && searchTarget?.paneId === pane.paneId}
          onRequestSearch={() => onRequestSearch(tabId, pane.paneId)}
          onCloseSearch={() => onCloseSearch(tabId, pane.paneId)}
          copyOnSelection={copyOnSelection}
          shortcuts={shortcuts}
          effectiveTheme={effectiveTheme}
          {...typography}
        />
      ))}
      {previewBounds && (
        <div
          className="terminal-pane-drop-preview"
          style={{
            left: percent(previewBounds.left),
            top: percent(previewBounds.top),
            width: percent(previewBounds.width),
            height: percent(previewBounds.height),
          }}
        />
      )}
      {flattened.splits.map((split) => (
        <TerminalDivider
          key={split.splitId}
          tabId={tabId}
          split={split}
          surfaceRef={surfaceRef}
          onPreview={(splitId, ratio) => setRatioOverrides((current) => ({ ...current, [splitId]: ratio }))}
        />
      ))}
    </main>
  );
}

export function TerminalWorkspace() {
  const effectiveTheme = useSynchronizedTheme();
  const [snapshot, setSnapshot] = useState({ tabs: [], activeTabId: "main" });
  const [layouts, setLayouts] = useState({});
  const [settings, setSettings] = useState(DEFAULT_TERMINAL_SETTINGS);
  const [searchTarget, setSearchTarget] = useState(null);
  const [fontZoomOffset, setFontZoomOffset] = useState(0);

  useEffect(() => {
    function handleFontZoom(event) {
      const delta = terminalZoomDelta(event, settings.shortcuts);
      if (delta === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setFontZoomOffset((current) => nextTerminalFontZoomOffset(
        settings.typography.fontSize,
        current,
        delta,
      ));
    }

    window.addEventListener("keydown", handleFontZoom, true);
    return () => window.removeEventListener("keydown", handleFontZoom, true);
  }, [settings.shortcuts, settings.typography.fontSize]);

  useEffect(() => {
    let disposed = false;
    let unlisten = null;
    async function subscribe() {
      unlisten = await listen("workspace-tabs-changed", ({ payload }) => {
        if (!disposed) setSnapshot(payload);
      });
      const next = await invoke("list_workspace_tabs");
      if (!disposed) setSnapshot(next);
    }
    subscribe().catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten = null;
    listen("terminal-layout-changed", ({ payload }) => {
      if (!disposed) {
        setLayouts((current) => ({ ...current, [payload.tabId]: payload }));
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten = null;
    async function subscribe() {
      unlisten = await listen("terminal-settings-changed", ({ payload }) => {
        if (!disposed) setSettings(normalizeTerminalSettings(payload));
      });
      const next = await invoke("list_terminal_settings");
      if (!disposed) setSettings(normalizeTerminalSettings(next));
    }
    subscribe().catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const terminalTabs = snapshot.tabs.filter((tab) => tab.kind === "terminal");
  const terminalTabIds = terminalTabs.map((tab) => tab.id);
  const terminalTabKey = terminalTabIds.join("\0");
  const typography = {
    ...settings.typography,
    fontSize: terminalFontSizeWithZoom(settings.typography.fontSize, fontZoomOffset),
  };

  useEffect(() => {
    if (!searchTarget) return;
    const layout = layouts[searchTarget.tabId];
    const tabExists = terminalTabIds.includes(searchTarget.tabId);
    const paneExists = !layout || paneIds(layout.root).includes(searchTarget.paneId);
    if (!tabExists || !paneExists) setSearchTarget(null);
  }, [layouts, searchTarget, terminalTabKey]);

  useEffect(() => {
    let disposed = false;
    const activeIds = new Set(terminalTabIds);
    setLayouts((current) => Object.fromEntries(
      Object.entries(current).filter(([tabId]) => activeIds.has(tabId)),
    ));
    Promise.all(terminalTabIds.map((tabId) => invoke("get_terminal_layout", { tabId })))
      .then((nextLayouts) => {
        if (disposed) return;
        setLayouts((current) => ({
          ...current,
          ...Object.fromEntries(nextLayouts.map((layout) => [layout.tabId, layout])),
        }));
      })
      .catch(console.error);
    return () => { disposed = true; };
  }, [terminalTabKey]);

  return (
    <div className="terminal-workspace">
      {terminalTabs.map((tab) => (
        <TerminalTabSurface
          key={tab.id}
          tabId={tab.id}
          layout={layouts[tab.id] || null}
          active={tab.id === snapshot.activeTabId}
          effectiveTheme={effectiveTheme}
          searchTarget={searchTarget}
          onRequestSearch={(tabId, paneId) => setSearchTarget({ tabId, paneId })}
          onCloseSearch={(tabId, paneId) => setSearchTarget((current) => (
            current?.tabId === tabId && current?.paneId === paneId ? null : current
          ))}
          {...settings}
          typography={typography}
        />
      ))}
    </div>
  );
}
