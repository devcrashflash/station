import test from "node:test";
import assert from "node:assert/strict";

import {
  createTerminalFileLinkProvider,
  createTerminalLinkModifierController,
  isPrimaryTerminalLinkEvent,
  terminalPathCandidates,
} from "./terminalLinks.js";

const paths = (line) => terminalPathCandidates(line).map(({ path }) => path);
const tokenPaths = (line) => terminalPathCandidates(line).slice(1).map(({ path }) => path);

test("extracts paths from git status output", () => {
  assert.deepEqual(tokenPaths("\tmodified:   src/views/App.jsx"), ["modified:", "src/views/App.jsx"]);
  assert.deepEqual(tokenPaths(" M src/app.js"), ["M", "src/app.js"]);
  assert.deepEqual(tokenPaths("?? docs/new-file.md"), ["docs/new-file.md"]);
  assert.deepEqual(tokenPaths('R  "old name.txt" -> "new name.txt"'), ["R", "old name.txt", "new name.txt"]);
});

test("extracts common ls and shell path forms", () => {
  assert.deepEqual(tokenPaths("README.md src ./package.json ../other ~/Downloads /tmp/output.txt"), [
    "README.md", "src", "./package.json", "../other", "~/Downloads", "/tmp/output.txt",
  ]);
  assert.deepEqual(tokenPaths("My\\ File.txt 'another file.md'"), ["My File.txt", "another file.md"]);
  assert.equal(paths("My File.txt")[0], "My File.txt");
  assert.equal(paths("C:\\Users\\Alex\\project\\main.rs")[0], "C:\\Users\\Alex\\project\\main.rs");
});

test("strips diagnostic locations and surrounding punctuation", () => {
  assert.deepEqual(tokenPaths("error at (src/app.jsx:12:7), see [tests/app.test.js:40]"), [
    "error", "at", "src/app.jsx", "see", "tests/app.test.js",
  ]);
});

test("decodes git C-style quoted paths and keeps unicode", () => {
  assert.deepEqual(tokenPaths(' M "docs/hello\\040world.md" src/Grüße.js'), [
    "M", "docs/hello world.md", "src/Grüße.js",
  ]);
  assert.deepEqual(tokenPaths('?? "docs/Gr\\303\\274\\303\\237e.md"'), ["docs/Grüße.md"]);
});

test("normalizes standard git diff file prefixes without changing link ranges", () => {
  assert.deepEqual(terminalPathCandidates("diff --git a/deploy.php b/deploy.php"), [
    { start: 11, end: 23, path: "deploy.php" },
    { start: 24, end: 36, path: "deploy.php" },
  ]);
  assert.deepEqual(terminalPathCandidates("--- a/public/index.php"), [
    { start: 4, end: 22, path: "public/index.php" },
  ]);
  assert.deepEqual(terminalPathCandidates("+++ b/public/index.php"), [
    { start: 4, end: 22, path: "public/index.php" },
  ]);
});

test("supports quoted, unicode, renamed, copied, and unprefixed git diff paths", () => {
  assert.deepEqual(paths('diff --git "a/old name.php" "b/new name.php"'), ["old name.php", "new name.php"]);
  assert.deepEqual(paths('--- "a/Gr\\303\\274\\303\\237e.php"'), ["Grüße.php"]);
  assert.deepEqual(paths("rename from old name.php"), ["old name.php"]);
  assert.deepEqual(paths("rename to new name.php"), ["new name.php"]);
  assert.deepEqual(paths("copy from source file.php"), ["source file.php"]);
  assert.deepEqual(paths("copy to copied file.php"), ["copied file.php"]);
  assert.deepEqual(paths("diff --git deploy.php deploy.php"), ["deploy.php", "deploy.php"]);
});

test("ignores git diff null devices and preserves ordinary prefixed paths", () => {
  assert.deepEqual(paths("--- /dev/null"), []);
  assert.deepEqual(paths("+++ /dev/null"), []);
  assert.deepEqual(tokenPaths("files a/deploy.php b/deploy.php"), ["files", "a/deploy.php", "b/deploy.php"]);
});

test("ignores web URLs and empty path tokens", () => {
  assert.deepEqual(paths("https://example.com/file.js file:///tmp/test.txt"), []);
});

test("requires the platform primary modifier without secondary modifiers", () => {
  assert.equal(isPrimaryTerminalLinkEvent({ metaKey: true }, "MacIntel"), true);
  assert.equal(isPrimaryTerminalLinkEvent({ metaKey: true, ctrlKey: true }, "MacIntel"), false);
  assert.equal(isPrimaryTerminalLinkEvent({ ctrlKey: true }, "Linux x86_64"), true);
  assert.equal(isPrimaryTerminalLinkEvent({ ctrlKey: true, shiftKey: true }, "Win32"), false);
  assert.equal(isPrimaryTerminalLinkEvent({}, "MacIntel"), false);
});

test("shows file link decorations only while the primary modifier is active", async () => {
  const target = new EventTarget();
  const controller = createTerminalLinkModifierController({ target, platform: "MacIntel" });
  const link = controller.decorate({});
  assert.deepEqual(link.decorations, { underline: false, pointerCursor: false });

  link.hover();
  await Promise.resolve();
  const commandDown = new Event("keydown");
  Object.defineProperties(commandDown, {
    metaKey: { value: true },
    ctrlKey: { value: false },
    altKey: { value: false },
    shiftKey: { value: false },
  });
  target.dispatchEvent(commandDown);
  assert.deepEqual(link.decorations, { underline: true, pointerCursor: true });

  const commandUp = new Event("keyup");
  Object.defineProperties(commandUp, {
    metaKey: { value: false },
    ctrlKey: { value: false },
    altKey: { value: false },
    shiftKey: { value: false },
  });
  target.dispatchEvent(commandUp);
  assert.deepEqual(link.decorations, { underline: false, pointerCursor: false });

  link.hover(commandDown);
  await Promise.resolve();
  assert.deepEqual(link.decorations, { underline: true, pointerCursor: true });
  controller.dispose();
});

function mouseEvent(type, button) {
  const event = new Event(type);
  Object.defineProperty(event, "button", { value: button });
  return event;
}

function fakeEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const typeListeners = listeners.get(type) || new Set();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      listeners.get(event.type)?.forEach((listener) => listener(event));
    },
    listenerCount() {
      return Array.from(listeners.values()).reduce((count, typeListeners) => count + typeListeners.size, 0);
    },
  };
}

test("resolves links only with the primary modifier and no selection drag", () => {
  const target = fakeEventTarget();
  const controller = createTerminalLinkModifierController({ target, platform: "MacIntel" });
  const commandDown = new Event("keydown");
  Object.defineProperties(commandDown, {
    metaKey: { value: true },
    ctrlKey: { value: false },
    altKey: { value: false },
    shiftKey: { value: false },
  });
  const commandUp = new Event("keyup");

  assert.equal(controller.shouldResolveLinks(), false);
  target.dispatchEvent(mouseEvent("mousedown", 2));
  assert.equal(controller.shouldResolveLinks(), false);
  target.dispatchEvent(commandDown);
  assert.equal(controller.shouldResolveLinks(), true);
  target.dispatchEvent(mouseEvent("mousedown", 2));
  assert.equal(controller.shouldResolveLinks(), true);
  target.dispatchEvent(mouseEvent("mousedown", 0));
  assert.equal(controller.shouldResolveLinks(), false);
  target.dispatchEvent(mouseEvent("mouseup", 0));
  assert.equal(controller.shouldResolveLinks(), true);
  target.dispatchEvent(commandUp);
  assert.equal(controller.shouldResolveLinks(), false);

  target.dispatchEvent(commandDown);
  target.dispatchEvent(mouseEvent("mousedown", 0));
  target.dispatchEvent(new Event("blur"));
  assert.equal(controller.shouldResolveLinks(), false);

  target.dispatchEvent(commandDown);
  target.dispatchEvent(mouseEvent("mousedown", 0));
  controller.dispose();
  assert.equal(controller.shouldResolveLinks(), false);
  assert.equal(target.listenerCount(), 0);
  target.dispatchEvent(commandDown);
  assert.equal(controller.shouldResolveLinks(), false);
});

function fakeTerminal(lines) {
  const cell = {
    chars: "",
    getChars() { return this.chars; },
    getWidth() { return 1; },
  };
  return {
    buffer: {
      active: {
        getNullCell: () => cell,
        getLine: (index) => lines[index] && ({
          isWrapped: Boolean(lines[index].wrapped),
          length: lines[index].text.length,
          translateToString: () => lines[index].text,
          getCell: (column, target) => { target.chars = lines[index].text[column] || ""; },
        }),
      },
    },
  };
}

test("maps validated links across wrapped xterm buffer lines", async () => {
  const terminal = fakeTerminal([
    { text: "src/long" },
    { text: "file.js", wrapped: true },
  ]);
  let opened = null;
  const provider = createTerminalFileLinkProvider({
    terminal,
    resolvePaths: async (candidates) => [{ index: candidates.indexOf("src/longfile.js"), path: "/repo/src/longfile.js" }],
    openPath: async (path) => { opened = path; },
  });
  const links = await new Promise((resolve) => provider.provideLinks(2, resolve));

  assert.deepEqual(links[0].range, {
    start: { x: 1, y: 1 },
    end: { x: 7, y: 2 },
  });
  links[0].activate({ ctrlKey: false }, links[0].text);
  assert.equal(opened, null);
  const primaryEvent = globalThis.navigator?.platform?.toLowerCase().startsWith("mac")
    ? { metaKey: true }
    : { ctrlKey: true };
  links[0].activate(primaryEvent, links[0].text);
  await Promise.resolve();
  assert.equal(opened, "/repo/src/longfile.js");
});

test("skips parsing and backend resolution while link discovery is guarded", async () => {
  let lineReads = 0;
  let resolutionCalls = 0;
  const terminal = fakeTerminal([{ text: "src/app.js" }]);
  const originalGetLine = terminal.buffer.active.getLine;
  terminal.buffer.active.getLine = (...args) => {
    lineReads += 1;
    return originalGetLine(...args);
  };
  let allowResolution = false;
  const provider = createTerminalFileLinkProvider({
    terminal,
    shouldResolve: () => allowResolution,
    resolvePaths: async () => {
      resolutionCalls += 1;
      return [{ index: 0, path: "/repo/src/app.js" }];
    },
    openPath: async () => {},
  });

  const suppressedLinks = await new Promise((resolve) => provider.provideLinks(1, resolve));
  assert.equal(suppressedLinks, undefined);
  assert.equal(lineReads, 0);
  assert.equal(resolutionCalls, 0);

  allowResolution = true;
  const links = await new Promise((resolve) => provider.provideLinks(1, resolve));
  assert.equal(lineReads > 0, true);
  assert.equal(resolutionCalls, 1);
  assert.equal(links.length, 1);
});
