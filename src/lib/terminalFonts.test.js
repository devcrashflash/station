import assert from "node:assert/strict";
import test from "node:test";

import {
  terminalCellLetterSpacing,
  terminalFontOptions,
  terminalFontStyle,
  terminalFontStyleId,
  terminalFontStyleOptions,
} from "./terminalFonts.js";

const fonts = [{
  family: "Example Mono",
  styles: [
    { id: "400-normal", label: "Regular", weight: 400, italic: false },
    { id: "100-normal", label: "Thin", weight: 100, italic: false },
    { id: "100-italic", label: "Thin Italic", weight: 100, italic: true },
  ],
}];

test("builds terminal font and style select options", () => {
  assert.deepEqual(terminalFontOptions(fonts), [{ value: "Example Mono", label: "Example Mono" }]);
  assert.deepEqual(terminalFontStyleOptions(fonts[0]), [
    { value: "400-normal", label: "Regular" },
    { value: "100-normal", label: "Thin" },
    { value: "100-italic", label: "Thin Italic" },
  ]);
});

test("selects an exact style and falls back to regular", () => {
  assert.equal(terminalFontStyleId(100, "italic"), "100-italic");
  assert.equal(terminalFontStyle(fonts[0], 100, "italic").label, "Thin Italic");
  assert.equal(terminalFontStyle(fonts[0], 900, "normal").label, "Regular");
});

test("converts horizontal spacing percentages to xterm letter spacing", () => {
  assert.equal(terminalCellLetterSpacing(8, 100), 0);
  assert.equal(terminalCellLetterSpacing(8, 120), 2);
  assert.equal(terminalCellLetterSpacing(8, 150), 4);
});
