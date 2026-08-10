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

function tokenCandidates(line, offset = 0) {
  return Array.from(line.slice(offset).matchAll(TOKEN_PATTERN), (match) => (
    trimToken(match[0], offset + match.index)
  ));
}

function normalizeGitDiffPrefix(candidate) {
  if (candidate.path === "/dev/null") return null;
  if (candidate.path.startsWith("a/") || candidate.path.startsWith("b/")) {
    return { ...candidate, path: candidate.path.slice(2) };
  }
  return candidate;
}

function gitDiffPathCandidates(line) {
  const trimmedStart = line.length - line.trimStart().length;
  const content = line.slice(trimmedStart);
  const binaryPrefix = "diff --git ";
  if (content.startsWith(binaryPrefix)) {
    return tokenCandidates(line, trimmedStart + binaryPrefix.length)
      .slice(0, 2)
      .map(normalizeGitDiffPrefix)
      .filter(Boolean);
  }

  for (const prefix of ["--- ", "+++ "]) {
    if (!content.startsWith(prefix)) continue;
    const [candidate] = tokenCandidates(line, trimmedStart + prefix.length);
    const normalized = candidate && normalizeGitDiffPrefix(candidate);
    return normalized ? [normalized] : [];
  }

  for (const prefix of ["rename from ", "rename to ", "copy from ", "copy to "]) {
    if (!content.startsWith(prefix)) continue;
    const pathStart = trimmedStart + prefix.length;
    const rawPath = line.slice(pathStart).trimEnd();
    if (!rawPath) return [];
    const candidate = trimToken(rawPath, pathStart);
    return candidate.path === "/dev/null" ? [] : [candidate];
  }

  return null;
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

  const diffCandidates = gitDiffPathCandidates(line);
  if (diffCandidates !== null) {
    diffCandidates.forEach(addCandidate);
    return candidates;
  }

  const trimmed = line.trim();
  addCandidate(trimToken(trimmed, line.indexOf(trimmed)));
  tokenCandidates(line).forEach(addCandidate);
  return candidates;
}

export function isPrimaryTerminalLinkEvent(event, platform = globalThis.navigator?.platform || "") {
  if (!event || event.altKey || event.shiftKey) return false;
  return platform.toLowerCase().startsWith("mac")
    ? Boolean(event.metaKey && !event.ctrlKey)
    : Boolean(event.ctrlKey && !event.metaKey);
}

export function createTerminalLinkModifierController({
  target = globalThis.window,
  platform = globalThis.navigator?.platform || "",
} = {}) {
  let active = false;
  let primaryButtonDown = false;
  let hoveredLink = null;

  const updateLink = () => {
    if (!hoveredLink?.decorations) return;
    hoveredLink.decorations.underline = active;
    hoveredLink.decorations.pointerCursor = active;
  };
  const updateModifier = (event) => {
    active = isPrimaryTerminalLinkEvent(event, platform);
    updateLink();
  };
  const resetModifier = () => {
    active = false;
    updateLink();
  };
  const trackMouseDown = (event) => {
    if (event.button === 0) primaryButtonDown = true;
  };
  const trackMouseUp = (event) => {
    if (event.button === 0) primaryButtonDown = false;
  };
  const resetInteraction = () => {
    primaryButtonDown = false;
    resetModifier();
  };

  target?.addEventListener("keydown", updateModifier, true);
  target?.addEventListener("keyup", updateModifier, true);
  target?.addEventListener("mousedown", trackMouseDown, true);
  target?.addEventListener("mouseup", trackMouseUp, true);
  target?.addEventListener("blur", resetInteraction);

  return {
    shouldResolveLinks() {
      return active && !primaryButtonDown;
    },
    decorate(link) {
      link.decorations = { underline: active, pointerCursor: active };
      link.hover = (event) => {
        active = isPrimaryTerminalLinkEvent(event, platform);
        // xterm replaces decorations with live accessors immediately after
        // calling hover, so defer tracking until those accessors are installed.
        queueMicrotask(() => {
          hoveredLink = link;
          updateLink();
        });
      };
      link.leave = () => {
        if (hoveredLink === link) hoveredLink = null;
      };
      link.dispose = link.leave;
      return link;
    },
    dispose() {
      target?.removeEventListener("keydown", updateModifier, true);
      target?.removeEventListener("keyup", updateModifier, true);
      target?.removeEventListener("mousedown", trackMouseDown, true);
      target?.removeEventListener("mouseup", trackMouseUp, true);
      target?.removeEventListener("blur", resetInteraction);
      active = false;
      primaryButtonDown = false;
      hoveredLink = null;
    },
  };
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

export function createTerminalFileLinkProvider({
  terminal,
  resolvePaths,
  openPath,
  linkModifier,
  shouldResolve = () => true,
}) {
  return {
    async provideLinks(bufferLineNumber, callback) {
      // A selection drag can cross many wrapped rows from one logical line.
      // Keep path parsing and filesystem resolution out of that hot path.
      if (!shouldResolve()) {
        callback(undefined);
        return;
      }
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
          const link = {
            range,
            text: candidate.path,
            activate: (event) => {
              if (isPrimaryTerminalLinkEvent(event)) void openPath(path);
            },
          };
          return [linkModifier ? linkModifier.decorate(link) : link];
        });
        callback(links.length ? links : undefined);
      } catch {
        callback(undefined);
      }
    },
  };
}
