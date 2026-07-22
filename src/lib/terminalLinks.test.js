import test from "node:test";
import assert from "node:assert/strict";

import {
  createTerminalFileLinkProvider,
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
  links[0].activate({ ctrlKey: true }, links[0].text);
  await Promise.resolve();
  assert.equal(opened, "/repo/src/longfile.js");
});
