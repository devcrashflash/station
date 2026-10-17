import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  createTerminalFileDropController,
  formatTerminalDropPaths,
  terminalDropPoint,
  terminalFileDropTarget,
} from "./terminalFileDrop.js";

test("POSIX paths round-trip as literal arguments, preserving order and spelling", () => {
  const paths = [
    "/tmp/image.png", "/tmp/a folder/", "/tmp/üñîçødé's image.jpg",
    '/tmp/$HOME`whoami`$(whoami);&|*?[x]~!"', "/tmp/link/../target", "/tmp/back\\slash",
  ];
  for (const shell of ["sh", "bash", "zsh", "dash", "ksh", "ash"]) {
    const text = formatTerminalDropPaths(paths, `/bin/${shell}`);
    assert.ok(text.endsWith(" "));
    const actual = execFileSync("/bin/sh", ["-c", `printf '%s\\0' ${text}`], { encoding: "utf8" });
    assert.deepEqual(actual.split("\0").slice(0, -1), paths);
    assert.equal(/[\r\n]/.test(text), false);
  }
});

test("fish and PowerShell use their own literal quote escapes", () => {
  assert.equal(formatTerminalDropPaths(["/tmp/a'b\\c"], "/usr/bin/fish"), "'/tmp/a\\'b\\\\c' ");
  for (const shell of ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "pwsh"]) {
    assert.equal(formatTerminalDropPaths(["C:\\a'b\\$test`file.png"], shell), "'C:\\a''b\\$test`file.png' ");
  }
});

test("cmd quotes Windows drive and UNC paths and refuses variable expansion", () => {
  assert.equal(formatTerminalDropPaths(["C:\\a b\\x&y.png", "\\\\host\\share\\file"], "cmd.exe"),
    '"C:\\a b\\x&y.png" "\\\\host\\share\\file" ');
  assert.equal(formatTerminalDropPaths(["C:\\a b\\"], "cmd.exe"), '"C:\\a b\\\\" ');
  for (const path of ['C:\\a"b', "C:\\%PATH%", "C:\\!PATH!"]) {
    assert.throws(() => formatTerminalDropPaths([path], "cmd.exe"), /Cannot safely drop/);
  }
});

test("invalid paths reject the whole drop without terminal control injection", () => {
  for (const value of ["/tmp/a\nb", "/tmp/a\rb", "/tmp/a\x1bb", "/tmp/a\0b", "/tmp/a\x7fb", "/tmp/a\x9bb", "relative.png", "https://host/x", "file:///tmp/x", "", null]) {
    assert.throws(() => formatTerminalDropPaths(["/tmp/valid", value], "bash"));
  }
  assert.equal(formatTerminalDropPaths([], "bash"), null);
  assert.throws(() => formatTerminalDropPaths(["/tmp/x"], null), /not ready/);
  assert.throws(() => formatTerminalDropPaths(["/tmp/x"], "unknown"), /not supported/);
});

function fixture() {
  const hits = [{}, {}];
  const classes = [new Set(), new Set()];
  const pastes = [[], []];
  const focused = [];
  const errors = [];
  let activeTabId = "tab";
  const targets = hits.map((hit, i) => ({
    tabId: "tab", active: true, running: true, ready: true, shell: "/bin/zsh",
    host: {
      isConnected: true,
      contains: (element) => element === hit,
      getBoundingClientRect: () => ({ left: i * 100, top: 20, right: (i + 1) * 100, bottom: 200 }),
      classList: { add: (value) => classes[i].add(value), remove: (value) => classes[i].delete(value) },
    },
    terminal: { paste: (text) => pastes[i].push(text) },
    focus: () => focused.push(i),
  }));
  const controller = createTerminalFileDropController({
    getTargets: () => targets,
    getActiveTabId: () => activeTabId,
    getScaleFactor: () => 2,
    elementFromPoint: (x, y) => y >= 20 && y < 200 ? hits[Math.floor(x / 100)] : null,
    onError: (error) => errors.push(error),
  });
  const event = (type, extra = {}) => controller.handle({ type, position: { x: 300, y: 100 }, ...extra });
  return { controller, event, targets, hits, classes, pastes, focused, errors, setTab: (id) => { activeTabId = id; } };
}

test("physical coordinates convert at different display scales", () => {
  assert.deepEqual(terminalDropPoint({ x: 300, y: 100 }, 2), { x: 150, y: 50 });
  assert.deepEqual(terminalDropPoint({ x: 150, y: 75 }, 1.5), { x: 100, y: 50 });
  for (const scale of [0, -1, NaN, Infinity]) assert.equal(terminalDropPoint({ x: 1, y: 1 }, scale), null);
  assert.equal(terminalDropPoint(null, 1), null);
  assert.equal(terminalDropPoint({ x: NaN, y: 1 }, 1), null);
});

test("drop focuses the pane under the pointer and pastes once without Enter", () => {
  const f = fixture();
  f.event("enter", { paths: ["/tmp/image.png", "/tmp/folder"] });
  assert.equal(f.classes[1].has("terminal-file-drop-hover"), true);
  f.event("drop", { paths: ["/tmp/image.png", "/tmp/folder"] });
  assert.deepEqual(f.focused, [1]);
  assert.deepEqual(f.pastes, [[], ["'/tmp/image.png' '/tmp/folder' "]]);
  assert.equal(f.classes[1].size, 0);
  f.event("drop", { paths: ["/tmp/image.png"] });
  assert.equal(f.pastes[1].length, 2, "a second intentional drop is accepted immediately");
});

test("hover moves between panes and leave/cancellation/disposal clear it", () => {
  const f = fixture();
  f.event("enter", { paths: ["/tmp/x"] });
  f.event("over", { position: { x: 100, y: 100 } });
  assert.equal(f.classes[1].size, 0);
  assert.equal(f.classes[0].size, 1);
  f.event("leave");
  assert.equal(f.classes[0].size, 0);
  f.event("drop");
  assert.deepEqual(f.focused, []);
  f.event("enter", { paths: ["/tmp/x"] });
  f.controller.reset();
  assert.equal(f.classes[1].size, 0);
});

test("drop falls back to enter paths when native drop reports no paths", () => {
  const f = fixture();
  f.event("enter", { paths: ["/tmp/x"] });
  f.event("drop", { paths: [] });
  assert.deepEqual(f.pastes[1], ["'/tmp/x' "]);
  f.event("drop", { paths: [] });
  assert.equal(f.pastes[1].length, 1);
});

test("tab switches, exited/removed/unready panes and resized bounds cannot redirect a drop", () => {
  for (const change of [
    (f) => f.setTab("other"),
    (f) => { f.targets[1].running = false; },
    (f) => { f.targets[1].active = false; },
    (f) => { f.targets[1].ready = false; },
    (f) => { f.targets[1].host.isConnected = false; },
    (f) => { f.targets[1].host.getBoundingClientRect = () => ({ left: 0, right: 50, top: 0, bottom: 50 }); },
  ]) {
    const f = fixture();
    f.event("enter", { paths: ["/tmp/x"] });
    change(f);
    f.event("drop", { paths: ["/tmp/x"] });
    assert.deepEqual(f.focused, []);
    assert.deepEqual(f.pastes, [[], []]);
    assert.equal(f.classes[1].size, 0);
  }
});

test("titles, search controls, dividers and overlays outside the host are excluded", () => {
  const f = fixture();
  assert.equal(terminalFileDropTarget(f.targets, { x: 150, y: 50 }, {}, "tab"), null);
  f.event("drop", { paths: ["/tmp/x"], position: { x: 300, y: 10 } });
  assert.deepEqual(f.focused, []);
  assert.equal(terminalFileDropTarget(f.targets, { x: 150, y: 50 }, f.hits[1], "tab"), f.targets[1]);
});

test("over events after a tab switch cannot re-enable a pending drop in another tab", () => {
  const f = fixture();
  f.event("enter", { paths: ["/tmp/x"] });
  f.setTab("other");
  f.targets[1].tabId = "other";
  f.event("over");
  f.event("over");
  f.event("drop", { paths: ["/tmp/x"] });
  assert.deepEqual(f.focused, []);
  assert.equal(f.classes[1].size, 0);
  f.event("enter", { paths: ["/tmp/y"] });
  f.event("drop", { paths: ["/tmp/y"] });
  assert.deepEqual(f.pastes[1], ["'/tmp/y' "]);
});

test("unsafe paths report an error without focusing or partially pasting", () => {
  const f = fixture();
  f.event("enter", { paths: ["/tmp/x", "/tmp/x\nexit"] });
  f.event("drop", { paths: ["/tmp/x", "/tmp/x\nexit"] });
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.focused, []);
  assert.deepEqual(f.pastes, [[], []]);
  assert.equal(f.classes[1].size, 0);
});
