export function terminalFontStyleId(weight, fontStyle) {
  return `${Number(weight)}-${fontStyle === "italic" ? "italic" : "normal"}`;
}

export function terminalFontFamily(fonts, family) {
  return (fonts || []).find((entry) => entry.family === family) || null;
}

export function terminalFontStyle(font, weight, fontStyle) {
  if (!font) return null;
  const id = terminalFontStyleId(weight, fontStyle);
  return font.styles.find((style) => style.id === id)
    || font.styles.find((style) => style.weight === 400 && !style.italic)
    || font.styles[0]
    || null;
}

export function terminalFontOptions(fonts) {
  return (fonts || []).map((font) => ({ value: font.family, label: font.family }));
}

export function terminalFontStyleOptions(font) {
  return (font?.styles || []).map((style) => ({ value: style.id, label: style.label }));
}

export function terminalCellLetterSpacing(characterWidth, horizontalSpacing) {
  const width = Number(characterWidth);
  const percentage = Number(horizontalSpacing);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(percentage)) return 0;
  return Math.round(width * (Math.min(200, Math.max(100, percentage)) / 100 - 1));
}
