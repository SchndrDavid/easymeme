/**
 * Subject cutout.
 *
 * u2netp (the 4.4 MB U^2-Net variant) run through onnxruntime-web, entirely in
 * the browser - the photo never leaves the device, only the finished sticker
 * does, and only when you press Save.
 *
 * Worth knowing about the model: it finds the *salient* object in the picture,
 * it is not prompted by where you tapped. One friend in the frame and it does
 * what you expect. A group, and it will lift the whole group - which is what
 * the Restore/Erase brushes are for.
 *
 * This module is imported lazily, so the 11 MB of runtime is only fetched by
 * people who actually cut something out.
 */

import { saveSticker } from "./stickers.js";

const SIZE = 320;          // u2netp's fixed input
const WORK_MAX = 1024;     // editing and export resolution cap
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const canvas = document.getElementById("cutoutCanvas");
const status = document.getElementById("cutoutStatus");
const brushSeg = document.getElementById("brushSeg");
const brushSize = document.getElementById("brushSize");
const brushSizeOut = document.getElementById("brushSizeOut");
const matteEdge = document.getElementById("matteEdge");
const matteEdgeOut = document.getElementById("matteEdgeOut");
const saveBtn = document.getElementById("cutSave");
const cancelBtn = document.getElementById("cutCancel");

const ctx = canvas.getContext("2d", { willReadFrequently: true });

let session = null;        // reused across cutouts; loading it twice is wasteful
let ortRef = null;

// Per-edit state.
let base = null;           // ImageData of the photo at working size
let raw = null;            // Float32Array, the model's matte, 0..1
let manual = null;         // Int8Array: 1 forced opaque, -1 forced clear, 0 model
let alpha = null;          // Uint8ClampedArray, what is actually drawn
let W = 0, H = 0;
let brush = "none";
let painting = false;
let closeEditor = null;
let notify = () => {};

/* ---------- model ---------- */

async function getSession(onStatus) {
  if (session) return session;

  onStatus("Loading the model…");
  const ort = ortRef || (ortRef = await import("/vendor/ort/ort.wasm.bundle.min.mjs"));

  // Without this the runtime goes looking for its .wasm on a CDN, which would
  // break the app for anyone running it offline. It has to be the object form
  // naming the .wasm outright: a bare prefix string makes the loader believe it
  // is being pointed at a full three-file distribution and go fetching
  // ort-wasm-simd-threaded.mjs, which the .bundle build inlines and so is not
  // vendored - see the comment in tools/fetch-vendor.mjs.
  ort.env.wasm.wasmPaths = { wasm: "/vendor/ort/ort-wasm-simd-threaded.wasm" };
  // Threads need SharedArrayBuffer, which needs COOP/COEP headers, which would
  // break the Google Fonts link. One thread it is - a cutout takes a second or
  // two rather than a fraction of one.
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = "error";

  session = await ort.InferenceSession.create("/vendor/u2netp.onnx", {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  return session;
}

function preprocess(bitmap) {
  const c = document.createElement("canvas");
  c.width = SIZE;
  c.height = SIZE;
  const cc = c.getContext("2d");
  cc.drawImage(bitmap, 0, 0, SIZE, SIZE);
  const { data } = cc.getImageData(0, 0, SIZE, SIZE);

  // NCHW, ImageNet normalisation - the preprocessing u2netp was trained with.
  const out = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = (data[i] / 255 - MEAN[0]) / STD[0];
    out[plane + p] = (data[i + 1] / 255 - MEAN[1]) / STD[1];
    out[plane * 2 + p] = (data[i + 2] / 255 - MEAN[2]) / STD[2];
  }
  return out;
}

/** Runs the model and returns its matte, bilinearly resized to W x H. */
async function infer(bitmap, onStatus) {
  const sess = await getSession(onStatus);
  onStatus("Finding the subject…");

  const ort = ortRef;
  const input = new ort.Tensor("float32", preprocess(bitmap), [1, 3, SIZE, SIZE]);
  // Names are read off the session rather than hardcoded: u2netp's are opaque
  // numbers that differ between exports of the same model.
  const results = await sess.run({ [sess.inputNames[0]]: input });
  const d0 = results[sess.outputNames[0]].data;

  // The network's output is unbounded; the reference implementation min-max
  // normalises it before treating it as a mask.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < d0.length; i++) {
    if (d0[i] < lo) lo = d0[i];
    if (d0[i] > hi) hi = d0[i];
  }
  const span = hi - lo || 1;

  const matte = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    // Sample the 320x320 matte at the working resolution, bilinearly - nearest
    // neighbour here shows up as visible stair-stepping on the sticker edge.
    const sy = (y / H) * (SIZE - 1);
    const y0 = Math.floor(sy), y1 = Math.min(SIZE - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = (x / W) * (SIZE - 1);
      const x0 = Math.floor(sx), x1 = Math.min(SIZE - 1, x0 + 1), fx = sx - x0;
      const a = d0[y0 * SIZE + x0], b = d0[y0 * SIZE + x1];
      const c = d0[y1 * SIZE + x0], e = d0[y1 * SIZE + x1];
      const top = a + (b - a) * fx;
      const bot = c + (e - c) * fx;
      matte[y * W + x] = (top + (bot - top) * fy - lo) / span;
    }
  }
  return matte;
}

/* ---------- editing ---------- */

const smoothstep = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

/** Rebuilds the visible alpha from the model matte, the slider and the brushes. */
function recompute() {
  // 0 keeps every hint of the subject, 100 cuts tight to the confident core.
  const t = Number(matteEdge.value) / 100;
  const lo = t - 0.28;
  const hi = t + 0.28;

  for (let i = 0; i < alpha.length; i++) {
    if (manual[i] === 1) { alpha[i] = 255; continue; }
    if (manual[i] === -1) { alpha[i] = 0; continue; }
    alpha[i] = Math.round(smoothstep(lo, hi, raw[i]) * 255);
  }
}

function paint() {
  const img = new ImageData(new Uint8ClampedArray(base.data), W, H);
  for (let i = 0, p = 3; i < alpha.length; i++, p += 4) img.data[p] = alpha[i];
  ctx.putImageData(img, 0, 0);
}

function stamp(px, py) {
  // clientWidth is 0 while the panel is hidden; fall back to 1:1 rather than
  // producing an infinite radius.
  const shown = canvas.clientWidth || W;
  const r = (Number(brushSize.value) / shown) * W;
  const value = brush === "add" ? 1 : -1;
  const r2 = r * r;

  const x0 = Math.max(0, Math.floor(px - r)), x1 = Math.min(W - 1, Math.ceil(px + r));
  const y0 = Math.max(0, Math.floor(py - r)), y1 = Math.min(H - 1, Math.ceil(py + r));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - px, dy = y - py;
      if (dx * dx + dy * dy <= r2) {
        const i = y * W + x;
        manual[i] = value;
        alpha[i] = value === 1 ? 255 : 0;
      }
    }
  }
}

function pointerPos(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * W,
    y: ((e.clientY - r.top) / r.height) * H,
  };
}

canvas.addEventListener("pointerdown", (e) => {
  if (brush === "none" || !alpha) return;
  painting = true;
  canvas.setPointerCapture(e.pointerId);
  const p = pointerPos(e);
  stamp(p.x, p.y);
  paint();
  e.preventDefault();
});

canvas.addEventListener("pointermove", (e) => {
  if (!painting) return;
  const p = pointerPos(e);
  stamp(p.x, p.y);
  paint();
});

const stopPainting = () => { painting = false; };
canvas.addEventListener("pointerup", stopPainting);
canvas.addEventListener("pointercancel", stopPainting);

brushSeg.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  brush = b.dataset.brush;
  for (const other of brushSeg.querySelectorAll("button")) other.classList.toggle("on", other === b);
  canvas.style.cursor = brush === "none" ? "default" : "crosshair";
});

brushSize.addEventListener("input", () => { brushSizeOut.textContent = brushSize.value; });

matteEdge.addEventListener("input", () => {
  matteEdgeOut.textContent = matteEdge.value;
  if (!alpha) return;
  recompute();
  paint();
});

/* ---------- saving ---------- */

/** Trims the transparent border so the sticker is the subject, not a mostly
 *  empty rectangle the size of the original photo. */
function cropped() {
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (alpha[y * W + x] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  const pad = 2;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(W - 1, maxX + pad); maxY = Math.min(H - 1, maxY + pad);

  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d").drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

saveBtn.addEventListener("click", async () => {
  const out = cropped();
  if (!out) { notify("Nothing left to save - the whole picture was erased."); return; }

  saveBtn.disabled = true;
  status.textContent = "Saving…";
  try {
    const blob = await new Promise((r) => out.toBlob(r, "image/png"));
    if (!blob) throw new Error("could not encode the PNG");
    await saveSticker(blob);
    if (closeEditor) closeEditor();
  } catch (err) {
    notify("Could not save the sticker: " + err.message);
    status.textContent = "Saving failed.";
  } finally {
    saveBtn.disabled = false;
  }
});

cancelBtn.addEventListener("click", () => { if (closeEditor) closeEditor(); });

/* ---------- entry point ---------- */

/**
 * Opens the editor on a decoded image and runs the model over it.
 * `onClose` puts the rest of the UI back.
 */
export async function runCutout(source, opts) {
  notify = opts.notify || notify;
  closeEditor = opts.onClose;

  saveBtn.disabled = true;
  brush = "none";
  for (const b of brushSeg.querySelectorAll("button")) b.classList.toggle("on", b.dataset.brush === "none");
  canvas.style.cursor = "default";

  // Work at a capped resolution: a 12 MP phone photo would make the brush
  // crawl and produce a sticker far larger than the 4 MB upload limit.
  const scale = Math.min(1, WORK_MAX / Math.max(source.width, source.height));
  W = Math.max(1, Math.round(source.width * scale));
  H = Math.max(1, Math.round(source.height * scale));

  canvas.width = W;
  canvas.height = H;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(source, 0, 0, W, H);
  base = ctx.getImageData(0, 0, W, H);

  const setStatus = (t) => { status.textContent = t; };
  setStatus("Loading the model…");

  // Let the browser paint the panel and the status line before the main thread
  // disappears into inference for a second or two.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  raw = await infer(source, setStatus);
  manual = new Int8Array(W * H);
  alpha = new Uint8ClampedArray(W * H);

  recompute();
  paint();

  saveBtn.disabled = false;
  setStatus("Brush over anything it got wrong, then save.");
}
