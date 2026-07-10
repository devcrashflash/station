import test from "node:test";
import assert from "node:assert/strict";

import {
  isAppleMailMessageDrop,
  isSupportedEmailFile,
  isSupportedOcrFile,
  ocrTaskTitle,
  oneFileDropErrorMessage,
  selectDesktopDropPath,
  UNSUPPORTED_OCR_FILE_MESSAGE,
  smartFileDropKind,
} from "./ocr.js";
import { api } from "./api.js";

test("creates OCR task title from first sentence", () => {
  assert.equal(ocrTaskTitle("Fix the onboarding flow. Add tests later."), "Fix the onboarding flow");
});

test("creates OCR task title from text before first newline", () => {
  assert.equal(ocrTaskTitle("Scan invoice\nTotal due tomorrow."), "Scan invoice");
});

test("preserves Unicode OCR task title text", () => {
  assert.equal(ocrTaskTitle("Grüße prüfen\nBitte öffnen."), "Grüße prüfen");
});

test("caps OCR task title at 80 characters", () => {
  const title = ocrTaskTitle("A very long OCR sentence ".repeat(8));

  assert.equal(title.length, 80);
  assert.equal(title, "A very long OCR sentence A very long OCR sentence A very long OCR sentence A ver");
});

test("falls back for blank OCR task title", () => {
  assert.equal(ocrTaskTitle("   \n\n  "), "OCR task");
});

test("detects supported OCR file types from MIME type and extension", () => {
  assert.equal(isSupportedOcrFile({ name: "scan.pdf", mimeType: "application/pdf" }), false);
  assert.equal(isSupportedOcrFile({ name: "scan.png", mimeType: "" }), true);
  assert.equal(isSupportedOcrFile({ name: "scan", mimeType: "image/webp" }), true);
  assert.equal(isSupportedOcrFile({ name: "scan.gif", mimeType: "image/gif" }), false);
});

test("detects supported email file types from MIME type and extension", () => {
  assert.equal(isSupportedEmailFile({ name: "message.eml", mimeType: "" }), true);
  assert.equal(isSupportedEmailFile({ name: "message", mimeType: "message/rfc822" }), true);
  assert.equal(isSupportedEmailFile({ name: "message.txt", mimeType: "text/plain" }), false);
});

test("classifies smart file drops", () => {
  assert.equal(smartFileDropKind({ name: "scan.png", mimeType: "" }), "ocr");
  assert.equal(smartFileDropKind({ name: "message.eml", mimeType: "" }), "email");
  assert.equal(smartFileDropKind({ messageUri: "message:%3Cabc@example.test%3E" }), "email");
  assert.equal(smartFileDropKind({ name: "notes.txt", mimeType: "text/plain" }), null);
});

test("detects Apple Mail message drops", () => {
  assert.equal(isAppleMailMessageDrop({ messageUri: "message:%3Cabc@example.test%3E" }), true);
  assert.equal(isAppleMailMessageDrop({ messageUri: "https://example.test/message" }), false);
});

test("selects single desktop drop path", () => {
  assert.equal(selectDesktopDropPath(["/tmp/message.eml"]), "/tmp/message.eml");
});

test("keeps single unsupported desktop drop path for unsupported-type handling", () => {
  assert.equal(selectDesktopDropPath(["/tmp/notes.txt"]), "/tmp/notes.txt");
});

test("selects one email path from multi-path desktop drop", () => {
  assert.equal(
    selectDesktopDropPath(["/tmp/mail-preview", "/tmp/message.eml", "/tmp/mail-metadata"]),
    "/tmp/message.eml",
  );
});

test("rejects multi-path desktop drop with multiple email files", () => {
  assert.equal(selectDesktopDropPath(["/tmp/first.eml", "/tmp/second.eml"]), null);
});

test("rejects multi-path desktop drop without an email file", () => {
  assert.equal(selectDesktopDropPath(["/tmp/scan.png", "/tmp/notes.txt"]), null);
});

test("formats one-file drop error with dropped path names", () => {
  assert.equal(
    oneFileDropErrorMessage(["/tmp/test.jpg", "/tmp/test2.jpg", "/tmp/helloworld.jpg"]),
    'Drop one file at a time. You dropped "test.jpg", "test2.jpg" and "helloworld.jpg".',
  );
});

test("formats one-file drop error with dropped file object names", () => {
  assert.equal(
    oneFileDropErrorMessage([{ name: "test.jpg" }, { name: "test2.jpg" }]),
    'Drop one file at a time. You dropped "test.jpg" and "test2.jpg".',
  );
});

test("formats one-file drop error without names when unavailable", () => {
  assert.equal(
    oneFileDropErrorMessage([]),
    "Drop one file at a time. No filenames were reported by the drop event.",
  );
});

test("web fallback rejects dropped OCR files", async () => {
  await assert.rejects(
    () => api.ocrImageFile({ path: "/tmp/scan.png", mimeType: "image/png" }),
    /requires the desktop app/,
  );
});

test("web fallback rejects dropped email files", async () => {
  await assert.rejects(
    () => api.readEmailFile({ path: "/tmp/message.eml", mimeType: "message/rfc822" }),
    /requires the desktop app/,
  );
});

test("unsupported OCR file message is stable", () => {
  assert.equal(
    UNSUPPORTED_OCR_FILE_MESSAGE,
    "Unsupported file type. Drop a PNG, JPEG, WebP image, or .eml email.",
  );
});
