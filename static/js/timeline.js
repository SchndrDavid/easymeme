/**
 * The filmstrip.
 *
 * Drawn as a single canvas rather than one element per frame: a 400 frame clip
 * would otherwise mean 400 DOM nodes and 400 images, which no phone enjoys.
 * Thumbnails are laid out at a fixed width and sampled from the sequence the way
 * an NLE does it, so the strip looks the same whether the clip has 12 frames or
 * 400.
 *
 * Two rows share the canvas:
 *   row 1  thumbnails, trim shading, trim handles, playhead
 *   row 2  the in/out range of the selected overlay layer
 */

import { selectedLayer } from "./doc.js";

const STRIP_H = 56;
const GAP = 8;
const RANGE_H = 16;
export const TIMELINE_H = STRIP_H + GAP + RANGE_H;

const HANDLE_GRAB = 14;   // px of slack around a draggable edge
const HANDLE_W = 7;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export function createTimeline(canvas, { onChange }) {
  const ctx = canvas.getContext("2d");
  let doc = null;
  let cache = null;         // pre-rendered thumbnail strip
  let cacheWidth = 0;
  let drag = null;          // "seek" | "trimFrom" | "trimTo" | "rangeFrom" | "rangeTo" | "rangeMove"
  let dragOffset = 0;

  const cssWidth = () => canvas.clientWidth || 1;
  const lastIndex = () => Math.max(1, doc.frames.length - 1);
  const xToFrame = (x) => clamp(Math.round((x / cssWidth()) * lastIndex()), 0, lastIndex());
  const frameToX = (i) => (i / lastIndex()) * cssWidth();

  /** Repaints the thumbnail cache. Only needed on load or resize. */
  function buildCache() {
    const w = cssWidth();
    const dpr = window.devicePixelRatio || 1;
    const first = doc.frames[0].bitmap;
    const aspect = first.width / first.height;
    const thumbW = Math.max(24, Math.round(STRIP_H * aspect));

    cache = document.createElement("canvas");
    cache.width = Math.max(1, Math.round(w * dpr));
    cache.height = Math.round(STRIP_H * dpr);
    const c = cache.getContext("2d");
    c.scale(dpr, dpr);
    c.fillStyle = "#05060a";
    c.fillRect(0, 0, w, STRIP_H);

    const slots = Math.ceil(w / thumbW);
    for (let k = 0; k < slots; k++) {
      const x = k * thumbW;
      const at = slots === 1 ? 0 : Math.round((k / (slots - 1)) * lastIndex());
      const bmp = doc.frames[clamp(at, 0, doc.frames.length - 1)].bitmap;
      if (!bmp) continue;

      // Cover-fit: crop the middle rather than squash, so faces stay proportioned.
      const sAspect = bmp.width / bmp.height;
      const tAspect = thumbW / STRIP_H;
      let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
      if (sAspect > tAspect) {
        sw = bmp.height * tAspect;
        sx = (bmp.width - sw) / 2;
      } else {
        sh = bmp.width / tAspect;
        sy = (bmp.height - sh) / 2;
      }
      c.drawImage(bmp, sx, sy, sw, sh, x, 0, thumbW, STRIP_H);
      c.strokeStyle = "rgba(0,0,0,.5)";
      c.beginPath();
      c.moveTo(x + 0.5, 0);
      c.lineTo(x + 0.5, STRIP_H);
      c.stroke();
    }

    cacheWidth = w;
  }

  function drawHandle(x, active) {
    ctx.fillStyle = active ? "#00c2ff" : "#e9ebf2";
    ctx.fillRect(x - HANDLE_W / 2, 0, HANDLE_W, STRIP_H);
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.fillRect(x - 0.5, STRIP_H * 0.35, 1, STRIP_H * 0.3);
  }

  function draw() {
    if (!doc) return;
    const w = cssWidth();
    const dpr = window.devicePixelRatio || 1;

    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(TIMELINE_H * dpr)) {
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.round(TIMELINE_H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, TIMELINE_H);

    if (!cache || cacheWidth !== w) buildCache();
    ctx.drawImage(cache, 0, 0, w, STRIP_H);

    // Everything outside the trim is dimmed rather than removed, so it is still
    // obvious how much was cut and it can be dragged back.
    const xFrom = frameToX(doc.trim.from);
    const xTo = frameToX(doc.trim.to);
    ctx.fillStyle = "rgba(5,6,10,.72)";
    if (xFrom > 0) ctx.fillRect(0, 0, xFrom, STRIP_H);
    if (xTo < w) ctx.fillRect(xTo, 0, w - xTo, STRIP_H);

    drawHandle(xFrom, drag === "trimFrom");
    drawHandle(xTo, drag === "trimTo");

    // Playhead.
    const xNow = frameToX(doc.current);
    ctx.fillStyle = "#7b6cff";
    ctx.fillRect(xNow - 1, 0, 2, STRIP_H);
    ctx.beginPath();
    ctx.arc(xNow, STRIP_H - 3, 4, 0, Math.PI * 2);
    ctx.fill();

    // Row 2: the selected layer's range.
    const y = STRIP_H + GAP;
    ctx.fillStyle = "rgba(255,255,255,.06)";
    ctx.fillRect(0, y, w, RANGE_H);

    const layer = selectedLayer(doc);
    if (layer) {
      const a = frameToX(layer.from);
      const b = frameToX(layer.to);
      ctx.fillStyle = layer.hidden ? "rgba(136,142,163,.5)" : "rgba(123,108,255,.85)";
      ctx.fillRect(a, y, Math.max(3, b - a), RANGE_H);
      ctx.fillStyle = "#e9ebf2";
      ctx.fillRect(a - 1, y, 3, RANGE_H);
      ctx.fillRect(b - 2, y, 3, RANGE_H);
    }
  }

  function pick(x, y) {
    const layer = selectedLayer(doc);

    // The lower row belongs to the selected layer. With nothing selected it is
    // inert - falling through to the strip would scrub the playhead from a click
    // that visually landed somewhere else entirely.
    if (y > STRIP_H + GAP - 4) {
      if (!layer) return null;
      if (Math.abs(x - frameToX(layer.from)) < HANDLE_GRAB) return "rangeFrom";
      if (Math.abs(x - frameToX(layer.to)) < HANDLE_GRAB) return "rangeTo";
      if (x > frameToX(layer.from) && x < frameToX(layer.to)) return "rangeMove";
      return null;
    }

    if (Math.abs(x - frameToX(doc.trim.from)) < HANDLE_GRAB) return "trimFrom";
    if (Math.abs(x - frameToX(doc.trim.to)) < HANDLE_GRAB) return "trimTo";
    return "seek";
  }

  function apply(x) {
    const at = xToFrame(x);
    const layer = selectedLayer(doc);

    if (drag === "seek") {
      doc.current = clamp(at, doc.trim.from, doc.trim.to);
      onChange("seek");
    } else if (drag === "trimFrom") {
      doc.trim.from = Math.min(at, doc.trim.to);
      doc.current = clamp(doc.current, doc.trim.from, doc.trim.to);
      onChange("trim");
    } else if (drag === "trimTo") {
      doc.trim.to = Math.max(at, doc.trim.from);
      doc.current = clamp(doc.current, doc.trim.from, doc.trim.to);
      onChange("trim");
    } else if (drag === "rangeFrom" && layer) {
      layer.from = clamp(Math.min(at, layer.to), doc.trim.from, doc.trim.to);
      onChange("range");
    } else if (drag === "rangeTo" && layer) {
      layer.to = clamp(Math.max(at, layer.from), doc.trim.from, doc.trim.to);
      onChange("range");
    } else if (drag === "rangeMove" && layer) {
      const span = layer.to - layer.from;
      const start = clamp(at - dragOffset, doc.trim.from, doc.trim.to - span);
      layer.from = start;
      layer.to = start + span;
      onChange("range");
    }
    draw();
  }

  const localX = (e) => e.clientX - canvas.getBoundingClientRect().left;
  const localY = (e) => e.clientY - canvas.getBoundingClientRect().top;

  canvas.addEventListener("pointerdown", (e) => {
    if (!doc) return;
    const x = localX(e), y = localY(e);
    const what = pick(x, y);
    if (!what) return;
    drag = what;
    if (what === "rangeMove") dragOffset = xToFrame(x) - selectedLayer(doc).from;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    apply(x);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!doc) return;
    if (!drag) {
      const what = pick(localX(e), localY(e));
      canvas.style.cursor =
        what === "seek" ? "pointer" : what === "rangeMove" ? "grab" : what ? "ew-resize" : "default";
      return;
    }
    apply(localX(e));
  });

  const end = (e) => {
    if (!drag) return;
    drag = null;
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    draw();
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  return {
    attach(next) { doc = next; cache = null; draw(); },
    detach() { doc = null; cache = null; },
    invalidate() { cache = null; draw(); },
    draw,
  };
}
