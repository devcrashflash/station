export function quickCaptureTitle(input) {
  return String(input || "")
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim() || "Untitled todo";
}
