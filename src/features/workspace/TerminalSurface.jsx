import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { clampSplitRatio, flattenPaneLayout, isTerminalClearShortcut, parseOsc7Cwd } from "@/lib/terminalPanes";
import { terminalCellLetterSpacing } from "@/lib/terminalFonts";

const DARK_TERMINAL_THEME = {
  background: "#000000",
  foreground: "#f5f5f5",
  cursor: "#ffffff",
  cursorAccent: "#000000",
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
};

function bytesFromChannel(payload) {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  return new Uint8Array(payload || []);
}

function percent(value) {
  return `${value * 100}%`;
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

function TerminalPane({ tabId, pane, focused, titled, bounds, fontFamily, fontWeight, fontStyle, fontSize, lineHeight, horizontalSpacing }) {
  const hostRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const [lifecycle, setLifecycle] = useState({ running: true, exitCode: null, error: "" });

  const attach = useCallback(async (command = "terminal_attach") => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit) return;
    fit.fit();
    const onOutput = new Channel((payload) => terminal.write(bytesFromChannel(payload)));
    const onEvent = new Channel((event) => {
      if (event.type === "exited") {
        setLifecycle({ running: false, exitCode: event.exitCode, error: "" });
      } else if (event.type === "error") {
        setLifecycle((current) => ({ ...current, running: false, error: event.message }));
      }
    });
    setLifecycle({ running: true, exitCode: null, error: "" });
    await invoke(command, {
      tabId,
      paneId: pane.paneId,
      cols: terminal.cols,
      rows: terminal.rows,
      onOutput,
      onEvent,
    });
  }, [pane.paneId, tabId]);

  useEffect(() => {
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontWeight: 400,
      fontWeightBold: 700,
      fontSize: 13,
      minimumContrastRatio: 4.5,
      scrollback: 10_000,
      theme: document.documentElement.classList.contains("dark")
        ? DARK_TERMINAL_THEME
        : LIGHT_TERMINAL_THEME,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    openTerminalWithConsistentFontMeasurement(terminal, hostRef.current);
    terminal.element.style.fontStyle = "normal";
    terminalRef.current = terminal;
    fitRef.current = fit;
    fit.fit();

    terminal.attachCustomKeyEventHandler((event) => {
      if (!isTerminalClearShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      terminal.clear();
      terminal.focus();
      return false;
    });

    const dataDisposable = terminal.onData((data) => {
      invoke("terminal_write", { tabId, paneId: pane.paneId, data }).catch(() => {});
    });
    const titleDisposable = terminal.onTitleChange((title) => {
      invoke("terminal_set_title", { tabId, paneId: pane.paneId, title }).catch(console.error);
    });
    const cwdDisposable = terminal.parser.registerOscHandler(7, (data) => {
      const cwd = parseOsc7Cwd(data);
      if (!cwd) return false;
      invoke("terminal_set_cwd", { tabId, paneId: pane.paneId, ...cwd }).catch(() => {});
      return true;
    });
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      invoke("terminal_resize", {
        tabId,
        paneId: pane.paneId,
        cols: terminal.cols,
        rows: terminal.rows,
      }).catch(() => {});
    });
    resizeObserver.observe(hostRef.current);
    attach().catch((error) => setLifecycle({ running: false, exitCode: null, error: error?.message || String(error) }));

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      titleDisposable.dispose();
      cwdDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [attach, pane.paneId, tabId]);

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
    const characterWidth = measureTerminalCharacterWidth(
      hostRef.current,
      fontFamily,
      fontWeight,
      fontStyle,
      fontSize,
    );
    terminal.options.letterSpacing = terminalCellLetterSpacing(characterWidth, horizontalSpacing);
    fit.fit();
    terminal.refresh(0, terminal.rows - 1);
    invoke("terminal_resize", {
      tabId,
      paneId: pane.paneId,
      cols: terminal.cols,
      rows: terminal.rows,
    }).catch(() => {});
  }, [fontFamily, fontWeight, fontStyle, fontSize, lineHeight, horizontalSpacing, pane.paneId, tabId]);

  useEffect(() => {
    if (focused) terminalRef.current?.focus();
  }, [focused]);

  function focus() {
    terminalRef.current?.focus();
    if (!focused) {
      invoke("focus_terminal_pane", { tabId, paneId: pane.paneId }).catch(console.error);
    }
  }

  async function restart() {
    terminalRef.current?.clear();
    await attach("restart_terminal");
    focus();
  }

  return (
    <section
      className={`terminal-pane ${titled ? "terminal-pane-titled" : ""} ${focused ? "terminal-pane-focused" : ""}`}
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
        <div className="terminal-pane-title" title={pane.title}>
          {pane.title}
        </div>
      )}
      <div ref={hostRef} className="terminal-host" />
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

export function TerminalSurface({ tabId }) {
  const [layout, setLayout] = useState(null);
  const [ratioOverrides, setRatioOverrides] = useState({});
  const [inactivePaneOpacity, setInactivePaneOpacity] = useState(0.65);
  const [typography, setTypography] = useState({
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontFace: null,
    fontWeight: 400,
    fontStyle: "normal",
    fontSize: 13,
    lineHeight: 100,
    horizontalSpacing: 100,
  });
  const surfaceRef = useRef(null);

  useEffect(() => {
    let disposed = false;
    let unlisten = null;
    listen("terminal-settings-changed", ({ payload }) => {
      if (!disposed) {
        setInactivePaneOpacity(payload.inactivePaneOpacity ?? 0.65);
        setTypography({
          fontFamily: payload.fontFamily || "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontFace: payload.fontFace || null,
          fontWeight: payload.fontWeight ?? 400,
          fontStyle: payload.fontStyle || "normal",
          fontSize: payload.fontSize ?? 13,
          lineHeight: payload.lineHeight ?? 100,
          horizontalSpacing: payload.horizontalSpacing ?? 100,
        });
      }
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
      invoke("list_terminal_settings").then((settings) => {
        if (!disposed) {
          setInactivePaneOpacity(settings.inactivePaneOpacity ?? 0.65);
          setTypography({
            fontFamily: settings.fontFamily || "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontFace: settings.fontFace || null,
            fontWeight: settings.fontWeight ?? 400,
            fontStyle: settings.fontStyle || "normal",
            fontSize: settings.fontSize ?? 13,
            lineHeight: settings.lineHeight ?? 100,
            horizontalSpacing: settings.horizontalSpacing ?? 100,
          });
        }
      }).catch(console.error);
    }).catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten = null;
    listen("terminal-layout-changed", ({ payload }) => {
      if (!disposed && payload.tabId === tabId) setLayout(payload);
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
      invoke("get_terminal_layout", { tabId }).then((next) => {
        if (!disposed) setLayout(next);
      }).catch(console.error);
    }).catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [tabId]);

  if (!layout) return <main className="terminal-surface" />;

  const flattened = flattenPaneLayout(layout.root, ratioOverrides);
  const panesAreSplit = flattened.panes.length > 1;

  return (
    <main
      ref={surfaceRef}
      className="terminal-surface"
      style={{ "--inactive-pane-opacity": inactivePaneOpacity }}
    >
      {flattened.panes.map(({ pane, ...bounds }) => (
        <TerminalPane
          key={pane.paneId}
          tabId={tabId}
          pane={pane}
          bounds={bounds}
          focused={pane.paneId === layout.focusedPaneId}
          titled={panesAreSplit}
          {...typography}
        />
      ))}
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
