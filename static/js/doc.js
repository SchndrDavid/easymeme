/**
 * The document model.
 *
 * Everything the editor knows about the meme being built lives here. A still
 * photo is just a document with a single frame, which is what keeps the
 * original "photo + two white bars" path from needing a second code path.
 *
 * Coordinates on overlay layers are normalised 0..1 against the *image* area
 * (not the whole canvas, which grows and shrinks as caption bars appear). That
 * way a layer stays glued to the picture when a bar is typed in, and the same
 * numbers work for the on-screen preview and the full-size export.
 */

export const STILL_MAX_W = 1600;   // cap export width; phone photos are needlessly huge
export const STILL_MAX_H = 4096;   // and height: browsers (iOS Safari worst) refuse to
                                   // allocate a canvas past a few thousand px a side
export const ANIM_MAX_W = 640;     // a GIF frame is paid for 400 times over
export const ANIM_MIN_W = 240;
export const ANIM_CAP_W = 720;
export const MAX_FRAMES = 400;
export const MAX_VIDEO_SECONDS = 30;
export const DEFAULT_FPS = 12;

let nextId = 1;
const newId = () => "L" + nextId++;

export function createDoc({ kind, frames, width, height }) {
  return {
    kind,                       // "image" | "gif" | "video"
    frames,                     // [{ bitmap, delayMs }]
    width,                      // output width in px
    height,                     // output height of the picture area in px
    trim: { from: 0, to: frames.length - 1 },
    bars: { top: "", bottom: "", size: 56 },
    layers: [],                 // overlays, back to front
    current: 0,                 // frame under the playhead
    selected: null,             // id of the selected overlay layer
  };
}

export const isAnimated = (doc) => doc.frames.length > 1;

export const frameCount = (doc) => doc.trim.to - doc.trim.from + 1;

export function totalMs(doc) {
  let ms = 0;
  for (let i = doc.trim.from; i <= doc.trim.to; i++) ms += doc.frames[i].delayMs;
  return ms;
}

export const layerById = (doc, id) => doc.layers.find((l) => l.id === id) || null;

export const selectedLayer = (doc) => layerById(doc, doc.selected);

/** True when the layer should be painted on the given frame index. */
export const layerActiveAt = (layer, index) =>
  !layer.hidden && index >= layer.from && index <= layer.to;

export function addTextLayer(doc, { text = "" } = {}) {
  const layer = {
    id: newId(),
    type: "text",
    text,
    x: 0.5,
    y: 0.5,
    size: 70,                   // per-mille of width, same scale as the bars
    color: "#ffffff",
    stroke: "#000000",          // white-on-black outline is the meme default
    align: "center",
    width: 0.9,                 // wrap box, as a fraction of image width
    from: doc.trim.from,
    to: doc.trim.to,
    hidden: false,
  };
  doc.layers.push(layer);
  doc.selected = layer.id;
  return layer;
}

export function addStickerLayer(doc, { src, bitmap }) {
  const layer = {
    id: newId(),
    type: "sticker",
    src,                        // URL under /stickers/, kept so it can be re-fetched
    bitmap,
    x: 0.5,
    y: 0.5,
    scale: 0.45,                // width as a fraction of the image width
    rotation: 0,
    flipX: false,
    from: doc.trim.from,
    to: doc.trim.to,
    hidden: false,
  };
  doc.layers.push(layer);
  doc.selected = layer.id;
  return layer;
}

export function removeLayer(doc, id) {
  const i = doc.layers.findIndex((l) => l.id === id);
  if (i < 0) return;
  const [gone] = doc.layers.splice(i, 1);
  // Sticker bitmaps are decoded per layer, so the last reference dies with it.
  if (gone.bitmap && gone.bitmap.close) gone.bitmap.close();
  if (doc.selected === id) doc.selected = null;
}

/** Moves a layer one step towards the front (dir 1) or back (dir -1). */
export function reorderLayer(doc, id, dir) {
  const i = doc.layers.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= doc.layers.length) return;
  [doc.layers[i], doc.layers[j]] = [doc.layers[j], doc.layers[i]];
}

/** Frees every bitmap the document holds. Called before loading another file. */
export function disposeDoc(doc) {
  if (!doc) return;
  for (const f of doc.frames) if (f.bitmap && f.bitmap.close) f.bitmap.close();
  for (const l of doc.layers) if (l.bitmap && l.bitmap.close) l.bitmap.close();
}

/**
 * Keeps layer ranges inside the trim after the trim moves. A layer dragged
 * entirely outside the kept range would otherwise become invisible with no way
 * to get it back.
 */
export function clampLayersToTrim(doc) {
  const { from, to } = doc.trim;
  for (const l of doc.layers) {
    l.from = Math.min(Math.max(l.from, from), to);
    l.to = Math.min(Math.max(l.to, from), to);
    if (l.to < l.from) l.to = l.from;
  }
}
