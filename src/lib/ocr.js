export const SUPPORTED_OCR_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const SUPPORTED_OCR_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
export const SUPPORTED_EMAIL_MIME_TYPES = new Set(["message/rfc822"]);
export const SUPPORTED_EMAIL_EXTENSIONS = new Set(["eml"]);

export const UNSUPPORTED_OCR_FILE_MESSAGE = "Unsupported file type. Drop a PNG, JPEG, WebP image, or .eml email.";
export const OCR_DESKTOP_REQUIRED_MESSAGE = "OCR from dropped files requires the desktop app.";
export const EMAIL_DESKTOP_REQUIRED_MESSAGE = "Reading dropped email files requires the desktop app.";

export function isDesktopApp() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export function isSupportedOcrFile({ name = "", mimeType = "" } = {}) {
  if (mimeType && SUPPORTED_OCR_MIME_TYPES.has(mimeType.toLowerCase())) {
    return true;
  }

  const extension = fileExtension(name);
  return extension ? SUPPORTED_OCR_EXTENSIONS.has(extension) : false;
}

export function isSupportedEmailFile({ name = "", mimeType = "" } = {}) {
  if (mimeType && SUPPORTED_EMAIL_MIME_TYPES.has(mimeType.toLowerCase())) {
    return true;
  }

  const extension = fileExtension(name);
  return extension ? SUPPORTED_EMAIL_EXTENSIONS.has(extension) : false;
}

export function smartFileDropKind(fileDrop) {
  if (isSupportedOcrFile(fileDrop)) return "ocr";
  if (isAppleMailMessageDrop(fileDrop)) return "email";
  if (isSupportedEmailFile(fileDrop)) return "email";
  return null;
}

export function isAppleMailMessageDrop(fileDrop = {}) {
  return typeof fileDrop.messageUri === "string" && fileDrop.messageUri.trim().startsWith("message:");
}

export function selectDesktopDropPath(paths = []) {
  if (!Array.isArray(paths)) return null;
  if (paths.length === 1) return paths[0];

  const emailPaths = paths.filter((path) => isSupportedEmailFile({ name: path, mimeType: "" }));
  return emailPaths.length === 1 ? emailPaths[0] : null;
}

export function oneFileDropErrorMessage(items = []) {
  const names = droppedFileNames(items);
  if (!names.length) {
    return "Drop one file at a time. No filenames were reported by the drop event.";
  }

  return `Drop one file at a time. You dropped ${formatQuotedList(names)}.`;
}

export function fileExtension(name = "") {
  const trimmed = name.trim().toLowerCase();
  const lastSegment = trimmed.split(/[\\/]/).pop() || "";
  const dotIndex = lastSegment.lastIndexOf(".");
  return dotIndex >= 0 ? lastSegment.slice(dotIndex + 1) : "";
}

export function ocrTaskTitle(text) {
  const input = String(text || "");
  const firstBreakIndex = firstSentenceBreakIndex(input);
  const firstPart = (firstBreakIndex >= 0 ? input.slice(0, firstBreakIndex) : input)
    .replace(/\s+/g, " ")
    .trim();

  if (!firstPart) {
    return "OCR task";
  }

  return firstPart.length > 80 ? firstPart.slice(0, 80).trim() : firstPart;
}

export function ocrParsedPayload(text) {
  return textParsedPayload(ocrTaskTitle(text));
}

export function emailParsedPayload(subject) {
  return textParsedPayload(emailTaskTitle(subject));
}

export function textParsedPayload(title) {
  return {
    kind: "text",
    provider: null,
    externalId: null,
    url: null,
    title: taskTitle(title),
    repoUrl: null,
  };
}

function taskTitle(title) {
  return String(title || "").replace(/\s+/g, " ").trim() || "New task";
}

function emailTaskTitle(subject) {
  return taskTitle(subject) === "New task" ? "Email task" : taskTitle(subject);
}

function droppedFileNames(items) {
  return Array.from(items || [])
    .map(dropItemName)
    .map((name) => String(name).trim())
    .filter(Boolean);
}

function dropItemName(item) {
  if (typeof item === "string") return fileNameFromPath(item);
  if (item?.name) return item.name;
  if (item?.path) return fileNameFromPath(item.path);
  if (item?.file?.name) return item.file.name;
  return "";
}

function fileNameFromPath(path) {
  return String(path).split(/[\\/]/).filter(Boolean).at(-1) || String(path);
}

function formatQuotedList(values) {
  const quoted = values.map((value) => `"${String(value).replaceAll('"', '\\"')}"`);
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

function firstSentenceBreakIndex(input) {
  const indexes = [".", "!", "?", "\n"]
    .map((marker) => input.indexOf(marker))
    .filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
}
