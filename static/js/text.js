/**
 * Text measurement and wrapping.
 *
 * Lifted unchanged from the original single-file index.html - this logic was
 * already correct, it only moved house. The one addition is drawText(), which
 * the free-floating overlay layers need and the white caption bars do not.
 */

// A throwaway 2D context used only for measureText, so measuring never disturbs
// the canvas being drawn.
const measure = document.createElement("canvas").getContext("2d");

export const fontAt = (px) =>
  '600 ' + px + 'px Archivo, "Helvetica Neue", Arial, sans-serif';

export function setMeasureFont(px) {
  measure.font = fontAt(px);
}

// A word too wide for a line of its own is split by character, otherwise it
// would bleed off both edges of the canvas. Iterating a string yields whole
// code points, so surrogate pairs survive the split.
function chop(word, maxWidth) {
  const parts = [];
  let chunk = "";
  for (const ch of word) {
    const test = chunk + ch;
    if (chunk && measure.measureText(test).width > maxWidth) { parts.push(chunk); chunk = ch; }
    else chunk = test;
  }
  if (chunk) parts.push(chunk);
  return parts;
}

export function wrap(text, maxWidth) {
  const out = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = "";
    for (const word of words) {
      if (measure.measureText(word).width > maxWidth) {
        if (line) { out.push(line); line = ""; }
        const parts = chop(word, maxWidth);
        for (let i = 0; i < parts.length - 1; i++) out.push(parts[i]);
        line = parts[parts.length - 1] || "";
        continue;
      }
      const test = line ? line + " " + word : word;
      if (!line || measure.measureText(test).width <= maxWidth) line = test;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Draws a wrapped, optionally outlined block of text centred on (cx, cy).
 *
 * The stroke is painted under the fill in a single pass per line rather than
 * stroking the whole block first: overlapping descenders from the line above
 * would otherwise get their outline painted over by the next line's fill.
 */
export function drawText(ctx, text, opts) {
  const { cx, cy, maxWidth, size, color, stroke, align } = opts;

  setMeasureFont(size);
  const lines = wrap(text, maxWidth);
  if (!lines.length) return null;

  const lh = Math.round(size * 1.2);
  const blockH = lines.length * lh;
  const top = cy - blockH / 2;

  ctx.save();
  ctx.font = fontAt(size);
  ctx.textAlign = align || "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";       // stops long spikes where two strokes meet
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(2, size * 0.14);
  ctx.strokeStyle = stroke;
  ctx.fillStyle = color;

  // With a non-centre alignment the anchor moves to the matching edge of the
  // wrap box, so the block stays inside the same maxWidth either way.
  const half = maxWidth / 2;
  const x = align === "left" ? cx - half : align === "right" ? cx + half : cx;

  lines.forEach((line, i) => {
    const y = top + lh * i + lh / 2;
    if (stroke) ctx.strokeText(line, x, y);
    ctx.fillText(line, x, y);
  });
  ctx.restore();

  // Returned so hit-testing and the selection outline agree with what was drawn.
  let widest = 0;
  for (const line of lines) widest = Math.max(widest, measure.measureText(line).width);
  return { x: x - (align === "left" ? 0 : align === "right" ? widest : widest / 2), y: top, w: widest, h: blockH };
}
