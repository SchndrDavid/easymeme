/**
 * GIF -> frames.
 *
 * Two routes. ImageDecoder (WebCodecs) is the good one: the browser composites
 * the frames itself and hands back finished pictures with real durations. Where
 * it is missing we fall back to the vendored gifuct parser, which returns raw
 * delta patches - GIF frames are usually only the rectangle that changed, so
 * they have to be composited by hand or the animation comes out full of holes.
 */

import { parseGIF, decompressFrames } from "../../vendor/gifuct.esm.js";

// A GIF delay of 0 or 1 centiseconds means "as fast as possible", which every
// browser silently clamps to 100 ms. Match that, or a 0-delay GIF would export
// as an unwatchable strobe.
const sane = (ms) => (ms < 20 ? 100 : ms);

/**
 * Drops frames until the sequence fits the budget, folding each dropped frame's
 * delay into the frame that survives it so the animation keeps its real length.
 */
export function decimate(frames, maxFrames) {
  if (frames.length <= maxFrames) return frames;
  const step = Math.ceil(frames.length / maxFrames);
  const out = [];
  for (let i = 0; i < frames.length; i += step) {
    let delayMs = 0;
    for (let j = i; j < Math.min(i + step, frames.length); j++) delayMs += frames[j].delayMs;
    out.push({ bitmap: frames[i].bitmap, delayMs });
    // The frames being folded away are never drawn, so free them now.
    for (let j = i + 1; j < Math.min(i + step, frames.length); j++) {
      const b = frames[j].bitmap;
      if (b && b.close) b.close();
    }
  }
  return out;
}

/** Target size that respects maxWidth without upscaling anything. */
export function fitWidth(width, height, maxWidth) {
  const scale = Math.min(1, maxWidth / width);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function viaImageDecoder(data, target, onProgress) {
  const decoder = new ImageDecoder({ data, type: "image/gif" });
  await decoder.tracks.ready;
  // frameCount is only trustworthy once the whole buffer has been consumed.
  await decoder.completed;

  const track = decoder.tracks.selectedTrack;
  const count = track ? track.frameCount : 1;
  const frames = [];

  for (let i = 0; i < count; i++) {
    const { image } = await decoder.decode({ frameIndex: i });
    const bitmap = await createImageBitmap(image, {
      resizeWidth: target.width,
      resizeHeight: target.height,
      resizeQuality: "medium",
    });
    // VideoFrame durations are microseconds.
    frames.push({ bitmap, delayMs: sane(Math.round((image.duration || 0) / 1000)) });
    image.close();
    if (onProgress) onProgress((i + 1) / count);
  }

  decoder.close();
  return frames;
}

async function viaGifuct(data, target, onProgress) {
  const gif = parseGIF(data);
  const raw = decompressFrames(gif, true);
  if (!raw.length) throw new Error("no frames");

  const W = gif.lsd.width;
  const H = gif.lsd.height;

  const stage = document.createElement("canvas");
  stage.width = W;
  stage.height = H;
  const sctx = stage.getContext("2d", { willReadFrequently: true });

  const patch = document.createElement("canvas");
  const pctx = patch.getContext("2d");

  const frames = [];
  let previous = null;

  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];

    // Disposal 3 ("restore to previous") needs the state from before this frame.
    if (f.disposalType === 3) previous = sctx.getImageData(0, 0, W, H);

    patch.width = f.dims.width;
    patch.height = f.dims.height;
    pctx.putImageData(new ImageData(f.patch, f.dims.width, f.dims.height), 0, 0);
    sctx.drawImage(patch, f.dims.left, f.dims.top);

    frames.push({
      bitmap: await createImageBitmap(stage, {
        resizeWidth: target.width,
        resizeHeight: target.height,
        resizeQuality: "medium",
      }),
      delayMs: sane(f.delay),
    });

    if (f.disposalType === 2) {
      sctx.clearRect(f.dims.left, f.dims.top, f.dims.width, f.dims.height);
    } else if (f.disposalType === 3 && previous) {
      sctx.putImageData(previous, 0, 0);
    }

    if (onProgress) onProgress((i + 1) / raw.length);
  }

  return frames;
}

/**
 * Decodes a GIF file into scaled, fully composited frames.
 * Returns { frames, width, height, animated }.
 */
export async function decodeGif(file, { maxWidth, maxFrames, onProgress } = {}) {
  const data = await file.arrayBuffer();

  // The logical screen descriptor sits at a fixed offset, so the target size is
  // known before committing to either decoder.
  const head = new DataView(data);
  const srcW = head.getUint16(6, true);
  const srcH = head.getUint16(8, true);
  if (!srcW || !srcH) throw new Error("not a GIF");

  const target = fitWidth(srcW, srcH, maxWidth);

  let frames;
  if (typeof ImageDecoder !== "undefined") {
    try {
      frames = await viaImageDecoder(data, target, onProgress);
    } catch (_) {
      frames = null;   // fall through; some builds throw on unusual GIFs
    }
  }
  if (!frames || !frames.length) frames = await viaGifuct(data, target, onProgress);

  frames = decimate(frames, maxFrames);

  return {
    frames,
    width: target.width,
    height: target.height,
    animated: frames.length > 1,
  };
}
