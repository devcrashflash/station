import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { MAX_OSC52_BYTES, decodeOsc52Clipboard, registerTerminalClipboard } from "./terminalClipboard.js";

const encode = (text) => Buffer.from(text).toString("base64");
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");

test("decodes UTF-8 clipboard text and supported targets without trimming content", () => {
  const text = "  server {\n\t# Grüße 👋\n}\n";
  for (const target of ["", "c", "p", "s", "cp"]) {
    assert.equal(decodeOsc52Clipboard(`${target};${encode(text)}`), text);
  }
  assert.equal(decodeOsc52Clipboard("c;"), "");
  assert.equal(decodeOsc52Clipboard("c;aGk"), "hi");
  assert.equal(decodeOsc52Clipboard("c;aG\r\nk="), "hi");
});

test("ignores queries, unsupported targets, malformed base64 and invalid UTF-8", () => {
  for (const data of [null, "", "c", "c;?", ";?", "q;aGk=", "c;!!!!", "c;a", "c;a===", "c;====", "c;aGk=;extra", "c;/w=="]) {
    assert.equal(decodeOsc52Clipboard(data), null, String(data));
  }
});

test("bounds decoded clipboard writes", () => {
  assert.equal(decodeOsc52Clipboard(`c;${encode("x".repeat(MAX_OSC52_BYTES))}`).length, MAX_OSC52_BYTES);
  assert.equal(decodeOsc52Clipboard(`c;${encode("x".repeat(MAX_OSC52_BYTES + 1))}`), null);
});

test("xterm handles BEL, ST, and fragmented OSC 52 requests and disposes the handler", async () => {
  const terminal = new Terminal({ allowProposedApi: true });
  const writes = [];
  const registration = registerTerminalClipboard(terminal, async (text) => { writes.push(text); });
  const write = (data) => new Promise((resolve) => terminal.write(data, resolve));
  try {
    await write(`\x1b]52;c;${encode("first")}\x07`);
    await write(`\x1b]52;;${encode("Grüße 👋")}\x1b\\`);
    await write("\x1b]52;c;aG");
    await write("k=\x07");
    await write("\x1b]52;c;?\x07\x1b]52;c;invalid!\x07");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writes, ["first", "Grüße 👋", "hi"]);
    registration.dispose();
    await write(`\x1b]52;c;${encode("disposed")}\x07`);
    assert.equal(writes.length, 3);
  } finally {
    terminal.dispose();
  }
});

test("serializes asynchronous writes and recovers after clipboard failure", async () => {
  let handler;
  const terminal = { parser: { registerOscHandler(id, callback) { assert.equal(id, 52); handler = callback; } } };
  const calls = [];
  const errors = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  registerTerminalClipboard(terminal, async (text) => {
    calls.push(text);
    if (text === "first") { await blocked; throw new Error("clipboard unavailable"); }
  }, (error) => errors.push(error.message));
  assert.equal(handler(`c;${encode("first")}`), true);
  handler(`c;${encode("second")}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["first"]);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["first", "second"]);
  assert.deepEqual(errors, ["clipboard unavailable"]);
});
