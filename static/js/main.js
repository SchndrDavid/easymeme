/**
 * EasyMeme - wiring.
 *
 * Owns the current document, the DOM, and the traffic between them. All the
 * actual work lives in the modules this imports; what is here is event handling
 * and keeping the panels in sync with the state.
 */

import {
  STILL_MAX_W, STILL_MAX_H, ANIM_MAX_W, ANIM_MIN_W, ANIM_CAP_W,
  MAX_FRAMES, MAX_VIDEO_SECONDS, DEFAULT_FPS,
  createDoc, isAnimated, totalMs, addTextLayer, addStickerLayer,
  removeLayer, reorderLayer, disposeDoc, clampLayersToTrim,
  selectedLayer, layerById,
} from "./doc.js";
import { layout, renderFrame, layerBounds, hitTest } from "./render.js";
import { createTimeline } from "./timeline.js";
import { decodeGif, fitWidth } from "./media/gif.js";
import { openVideo, extractFrames } from "./media/video.js";
import { encodeGif, estimateBytes, formatBytes } from "./media/encode.js";
import { initStickers } from "./stickers.js";

const JPEG_Q = 0.92;
const LONG_PRESS_MS = 550;

const $ = (id) => document.getElementById(id);

const el = {
  drop: $("drop"), dropSub: $("dropSub"),
  canvasWrap: $("canvasWrap"), canvas: $("canvas"), selBox: $("selBox"),
  busy: $("busy"), busyFill: $("busyFill"), busyLabel: $("busyLabel"),

  clipPanel: $("clipPanel"), clipInfo: $("clipInfo"),
  clipStartRow: $("clipStartRow"), clipStart: $("clipStart"), clipStartOut: $("clipStartOut"),
  clipLen: $("clipLen"), clipLenOut: $("clipLenOut"),
  clipFps: $("clipFps"), clipFpsOut: $("clipFpsOut"),
  clipGo: $("clipGo"), clipCancel: $("clipCancel"),

  timelinePanel: $("timelinePanel"), timeline: $("timeline"),
  playBtn: $("playBtn"), tlPos: $("tlPos"), tlSize: $("tlSize"),
  outWidth: $("outWidth"), outWidthOut: $("outWidthOut"),

  tabs: $("tabs"),
  tabBars: $("tab-bars"), tabLayers: $("tab-layers"), tabStickers: $("tab-stickers"),

  top: $("topText"), bot: $("botText"), size: $("size"),

  addTextBtn: $("addTextBtn"), layerList: $("layerList"), layerEditor: $("layerEditor"),
  textFields: $("textFields"), layerText: $("layerText"),
  rowLayerSize: $("rowLayerSize"), layerSize: $("layerSize"), layerSizeOut: $("layerSizeOut"),
  rowTextStyle: $("rowTextStyle"), layerColor: $("layerColor"), layerStroke: $("layerStroke"),
  alignSeg: $("alignSeg"),
  rowStickerScale: $("rowStickerScale"), layerScale: $("layerScale"), layerScaleOut: $("layerScaleOut"),
  rowStickerRot: $("rowStickerRot"), layerRot: $("layerRot"), layerRotOut: $("layerRotOut"),
  layerFlip: $("layerFlip"), layerBack: $("layerBack"), layerFwd: $("layerFwd"),
  layerDelete: $("layerDelete"), rangeHint: $("rangeHint"),

  cutBtn: $("cutBtn"),
  cutoutPanel: $("cutoutPanel"),

  actions: $("actions"), shareBtn: $("shareBtn"), dlBtn: $("dlBtn"), newBtn: $("newBtn"),
  hint: $("hint"),
  file: $("file"), cutFile: $("cutFile"),
};

const ctx = el.canvas.getContext("2d");

let doc = null;
let pending = null;      // an opened video waiting for its window to be chosen
let tab = "bars";
let playing = 0;         // timer id

const HINT_TEXT = el.hint.textContent;
let hintTimer = 0;

/* ---------- chrome ---------- */

// The drop panel is gone once a file is loaded, so a bad file dropped later has
// to report itself somewhere that is still on screen.
function notify(msg) {
  if (!el.drop.hidden) { el.dropSub.textContent = msg; return; }
  clearTimeout(hintTimer);
  el.hint.textContent = msg;
  hintTimer = setTimeout(() => { el.hint.textContent = HINT_TEXT; }, 5000);
}

function busy(label, progress) {
  if (label === null) { el.busy.hidden = true; return; }
  el.busy.hidden = false;
  el.busyLabel.textContent = label;
  el.busyFill.style.width = Math.round((progress || 0) * 100) + "%";
}

function showTab(name) {
  tab = name;
  for (const b of el.tabs.querySelectorAll("button")) b.classList.toggle("on", b.dataset.tab === name);
  el.tabBars.hidden = name !== "bars";
  el.tabLayers.hidden = name !== "layers";
  el.tabStickers.hidden = name !== "stickers";
}

/* ---------- rendering ---------- */

const timeline = createTimeline(el.timeline, {
  onChange(kind) {
    if (kind === "trim") clampLayersToTrim(doc);
    if (kind === "range") renderLayerList();
    stopPlayback();
    paint();
  },
});

function paint() {
  if (!doc) return;
  const L = renderFrame(ctx, doc, doc.current);
  drawSelection(L);
  updateTimelineMeta();
}

function drawSelection(L) {
  const layer = selectedLayer(doc);
  const active = layer && !layer.hidden && doc.current >= layer.from && doc.current <= layer.to;
  if (!active) { el.selBox.hidden = true; return; }

  const b = layerBounds(doc, layer, L);
  if (!b) { el.selBox.hidden = true; return; }

  // Canvas pixels are not CSS pixels: the canvas is laid out at 100% width.
  const rect = el.canvas.getBoundingClientRect();
  const k = rect.width / el.canvas.width;
  const pad = 6;
  el.selBox.hidden = false;
  el.selBox.style.left = (b.x * k - pad) + "px";
  el.selBox.style.top = (b.y * k - pad) + "px";
  el.selBox.style.width = (b.w * k + pad * 2) + "px";
  el.selBox.style.height = (b.h * k + pad * 2) + "px";
}

function updateTimelineMeta() {
  if (!doc || !isAnimated(doc)) return;
  const n = doc.trim.to - doc.trim.from + 1;
  el.tlPos.textContent =
    (doc.current - doc.trim.from + 1) + " / " + n + " · " + (totalMs(doc) / 1000).toFixed(1) + " s";

  const est = estimateBytes(doc);
  el.tlSize.textContent = "~" + formatBytes(est);
  el.tlSize.className = est > 25 * 1048576 ? "warn" : "";
}

/* ---------- loading ---------- */

async function decodeStill(file) {
  // createImageBitmap honours EXIF orientation, which matters for iPhone shots.
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (_) { /* older Safari falls through to the <img> path */ }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
    img.src = url;
  });
}

function adopt(next) {
  disposeDoc(doc);
  doc = next;

  el.drop.hidden = true;
  el.canvasWrap.hidden = false;
  el.tabs.hidden = false;
  el.actions.hidden = false;
  el.hint.hidden = false;
  el.clipPanel.hidden = true;
  clearTimeout(hintTimer);
  el.hint.textContent = HINT_TEXT;

  const anim = isAnimated(doc);
  el.timelinePanel.hidden = !anim;
  el.rangeHint.hidden = !anim;
  el.dlBtn.lastChild.textContent = anim ? " Download GIF" : " Download";

  if (anim) {
    el.outWidth.max = Math.min(ANIM_CAP_W, doc.sourceWidth);
    el.outWidth.min = Math.min(ANIM_MIN_W, doc.sourceWidth);
    el.outWidth.value = doc.width;
    el.outWidthOut.textContent = doc.width + " px";
    timeline.attach(doc);
  } else {
    timeline.detach();
  }

  el.top.value = "";
  el.bot.value = "";
  // The slider keeps whatever the user last chose, so the document has to adopt
  // it rather than silently reverting to the default.
  doc.bars.size = Number(el.size.value);
  showTab("bars");
  renderLayerList();
  paint();
}

async function loadImage(file) {
  const bitmap = await decodeStill(file);
  // Same cap as the original build, and applied the same way: the full-res
  // bitmap is kept and scaled at draw time, so the output is byte-comparable.
  const scale = Math.min(1, STILL_MAX_W / bitmap.width, STILL_MAX_H / bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const next = createDoc({ kind: "image", frames: [{ bitmap, delayMs: 100 }], width, height });
  next.sourceWidth = bitmap.width;
  next.sourceHeight = bitmap.height;
  adopt(next);
}

async function loadGif(file) {
  busy("Reading GIF…", 0);
  try {
    const out = await decodeGif(file, {
      maxWidth: ANIM_MAX_W,
      maxFrames: MAX_FRAMES,
      onProgress: (p) => busy("Reading GIF…", p),
    });
    // A GIF with one frame is a photo wearing a GIF hat, and it has just been
    // shrunk to the animated width budget for no reason. Decode it again on the
    // still path so it gets the full 1600px cap.
    if (!out.animated) {
      for (const f of out.frames) if (f.bitmap && f.bitmap.close) f.bitmap.close();
      await loadImage(file);
      return;
    }

    const next = createDoc({
      kind: "gif",
      frames: out.frames,
      width: out.width,
      height: out.height,
    });
    next.sourceWidth = out.width;
    next.sourceHeight = out.height;
    adopt(next);
  } finally {
    busy(null);
  }
}

async function loadVideo(file) {
  const handle = await openVideo(file);
  if (pending) pending.close();
  pending = handle;

  const long = handle.duration > MAX_VIDEO_SECONDS;
  el.clipInfo.textContent =
    handle.width + "×" + handle.height + " · " + handle.duration.toFixed(1) + " s" +
    (long ? " · pick a " + MAX_VIDEO_SECONDS + " s window" : "");

  el.clipStartRow.hidden = !long;
  el.clipStart.max = Math.max(0, handle.duration - 1).toFixed(1);
  el.clipStart.value = 0;
  el.clipStartOut.textContent = "0.0 s";

  const maxLen = Math.min(MAX_VIDEO_SECONDS, handle.duration);
  el.clipLen.max = maxLen.toFixed(1);
  el.clipLen.value = maxLen.toFixed(1);
  el.clipLenOut.textContent = maxLen.toFixed(1) + " s";

  el.clipFps.value = DEFAULT_FPS;
  el.clipFpsOut.textContent = DEFAULT_FPS;

  el.clipPanel.hidden = false;
  el.tabs.hidden = true;
  el.tabBars.hidden = true;
  el.tabLayers.hidden = true;
  el.tabStickers.hidden = true;
  el.actions.hidden = true;
  el.timelinePanel.hidden = true;
}

async function commitVideo() {
  if (!pending) return;
  const start = Number(el.clipStart.value);
  const seconds = Math.min(Number(el.clipLen.value), pending.duration - start);
  const fps = Number(el.clipFps.value);

  el.clipPanel.hidden = true;
  busy("Grabbing frames…", 0);
  try {
    const out = await extractFrames(pending, {
      start,
      seconds,
      fps,
      maxWidth: ANIM_MAX_W,
      maxFrames: MAX_FRAMES,
      onProgress: (p) => busy("Grabbing frames…", p),
    });
    const next = createDoc({
      kind: "video",
      frames: out.frames,
      width: out.width,
      height: out.height,
    });
    next.sourceWidth = out.width;
    next.sourceHeight = out.height;
    adopt(next);
  } catch (err) {
    notify("Could not read that clip: " + err.message);
    el.drop.hidden = false;
  } finally {
    busy(null);
    pending.close();
    pending = null;
  }
}

async function load(file) {
  if (!file) return;
  stopPlayback();

  const type = file.type || "";
  try {
    if (type === "image/gif" || /\.gif$/i.test(file.name || "")) {
      await loadGif(file);
    } else if (type.startsWith("video/")) {
      await loadVideo(file);
    } else if (!type || type.startsWith("image/")) {
      // Some drag sources hand over an empty MIME type, so only reject a type we
      // positively know is wrong and let the decoder judge the rest.
      await loadImage(file);
    } else {
      notify("That is not an image, GIF or video.");
    }
  } catch (err) {
    notify("That file could not be opened. Try another.");
  }
}

/* ---------- canvas interaction ---------- */

function canvasPoint(e) {
  const r = el.canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (el.canvas.width / r.width),
    y: (e.clientY - r.top) * (el.canvas.height / r.height),
  };
}

let dragging = null;
let pressTimer = 0;

el.canvas.addEventListener("pointerdown", (e) => {
  if (!doc) return;
  const p = canvasPoint(e);
  const L = layout(doc);
  const hit = hitTest(doc, p.x, p.y, L);

  if (hit) {
    doc.selected = hit.id;
    dragging = {
      id: hit.id,
      dx: hit.x - p.x / L.w,
      dy: hit.y - (p.y - L.imgY) / L.h,
    };
    el.canvas.setPointerCapture(e.pointerId);
    showTab("layers");
    renderLayerList();
    syncLayerEditor();
    paint();
    e.preventDefault();
    return;
  }

  doc.selected = null;
  renderLayerList();
  paint();

  // Press and hold on a still with nothing under the finger: lift the subject,
  // the way the phone photo apps do it.
  if (!isAnimated(doc)) {
    pressTimer = setTimeout(() => {
      pressTimer = 0;
      openCutout(doc.frames[0].bitmap);
    }, LONG_PRESS_MS);
  }
});

el.canvas.addEventListener("pointermove", (e) => {
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0; }
  if (!dragging || !doc) return;
  const layer = layerById(doc, dragging.id);
  if (!layer) return;
  const L = layout(doc);
  const p = canvasPoint(e);
  layer.x = Math.min(1.2, Math.max(-0.2, p.x / L.w + dragging.dx));
  layer.y = Math.min(1.2, Math.max(-0.2, (p.y - L.imgY) / L.h + dragging.dy));
  paint();
});

const endCanvasDrag = (e) => {
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0; }
  if (!dragging) return;
  dragging = null;
  if (el.canvas.hasPointerCapture && el.canvas.hasPointerCapture(e.pointerId)) {
    el.canvas.releasePointerCapture(e.pointerId);
  }
};
el.canvas.addEventListener("pointerup", endCanvasDrag);
el.canvas.addEventListener("pointercancel", endCanvasDrag);

/* ---------- layer list and editor ---------- */

const ICON_EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 6.1A9.9 9.9 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.3 3.9M6.3 8.2A16.7 16.7 0 0 0 2 12s3.5 6 10 6c1.2 0 2.3-.2 3.3-.5"/></svg>';

function layerName(layer) {
  if (layer.type === "sticker") return "Sticker";
  return layer.text ? layer.text.replace(/\s+/g, " ").slice(0, 40) : "Empty text";
}

function renderLayerList() {
  el.layerList.innerHTML = "";
  // Front-most first: that is the order they sit on the picture.
  for (let i = doc ? doc.layers.length - 1 : -1; i >= 0; i--) {
    const layer = doc.layers[i];
    const li = document.createElement("li");
    li.className = "layer-row" + (layer.id === doc.selected ? " on" : "") + (layer.hidden ? " off" : "");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = layerName(layer);
    li.appendChild(name);

    if (isAnimated(doc)) {
      const range = document.createElement("span");
      range.className = "range";
      range.textContent = (layer.from + 1) + "–" + (layer.to + 1);
      li.appendChild(range);
    }

    const eye = document.createElement("button");
    eye.className = "icon-btn";
    eye.type = "button";
    eye.title = layer.hidden ? "Show" : "Hide";
    eye.innerHTML = layer.hidden ? ICON_EYE_OFF : ICON_EYE;
    eye.addEventListener("click", (ev) => {
      ev.stopPropagation();
      layer.hidden = !layer.hidden;
      renderLayerList();
      paint();
      if (isAnimated(doc)) timeline.draw();
    });
    li.appendChild(eye);

    li.addEventListener("click", () => {
      doc.selected = layer.id;
      renderLayerList();
      syncLayerEditor();
      paint();
      if (isAnimated(doc)) timeline.draw();
    });

    el.layerList.appendChild(li);
  }
  syncLayerEditor();
}

function syncLayerEditor() {
  const layer = doc && selectedLayer(doc);
  el.layerEditor.hidden = !layer;
  if (!layer) return;

  const isText = layer.type === "text";
  el.textFields.hidden = !isText;
  el.rowLayerSize.hidden = !isText;
  el.rowTextStyle.hidden = !isText;
  el.rowStickerScale.hidden = isText;
  el.rowStickerRot.hidden = isText;
  el.layerFlip.hidden = isText;
  el.rangeHint.hidden = !isAnimated(doc);

  if (isText) {
    el.layerText.value = layer.text;
    el.layerSize.value = layer.size;
    el.layerSizeOut.textContent = layer.size;
    el.layerColor.value = layer.color;
    el.layerStroke.value = layer.stroke || "#000000";
    for (const b of el.alignSeg.querySelectorAll("button")) {
      b.classList.toggle("on", b.dataset.align === layer.align);
    }
  } else {
    el.layerScale.value = Math.round(layer.scale * 100);
    el.layerScaleOut.textContent = Math.round(layer.scale * 100) + "%";
    const deg = Math.round((layer.rotation * 180) / Math.PI);
    el.layerRot.value = deg;
    el.layerRotOut.textContent = deg + "°";
  }
}

function editSelected(fn) {
  const layer = selectedLayer(doc);
  if (!layer) return;
  fn(layer);
  paint();
}

el.addTextBtn.addEventListener("click", () => {
  if (!doc) return;
  addTextLayer(doc, { text: "TEXT" });
  showTab("layers");
  renderLayerList();
  paint();
  if (isAnimated(doc)) timeline.draw();
  el.layerText.focus();
  el.layerText.select();
});

el.layerText.addEventListener("input", () => {
  editSelected((l) => { l.text = el.layerText.value; });
  const row = el.layerList.querySelector(".layer-row.on .name");
  if (row) row.textContent = layerName(selectedLayer(doc));
});

el.layerSize.addEventListener("input", () => {
  el.layerSizeOut.textContent = el.layerSize.value;
  editSelected((l) => { l.size = Number(el.layerSize.value); });
});
el.layerColor.addEventListener("input", () => editSelected((l) => { l.color = el.layerColor.value; }));
el.layerStroke.addEventListener("input", () => editSelected((l) => { l.stroke = el.layerStroke.value; }));

el.alignSeg.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  editSelected((l) => { l.align = b.dataset.align; });
  syncLayerEditor();
});

el.layerScale.addEventListener("input", () => {
  el.layerScaleOut.textContent = el.layerScale.value + "%";
  editSelected((l) => { l.scale = Number(el.layerScale.value) / 100; });
});
el.layerRot.addEventListener("input", () => {
  el.layerRotOut.textContent = el.layerRot.value + "°";
  editSelected((l) => { l.rotation = (Number(el.layerRot.value) * Math.PI) / 180; });
});
el.layerFlip.addEventListener("click", () => editSelected((l) => { l.flipX = !l.flipX; }));

el.layerBack.addEventListener("click", () => {
  if (!doc || !doc.selected) return;
  reorderLayer(doc, doc.selected, -1);
  renderLayerList();
  paint();
});
el.layerFwd.addEventListener("click", () => {
  if (!doc || !doc.selected) return;
  reorderLayer(doc, doc.selected, 1);
  renderLayerList();
  paint();
});
el.layerDelete.addEventListener("click", () => {
  if (!doc || !doc.selected) return;
  removeLayer(doc, doc.selected);
  renderLayerList();
  paint();
  if (isAnimated(doc)) timeline.draw();
});

/* ---------- bars ---------- */

const onBars = () => {
  if (!doc) return;
  doc.bars.top = el.top.value;
  doc.bars.bottom = el.bot.value;
  doc.bars.size = Number(el.size.value);
  paint();
};
el.top.addEventListener("input", onBars);
el.bot.addEventListener("input", onBars);
el.size.addEventListener("input", onBars);

/* ---------- timeline controls ---------- */

el.outWidth.addEventListener("input", () => {
  if (!doc) return;
  const w = Number(el.outWidth.value);
  const fit = fitWidth(doc.sourceWidth, doc.sourceHeight, w);
  doc.width = fit.width;
  doc.height = fit.height;
  el.outWidthOut.textContent = fit.width + " px";
  paint();
});

function stopPlayback() {
  if (playing) { clearTimeout(playing); playing = 0; }
  el.playBtn.textContent = "Play";
}

el.playBtn.addEventListener("click", () => {
  if (!doc || !isAnimated(doc)) return;
  if (playing) { stopPlayback(); return; }
  el.playBtn.textContent = "Pause";

  const tick = () => {
    doc.current = doc.current >= doc.trim.to ? doc.trim.from : doc.current + 1;
    paint();
    timeline.draw();
    playing = setTimeout(tick, doc.frames[doc.current].delayMs);
  };
  playing = setTimeout(tick, doc.frames[doc.current].delayMs);
});

document.addEventListener("keydown", (e) => {
  if (!doc || !isAnimated(doc)) return;
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
  if (typing) return;

  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    stopPlayback();
    const step = e.key === "ArrowRight" ? 1 : -1;
    doc.current = Math.min(doc.trim.to, Math.max(doc.trim.from, doc.current + step));
    paint();
    timeline.draw();
  } else if (e.code === "Space") {
    e.preventDefault();
    el.playBtn.click();
  }
});

/* ---------- clip panel ---------- */

el.clipStart.addEventListener("input", () => {
  el.clipStartOut.textContent = Number(el.clipStart.value).toFixed(1) + " s";
  if (!pending) return;
  const room = pending.duration - Number(el.clipStart.value);
  const cap = Math.min(MAX_VIDEO_SECONDS, room);
  el.clipLen.max = cap.toFixed(1);
  if (Number(el.clipLen.value) > cap) {
    el.clipLen.value = cap.toFixed(1);
    el.clipLenOut.textContent = cap.toFixed(1) + " s";
  }
});
el.clipLen.addEventListener("input", () => {
  el.clipLenOut.textContent = Number(el.clipLen.value).toFixed(1) + " s";
});
el.clipFps.addEventListener("input", () => {
  el.clipFpsOut.textContent = el.clipFps.value;
});
el.clipGo.addEventListener("click", commitVideo);
el.clipCancel.addEventListener("click", () => {
  if (pending) { pending.close(); pending = null; }
  el.clipPanel.hidden = true;
  if (doc) {
    el.tabs.hidden = false;
    el.actions.hidden = false;
    el.timelinePanel.hidden = !isAnimated(doc);
    showTab(tab);
  } else {
    el.drop.hidden = false;
  }
});

/* ---------- stickers and cutout ---------- */

initStickers({
  onPick: async (sticker) => {
    if (!doc) { notify("Load a photo or GIF first."); return; }
    try {
      const res = await fetch(sticker.url);
      const bitmap = await createImageBitmap(await res.blob());
      addStickerLayer(doc, { src: sticker.url, bitmap });
      showTab("layers");
      renderLayerList();
      paint();
      if (isAnimated(doc)) timeline.draw();
    } catch (_) {
      notify("That sticker could not be loaded.");
    }
  },
  notify,
});

async function openCutout(source) {
  const { runCutout } = await import("./cutout.js");
  // Every panel steps aside while the cutout editor is open, so there is only
  // ever one thing on screen asking for input.
  const restore = () => {
    el.cutoutPanel.hidden = true;
    el.tabs.hidden = !doc;
    el.actions.hidden = !doc;
    el.canvasWrap.hidden = !doc;
    el.timelinePanel.hidden = !(doc && isAnimated(doc));
    if (doc) showTab(tab);
  };

  el.tabs.hidden = true;
  el.tabBars.hidden = true;
  el.tabLayers.hidden = true;
  el.tabStickers.hidden = true;
  el.actions.hidden = true;
  el.canvasWrap.hidden = true;
  el.timelinePanel.hidden = true;
  el.cutoutPanel.hidden = false;

  try {
    await runCutout(source, { notify, onClose: restore });
  } catch (err) {
    notify("Cutting failed: " + err.message);
    restore();
  }
}

el.cutBtn.addEventListener("click", () => el.cutFile.click());
el.cutFile.addEventListener("change", async () => {
  const f = el.cutFile.files && el.cutFile.files[0];
  el.cutFile.value = "";
  if (!f) return;
  try {
    openCutout(await decodeStill(f));
  } catch (_) {
    notify("That photo could not be opened.");
  }
});

/* ---------- export ---------- */

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

async function buildFile() {
  if (isAnimated(doc)) {
    stopPlayback();
    busy("Encoding GIF…", 0);
    try {
      const blob = await encodeGif(doc, { onProgress: (p) => busy("Encoding GIF…", p) });
      return new File([blob], "easymeme-" + stamp() + ".gif", { type: "image/gif" });
    } finally {
      busy(null);
      paint();
    }
  }

  // Stills keep the original path: render once, JPEG at 0.92.
  renderFrame(ctx, doc, 0);
  const blob = await new Promise((r) => el.canvas.toBlob(r, "image/jpeg", JPEG_Q));
  paint();
  if (!blob) return null;
  return new File([blob], "easymeme-" + stamp() + ".jpg", { type: "image/jpeg" });
}

function saveFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function download() {
  if (!doc) return;
  const file = await buildFile();
  if (file) saveFile(file);
}

async function share() {
  if (!doc) return;
  const file = await buildFile();
  if (!file) return;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err && err.name === "AbortError") return;   // user dismissed the sheet
      saveFile(file);
    }
  } else {
    saveFile(file);
  }
}

// canShare is the only reliable signal for file sharing support, so probe it
// with a throwaway file before offering the button.
if (navigator.canShare && window.File) {
  try {
    const probe = new File([new Blob([""], { type: "image/jpeg" })], "p.jpg", { type: "image/jpeg" });
    if (navigator.canShare({ files: [probe] })) el.shareBtn.hidden = false;
  } catch (_) { /* leave Share hidden */ }
}

/* ---------- events ---------- */

const pick = () => el.file.click();

el.drop.addEventListener("click", pick);
el.drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
});
el.newBtn.addEventListener("click", pick);

el.file.addEventListener("change", () => {
  load(el.file.files && el.file.files[0]);
  el.file.value = "";   // re-picking the same file must still fire change
});

el.tabs.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) showTab(b.dataset.tab);
});

el.dlBtn.addEventListener("click", download);
el.shareBtn.addEventListener("click", share);

["dragenter", "dragover"].forEach((t) =>
  el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) =>
  el.drop.addEventListener(t, () => el.drop.classList.remove("over")));

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) load(f);
});

document.addEventListener("paste", (e) => {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) load(files[0]);
});

window.addEventListener("resize", () => {
  if (!doc) return;
  paint();
  if (isAnimated(doc)) timeline.invalidate();
});

// Text is measured in Archivo, so re-render once the webfont lands or the bars
// stay sized for the fallback face.
if (document.fonts && document.fonts.load) {
  document.fonts.load('600 40px Archivo').then(() => { if (doc) paint(); }).catch(() => {});
}

if (matchMedia("(pointer:fine)").matches) {
  el.dropSub.textContent = "Click to choose · or drop / paste a file";
}
