import test from "node:test";
import assert from "node:assert/strict";
import { defaultQuickstartRules, validateQuickstartRules, canHandleQuickstartShortcut, clearQuickstartDismissalOnDirectoryChange } from "./terminalQuickstart.js";
import { defaultTerminalShortcuts, matchesTerminalShortcut, normalizeTerminalShortcuts, terminalShortcutConflict } from "./terminalShortcuts.js";
import { api } from "./api.js";

test("Quickstart settings preserve empty lists, custom rules, and unrelated settings", async () => {
  let stored = "";
  global.localStorage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
  assert.deepEqual((await api.listTerminalSettings()).quickstartRules, defaultQuickstartRules());
  await api.saveTerminalSettings({ quickstartRules: [], newTabDirectory: "/app", fontSize: 16 });
  assert.deepEqual((await api.listTerminalSettings()).quickstartRules, []);
  await api.saveTerminalSettings({ copyOnSelection: false });
  assert.deepEqual((await api.listTerminalSettings()).quickstartRules, []);
  const custom = [{ ...defaultQuickstartRules()[0], name: "Custom", paths: ["app", "package.json"], matchMode: "all", position: "bottom", command: "npm run dev" }];
  await api.saveTerminalSettings({ quickstartRules: custom, fontSize: 16, newTabDirectory: "/app" });
  const saved = await api.listTerminalSettings();
  assert.deepEqual(saved.quickstartRules, custom);
  assert.equal(saved.fontSize, 16);
  assert.equal(saved.newTabDirectory, "/app");
  await assert.rejects(api.saveTerminalSettings({ quickstartRules: [{ ...custom[0], paths: ["../elsewhere"] }] }), /relative paths/);
  assert.deepEqual((await api.listTerminalSettings()).quickstartRules, custom);
});

test("Quickstart rejects incomplete rules, duplicate IDs, and escaping paths", () => {
  const rule = defaultQuickstartRules()[0];
  assert.deepEqual(validateQuickstartRules([]), []);
  for (const patch of [{ name: " " }, { command: "" }, { command: "a\0b" }, { paths: [] }, { paths: [""] }, { paths: ["/tmp"] }, { paths: ["C:\\app"] }, { paths: ["a/../b"] }, { paths: ["a\\..\\b"] }, { paths: ["~/app"] }, { matchMode: "invalid" }, { position: "invalid" }]) {
    assert.throws(() => validateQuickstartRules([{ ...rule, ...patch }]));
  }
  assert.throws(() => validateQuickstartRules([rule, rule]), /unique IDs/);
  assert.equal(validateQuickstartRules([{ ...rule, paths: ["public/index.php", "a directory"], matchMode: "all" }]).length, 1);
});

test("Quickstart shortcut is platform aware and participates in conflicts", () => {
  const shortcuts = defaultTerminalShortcuts("MacIntel");
  const event = { type: "keydown", code: "KeyS", metaKey: true };
  assert.equal(matchesTerminalShortcut(event, shortcuts.quickstart, "MacIntel"), true);
  assert.equal(matchesTerminalShortcut({ ...event, metaKey: false, ctrlKey: true }, shortcuts.quickstart, "Win32"), true);
  assert.equal(terminalShortcutConflict({ ...shortcuts, search: shortcuts.quickstart }, "MacIntel").otherAction, "quickstart");
});

test("Quickstart shortcut only handles terminal input and ignores repeat/editable UI", () => {
  const input = (className) => ({ classList: { contains: (value) => value === className } });
  const terminal = { target: input("xterm-helper-textarea") };
  assert.equal(canHandleQuickstartShortcut(terminal, true), true);
  assert.equal(canHandleQuickstartShortcut(terminal, false), false);
  assert.equal(canHandleQuickstartShortcut({ ...terminal, repeat: true }, true), false);
  assert.equal(canHandleQuickstartShortcut({ ...terminal, defaultPrevented: true }, true), false);
  for (const className of ["", "terminal-search-input", "settings-input"]) {
    assert.equal(canHandleQuickstartShortcut({ target: input(className) }, true), false);
  }
  assert.equal(canHandleQuickstartShortcut({}, true), false);
});

test("legacy assignments to Cmd/Ctrl+S survive the Quickstart migration", () => {
  for (const platform of ["MacIntel", "Win32", "Linux x86_64"]) {
    const shortcuts = normalizeTerminalShortcuts({ search: "CommandOrControl+KeyS" }, platform);
    assert.equal(shortcuts.search, "CommandOrControl+KeyS");
    assert.equal(shortcuts.quickstart, "CommandOrControl+Shift+KeyS");
    assert.equal(terminalShortcutConflict(shortcuts, platform), null);
  }
});

test("Docker defaults include all four Compose filenames", () => {
  const docker = defaultQuickstartRules()[0];
  assert.equal(docker.matchMode, "any");
  assert.equal(docker.command, "docker compose up");
  assert.deepEqual([...docker.paths].sort(), ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]);
});

test("saved legacy Compose defaults migrate once without changing custom rules", async () => {
  const legacy = defaultQuickstartRules();
  legacy[0].paths = ["docker-compose.yml", "compose.yml"];
  const custom = { ...legacy[0], id: "custom-docker", command: "docker compose up -d" };
  let stored = JSON.stringify({ terminalSettings: { quickstartRules: [...legacy, custom] } });
  global.localStorage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
  assert.deepEqual((await api.listTerminalSettings()).quickstartRules, [...defaultQuickstartRules(), custom]);
  assert.deepEqual(JSON.parse(stored).terminalSettings.quickstartRules, [...defaultQuickstartRules(), custom]);
  await api.saveTerminalSettings({ quickstartRules: legacy });
  assert.deepEqual((await api.listTerminalSettings()).quickstartRules, legacy);
  await api.saveTerminalSettings({ quickstartRules: [] });
  assert.deepEqual((await api.listTerminalSettings()).quickstartRules, []);
  stored = JSON.stringify({ terminalSettings: { quickstartRules: [custom] } });
  assert.deepEqual((await api.listTerminalSettings()).quickstartRules, [custom]);
  stored = JSON.stringify({ terminalSettings: { quickstartRules: [] } });
  assert.deepEqual((await api.listTerminalSettings()).quickstartRules, []);
});

test("dismissal resets on every directory change, including directories without matching rules", () => {
  const dismissed = { tab: { cwd: "/project-a", paneId: "pane" }, other: { cwd: "/other", paneId: "other-pane" } };
  assert.equal(clearQuickstartDismissalOnDirectoryChange(dismissed, null), dismissed);
  assert.equal(clearQuickstartDismissalOnDirectoryChange(dismissed, { tabId: "tab", cwd: "/project-a", rules: [] }), dismissed);
  const afterLeaving = clearQuickstartDismissalOnDirectoryChange(dismissed, { tabId: "tab", cwd: "/no-matches", rules: [] });
  assert.equal(afterLeaving.tab, undefined);
  assert.deepEqual(afterLeaving.other, dismissed.other);
  const afterReturning = clearQuickstartDismissalOnDirectoryChange(afterLeaving, { tabId: "tab", cwd: "/project-a", rules: defaultQuickstartRules() });
  assert.equal(afterReturning.tab, undefined);
  assert.equal(clearQuickstartDismissalOnDirectoryChange(dismissed, { tabId: "tab", cwd: "/project-b", rules: defaultQuickstartRules() }).tab, undefined);
  assert.equal(dismissed.tab.cwd, "/project-a");
});

test("absolute directory conditions require a trailing separator and keep the existing settings shape", async () => {
  const conditions = ["/Users/alex/Projects/alexander/", "/Users/alex/Projects/*/", "/Users/alex/Projects/**/", "/", "C:/Projects/*/", "C:\\Projects\\**\\", "\\\\server\\share\\Projects\\*\\"];
  for (const path of conditions) {
    const rule = { ...defaultQuickstartRules()[0], paths: [path], matchMode: "all" };
    assert.deepEqual(validateQuickstartRules([rule]), [rule]);
  }
  for (const path of ["/Users/alex/Projects/alexander", "/tmp/config.json", "C:/Projects/app", "C:\\Projects\\app", "\\\\server\\share\\file", "\\rooted\\", "/Projects/../app/", "~/Projects/", "/Projects/\0/"]) {
    assert.throws(() => validateQuickstartRules([{ ...defaultQuickstartRules()[0], paths: [path] }]), path);
  }
  let stored = "";
  global.localStorage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
  const rule = { ...defaultQuickstartRules()[0], paths: ["/Users/alex/Projects/**/", "compose.yaml"], matchMode: "all" };
  await api.saveTerminalSettings({ quickstartRules: [rule] });
  assert.deepEqual((await api.listTerminalSettings()).quickstartRules, [rule]);
  await assert.rejects(api.saveTerminalSettings({ quickstartRules: [{ ...rule, paths: ["/Users/alex/Projects/file"] }] }), /Absolute file checks/);
  assert.deepEqual((await api.listTerminalSettings()).quickstartRules, [rule]);
});
