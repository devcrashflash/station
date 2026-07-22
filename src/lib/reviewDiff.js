const DIFF_METADATA_PREFIXES = [
  "diff --git ",
  "index ",
  "--- ",
  "+++ ",
  "old mode ",
  "new mode ",
  "new file mode ",
  "deleted file mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
  "Binary files ",
  "GIT binary patch",
];

const LANGUAGE_BY_EXTENSION = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "c",
  hpp: "cpp",
  htm: "markup",
  html: "markup",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mts: "typescript",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sass: "sass",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "markup",
  swift: "swift",
  ts: "typescript",
  tsx: "tsx",
  txt: "plain",
  xml: "markup",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

export function classifyDiffLine(line) {
  if (line === "\\ No newline at end of file") {
    return { type: "no-newline", marker: "", content: line };
  }

  if (DIFF_METADATA_PREFIXES.some((prefix) => line.startsWith(prefix))) {
    return { type: "metadata", marker: "", content: line };
  }

  if (line.startsWith("@@")) {
    return { type: "hunk", marker: "", content: line };
  }

  if (line.startsWith("+")) {
    return { type: "addition", marker: "+", content: line.slice(1) };
  }

  if (line.startsWith("-")) {
    return { type: "deletion", marker: "-", content: line.slice(1) };
  }

  if (line.startsWith(" ")) {
    return { type: "context", marker: " ", content: line.slice(1) };
  }

  return { type: "context", marker: "", content: line };
}

function diffPathFromHeader(line, prefix) {
  const value = line.slice(prefix.length).split("\t", 1)[0].trim();
  if (!value || value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

export function diffPaths(diff, fallbackPath = "") {
  let oldPath = fallbackPath || null;
  let newPath = fallbackPath || null;

  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("--- ")) oldPath = diffPathFromHeader(line, "--- ");
    if (line.startsWith("+++ ")) newPath = diffPathFromHeader(line, "+++ ");
  }

  return {
    oldPath: oldPath || newPath,
    newPath: newPath || oldPath,
  };
}

export function parseDiffLines(diff) {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let hunkId = 0;

  return String(diff || "").split("\n").map((raw, index) => {
    const parsed = classifyDiffLine(raw);
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      hunkId += 1;
      return { ...parsed, raw, index, hunkId, oldLine: null, newLine: null, side: null, commentable: false };
    }

    let currentOldLine = null;
    let currentNewLine = null;
    let side = null;
    if (inHunk && parsed.type === "addition") {
      currentNewLine = newLine++;
      side = "RIGHT";
    } else if (inHunk && parsed.type === "deletion") {
      currentOldLine = oldLine++;
      side = "LEFT";
    } else if (inHunk && raw.startsWith(" ")) {
      currentOldLine = oldLine++;
      currentNewLine = newLine++;
      side = "RIGHT";
    }

    return {
      ...parsed,
      raw,
      index,
      hunkId: inHunk ? hunkId : null,
      oldLine: currentOldLine,
      newLine: currentNewLine,
      side,
      commentable: side !== null,
    };
  });
}

export function selectCommentRange(lines, startIndex, endIndex) {
  const start = lines[startIndex];
  if (!start?.commentable || start.hunkId == null) return null;

  const direction = endIndex < startIndex ? -1 : 1;
  let resolvedEnd = startIndex;
  for (let index = startIndex; index !== endIndex + direction; index += direction) {
    const line = lines[index];
    if (!line || line.hunkId !== start.hunkId) break;
    if (line.commentable) resolvedEnd = index;
  }

  const firstIndex = Math.min(startIndex, resolvedEnd);
  const lastIndex = Math.max(startIndex, resolvedEnd);
  const selectedLines = lines.slice(firstIndex, lastIndex + 1).filter((line) => line.commentable);
  if (selectedLines.length === 0) return null;

  return {
    firstIndex,
    lastIndex,
    start: selectedLines[0],
    end: selectedLines.at(-1),
    lines: selectedLines,
  };
}

export function selectedCodeText(range) {
  return range?.lines?.map((line) => line.content).join("\n") || "";
}

export function reviewCodeCopyText(event, range) {
  if (!event || event.type !== "copy" || !event.clipboardData) {
    return null;
  }

  const target = event.target;
  if (
    typeof target?.selectionStart === "number"
    && typeof target?.selectionEnd === "number"
    && target.selectionStart !== target.selectionEnd
  ) {
    return null;
  }

  return selectedCodeText(range) || null;
}

export function diffLanguageForPath(path) {
  const fileName = String(path || "").split(/[\\/]/).pop() || "";
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex <= 0 || extensionIndex === fileName.length - 1) return "plain";

  const extension = fileName.slice(extensionIndex + 1).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] || "plain";
}
