// Bound clipboard requests before decoding; xterm also bounds its OSC parser buffer.
export const MAX_OSC52_BYTES = 1024 * 1024;

export function decodeOsc52Clipboard(data) {
  if (typeof data !== "string" || data.length > Math.ceil(MAX_OSC52_BYTES / 3) * 4 + 32) return null;
  const separator = data.indexOf(";");
  if (separator < 0) return null;
  const targets = data.slice(0, separator);
  // Station exposes one system clipboard; common selection targets alias it.
  if (!/^[cps]*$/.test(targets)) return null;
  const encoded = data.slice(separator + 1).replace(/[\r\n]/g, "");
  // Queries deliberately receive no response. Invalid input must not clear the clipboard.
  if (encoded === "?" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==?|[A-Za-z0-9+/]{3}=?)?$/.test(encoded)) return null;
  try {
    const binary = atob(encoded);
    if (binary.length > MAX_OSC52_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

export function registerTerminalClipboard(terminal, writeText, onError = console.error) {
  let pending = Promise.resolve();
  return terminal.parser.registerOscHandler(52, (data) => {
    const text = decodeOsc52Clipboard(data);
    if (text !== null) {
      // Preserve request order even if native clipboard writes complete asynchronously.
      pending = pending.then(() => writeText(text)).catch(onError);
    }
    return true;
  });
}
