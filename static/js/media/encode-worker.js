/**
 * GIF encoding worker.
 *
 * Quantising and LZW-compressing 400 frames takes seconds of solid CPU. Doing
 * that on the main thread would freeze the page, including the progress bar
 * meant to show it is working, so it happens here instead.
 *
 * The main thread renders each composed frame and ships the raw pixels over;
 * this side never touches the document model.
 */

import { GIFEncoder, quantize, applyPalette } from "../../vendor/gifenc.esm.js";

const FORMAT = "rgb565";      // 256 colours, and much faster to match than rgba4444
const MAX_COLORS = 256;

let encoder = null;
let palette = null;
let wrote = 0;

/**
 * One palette for the whole animation, built from a handful of sampled frames.
 * A per-frame palette would track colour changes slightly better but costs a
 * 768-byte local colour table on every single frame and a full quantise pass
 * with it - on a 400 frame GIF that is the difference between seconds and
 * minutes.
 */
function buildPalette(samples, stride) {
  let total = 0;
  for (const s of samples) total += s.length;

  const step = stride * 4;
  const kept = Math.floor(total / step);
  const flat = new Uint8Array(kept * 4);

  let out = 0;
  for (const sample of samples) {
    for (let i = 0; i + 3 < sample.length && out + 3 < flat.length; i += step) {
      flat[out++] = sample[i];
      flat[out++] = sample[i + 1];
      flat[out++] = sample[i + 2];
      flat[out++] = 255;
    }
  }

  return quantize(flat.subarray(0, out), MAX_COLORS, { format: FORMAT });
}

self.onmessage = (e) => {
  const msg = e.data;

  try {
    if (msg.type === "start") {
      encoder = GIFEncoder({ auto: true });
      wrote = 0;
      // Pixels are sampled sparsely: a palette does not get meaningfully better
      // from looking at every pixel of every sampled frame.
      palette = buildPalette(msg.samples.map((b) => new Uint8Array(b)), msg.stride || 7);
      self.postMessage({ type: "ready" });
      return;
    }

    if (msg.type === "frame") {
      const rgba = new Uint8Array(msg.buffer);
      const indexed = applyPalette(rgba, palette, FORMAT);
      // gifenc writes the palette handed to the first frame as the global colour
      // table; passing it again later would emit a redundant local table.
      encoder.writeFrame(indexed, msg.w, msg.h, {
        delay: msg.delay,
        repeat: 0,
        ...(wrote === 0 ? { palette } : {}),
      });
      wrote++;
      self.postMessage({ type: "frameDone", index: msg.index });
      return;
    }

    if (msg.type === "finish") {
      encoder.finish();
      const bytes = encoder.bytes();
      encoder = null;
      palette = null;
      self.postMessage({ type: "done", buffer: bytes.buffer }, [bytes.buffer]);
      return;
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
