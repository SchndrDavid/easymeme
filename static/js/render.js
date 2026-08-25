/**
 * Composition: turns a document plus a frame index into pixels.
 *
 * The preview and the exporter both go through renderFrame(), so what you see
 * on screen and what lands in the file cannot drift apart.
 *
 * The caption-bar geometry is deliberately unchanged from the original
 * index.html: same 1.26 line height, same 0.045 side padding, same 0.62 vertical
 * padding, same per-mille size scale. A photo with two bars must come out of the
 * rewrite as the same meme it was before.
 */

import { fontAt, setMeasureFont, wrap, drawText } from "./text.js";
import { layerActiveAt } from "./doc.js";

/**
 * Everything the renderer needs to know about where things go, computed once
 * so the timeline, hit-testing and the exporter can all ask the same question.
 */
export function layout(doc) {
  const w = doc.width;
  const h = doc.height;

  const fs = Math.round(w * (doc.bars.size / 1000));
  const lh = Math.round(fs * 1.26);
  const padX = Math.round(w * 0.045);
  const padY = Math.round(fs * 0.62);

  setMeasureFont(fs);
  const inner = w - padX * 2;
  const topLines = wrap(doc.bars.top, inner);
  const botLines = wrap(doc.bars.bottom, inner);

  const topH = topLines.length ? topLines.length * lh + padY * 2 : 0;
  const botH = botLines.length ? botLines.length * lh + padY * 2 : 0;

  return {
    w, h, fs, lh, padX, padY, topLines, botLines, topH, botH,
    canvasW: w,
    canvasH: topH + h + botH,
    imgY: topH,               // overlay coordinates are relative to this box
  };
}

function drawBars(ctx, L) {
  ctx.fillStyle = "#000000";
  ctx.font = fontAt(L.fs);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  L.topLines.forEach((line, i) => ctx.fillText(line, L.w / 2, L.padY + L.lh * i + L.lh / 2));
  L.botLines.forEach((line, i) =>
    ctx.fillText(line, L.w / 2, L.topH + L.h + L.padY + L.lh * i + L.lh / 2));
}

function drawSticker(ctx, layer, L) {
  const bmp = layer.bitmap;
  if (!bmp) return null;

  const drawW = L.w * layer.scale;
  const drawH = drawW * (bmp.height / bmp.width);
  const cx = layer.x * L.w;
  const cy = L.imgY + layer.y * L.h;

  ctx.save();
  ctx.translate(cx, cy);
  if (layer.rotation) ctx.rotate(layer.rotation);
  if (layer.flipX) ctx.scale(-1, 1);
  ctx.drawImage(bmp, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  return { x: cx - drawW / 2, y: cy - drawH / 2, w: drawW, h: drawH };
}

function drawOverlay(ctx, layer, L) {
  if (layer.type === "sticker") return drawSticker(ctx, layer, L);
  if (!layer.text) return null;
  return drawText(ctx, layer.text, {
    cx: layer.x * L.w,
    cy: L.imgY + layer.y * L.h,
    maxWidth: L.w * layer.width,
    size: Math.round(L.w * (layer.size / 1000)),
    color: layer.color,
    stroke: layer.stroke,
    align: layer.align,
  });
}

/**
 * Paints frame `index` of `doc` into `ctx`.
 *
 * Resizing a canvas resets its context, so every style is set afterwards - the
 * same trap the original code called out.
 */
export function renderFrame(ctx, doc, index, L = layout(doc)) {
  const canvas = ctx.canvas;
  if (canvas.width !== L.canvasW || canvas.height !== L.canvasH) {
    canvas.width = L.canvasW;
    canvas.height = L.canvasH;
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, L.canvasW, L.canvasH);

  const frame = doc.frames[index];
  if (frame && frame.bitmap) ctx.drawImage(frame.bitmap, 0, L.topH, L.w, L.h);

  drawBars(ctx, L);

  for (const layer of doc.layers) {
    if (layerActiveAt(layer, index)) drawOverlay(ctx, layer, L);
  }

  return L;
}

/**
 * Bounding box of a layer on the current frame, in canvas pixels. Measured by
 * drawing into a scratch context rather than re-deriving the maths, so the box
 * can never disagree with the glyphs.
 */
const scratch = document.createElement("canvas").getContext("2d");

export function layerBounds(doc, layer, L = layout(doc)) {
  if (layer.type === "sticker") {
    const bmp = layer.bitmap;
    if (!bmp) return null;
    const drawW = L.w * layer.scale;
    const drawH = drawW * (bmp.height / bmp.width);
    return {
      x: layer.x * L.w - drawW / 2,
      y: L.imgY + layer.y * L.h - drawH / 2,
      w: drawW,
      h: drawH,
    };
  }
  if (!layer.text) return null;
  scratch.canvas.width = 1;
  scratch.canvas.height = 1;
  return drawText(scratch, layer.text, {
    cx: layer.x * L.w,
    cy: L.imgY + layer.y * L.h,
    maxWidth: L.w * layer.width,
    size: Math.round(L.w * (layer.size / 1000)),
    color: "transparent",
    stroke: "",
    align: layer.align,
  });
}

/** Topmost layer whose box contains the point, for click-to-select. */
export function hitTest(doc, px, py, L = layout(doc)) {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.layers[i];
    if (!layerActiveAt(layer, doc.current)) continue;
    const b = layerBounds(doc, layer, L);
    if (!b) continue;
    // A small slack makes thin text realistically grabbable on a phone.
    const pad = Math.max(8, L.w * 0.015);
    if (px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad) {
      return layer;
    }
  }
  return null;
}
