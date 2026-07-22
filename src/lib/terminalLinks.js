const TOKEN_PATTERN = /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|(?:\\.|[^\s"'<>|])+/gu;
const URL_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const WINDOWS_ABSOLUTE_PATTERN = /^[a-z]:[\\/]/i;

function decodeEscapedPath(value, cStyle = false) {
  const bytes = [];
  let decoded = "";
  const flushBytes = () => {
    if (!bytes.length) return;
    decoded += new TextDecoder().decode(Uint8Array.from(bytes));
    bytes.length = 0;
  };

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\" || index + 1 >= value.length) {
      flushBytes();
      decoded += value[index];
      continue;
    }

    const next = value[index + 1];
    if (cStyle && /[0-7]/.test(next)) {
      const octal = value.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] || next;
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }

    flushBytes();
    const escapes = cStyle
      ? { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" }
      : {};
    decoded += escapes[next] ?? next;
    index += 1;
  }
  flushBytes();
  return decoded;
}

function trimToken(token, start) {
  let value = token;
  let offset = start;
  const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
  if (quoted) {
    offset += 1;
    value = value.slice(1, -1);
  } else {
    const leading = value.match(/^[([{,;]+/)?.[0].length || 0;
    value = value.slice(leading);
    offset += leading;
    value = value.replace(/[),;!?\]}]+$/g, "");
  }

  const location = value.match(/:(\d+)(?::\d+)?(?::)?$/);
  const displayLength = location ? value.length - location[0].length : value.length;
  const rawPath = value.slice(0, displayLength);
  return {
    start: offset,
    end: offset + displayLength,
    path: !quoted && WINDOWS_ABSOLUTE_PATTERN.test(rawPath)
      ? rawPath
      : decodeEscapedPath(rawPath, quoted && token[0] === '"'),
  };
}

export function terminalPathCandidates(line) {
  if (typeof line !== "string" || !line.trim()) return [];
  const candidates = [];
  const seen = new Set();
  const addCandidate = (candidate) => {
    if (!candidate.path || candidate.path === "." || candidate.path === "..") return;
    if (/^[=?-]+$/.test(candidate.path)) return;
    if (URL_PATTERN.test(candidate.path) || candidate.path.includes("\0")) return;
    const key = `${candidate.start}:${candidate.end}:${candidate.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(candidate);
    }
  };

  const trimmed = line.trim();
  addCandidate(trimToken(trimmed, line.indexOf(trimmed)));
  for (const match of line.matchAll(TOKEN_PATTERN)) {
    addCandidate(trimToken(match[0], match.index));
  }
  return candidates;
}

export function isPrimaryTerminalLinkEvent(event, platform = globalThis.navigator?.platform || "") {
  if (!event || event.altKey || event.shiftKey) return false;
  return platform.toLowerCase().startsWith("mac")
    ? Boolean(event.metaKey && !event.ctrlKey)
    : Boolean(event.ctrlKey && !event.metaKey);
}

function windowedLineStrings(bufferLineNumber, terminal) {
  const buffer = terminal.buffer.active;
  let firstLine = bufferLineNumber - 1;
  let lastLine = firstLine;
  let line = buffer.getLine(firstLine);
  if (!line) return null;

  const lines = [line.translateToString(true)];
  let length = lines[0].length;
  while (line?.isWrapped && firstLine > 0 && length < 2048) {
    line = buffer.getLine(firstLine - 1);
    if (!line) break;
    const text = line.translateToString(true);
    lines.unshift(text);
    length += text.length;
    firstLine -= 1;
  }

  line = buffer.getLine(lastLine + 1);
  while (line?.isWrapped && length < 2048) {
    const text = line.translateToString(true);
    lines.push(text);
    length += text.length;
    lastLine += 1;
    line = buffer.getLine(lastLine + 1);
  }
  return { text: lines.join(""), firstLine };
}

function mapStringIndex(terminal, line, column, stringIndex) {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  let remaining = stringIndex;
  let currentLine = line;
  let currentColumn = column;

  while (remaining > 0) {
    const bufferLine = buffer.getLine(currentLine);
    if (!bufferLine) return null;
    for (let index = currentColumn; index < bufferLine.length; index += 1) {
      bufferLine.getCell(index, cell);
      const chars = cell.getChars();
      if (cell.getWidth()) remaining -= chars.length || 1;
      if (remaining < 0) return { line: currentLine, column: index };
    }
    currentLine += 1;
    currentColumn = 0;
  }
  return { line: currentLine, column: currentColumn };
}

function candidateRange(terminal, firstLine, candidate) {
  const start = mapStringIndex(terminal, firstLine, 0, candidate.start);
  let end = mapStringIndex(terminal, firstLine, 0, candidate.end);
  if (!start || !end) return null;
  if (end.column === 0 && end.line > firstLine) {
    const previousLine = terminal.buffer.active.getLine(end.line - 1);
    if (previousLine) end = { line: end.line - 1, column: previousLine.length };
  }
  return {
    start: { x: start.column + 1, y: start.line + 1 },
    end: { x: end.column, y: end.line + 1 },
  };
}

export function createTerminalFileLinkProvider({ terminal, resolvePaths, openPath }) {
  return {
    async provideLinks(bufferLineNumber, callback) {
      const logicalLine = windowedLineStrings(bufferLineNumber, terminal);
      if (!logicalLine) {
        callback(undefined);
        return;
      }
      const candidates = terminalPathCandidates(logicalLine.text);
      if (!candidates.length) {
        callback(undefined);
        return;
      }

      try {
        const resolved = await resolvePaths(candidates.map(({ path }) => path));
        const byIndex = new Map(resolved.map((item) => [item.index, item.path]));
        const linkedSpans = [];
        const links = candidates.flatMap((candidate, index) => {
          const path = byIndex.get(index);
          const range = path ? candidateRange(terminal, logicalLine.firstLine, candidate) : null;
          if (!path || !range) return [];
          if (linkedSpans.some(({ start, end }) => candidate.start < end && candidate.end > start)) return [];
          linkedSpans.push(candidate);
          return [{
            range,
            text: candidate.path,
            activate: (event) => {
              if (isPrimaryTerminalLinkEvent(event)) void openPath(path);
            },
          }];
        });
        callback(links.length ? links : undefined);
      } catch {
        callback(undefined);
      }
    },
  };
}
