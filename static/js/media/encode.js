/**
 * Drives the GIF encoding worker.
 *
 * Frames are composed here (the worker has no access to the document model) and
 * handed over one at a time, waiting for each to be encoded before rendering the
 * next. That handshake is what keeps memory flat: a 400 frame animation never
 * has more than one uncompressed frame in flight instead of 400.
 */

import { layout, renderFrame } from "../render.js";

const PALETTE_SAMPLES = 12;

export function estimateBytes(doc) {
  const L = layout(doc);
  const frames = doc.trim.to - doc.trim.from + 1;
  // ~0.55 bytes per pixel per frame is what LZW tends to land on for photo-like
  // content at 256 colours. It is a rule of thumb for the warning label, not a
  // promise - the real number comes out of the encoder.
  return Math.round(L.canvasW * L.canvasH * frames * 0.55);
}

export function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " kB";
  return (n / 1048576).toFixed(1) + " MB";
}

/**
 * Renders and encodes the trimmed range of `doc` as an animated GIF.
 * `onProgress` is called with 0..1. Resolves to a Blob.
 */
export function encodeGif(doc, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const L = layout(doc);
    const stage = document.createElement("canvas");
    stage.width = L.canvasW;
    stage.height = L.canvasH;
    const ctx = stage.getContext("2d", { willReadFrequently: true });

    const first = doc.trim.from;
    const last = doc.trim.to;
    const total = last - first + 1;

    const worker = new Worker(new URL("./encode-worker.js", import.meta.url), { type: "module" });

    let index = first;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const pixelsFor = (i) => {
      renderFrame(ctx, doc, i, L);
      return ctx.getImageData(0, 0, L.canvasW, L.canvasH).data;
    };

    const sendFrame = () => {
      if (index > last) {
        worker.postMessage({ type: "finish" });
        return;
      }
      const data = pixelsFor(index);
      const buffer = data.buffer;
      worker.postMessage(
        {
          type: "frame",
          index,
          buffer,
          w: L.canvasW,
          h: L.canvasH,
          delay: doc.frames[index].delayMs,
        },
        [buffer],
      );
    };

    worker.onerror = (e) => fail(new Error(e.message || "encoder worker failed"));

    worker.onmessage = (e) => {
      const msg = e.data;

      if (msg.type === "ready") {
        sendFrame();
        return;
      }

      if (msg.type === "frameDone") {
        if (onProgress) onProgress((msg.index - first + 1) / total);
        index++;
        // Yield to the event loop so the progress bar actually repaints.
        setTimeout(sendFrame, 0);
        return;
      }

      if (msg.type === "done") {
        if (settled) return;
        settled = true;
        worker.terminate();
        resolve(new Blob([msg.buffer], { type: "image/gif" }));
        return;
      }

      if (msg.type === "error") fail(new Error(msg.message));
    };

    // Sample evenly across the range so the palette sees the whole animation,
    // not just its opening shot.
    try {
      const samples = [];
      const frameStep = Math.max(1, Math.floor(total / PALETTE_SAMPLES));
      for (let i = first; i <= last && samples.length < PALETTE_SAMPLES; i += frameStep) {
        samples.push(pixelsFor(i).buffer.slice(0));
      }
      // `stride` here is a pixel stride inside each sample, not a frame step.
      worker.postMessage({ type: "start", samples, stride: 7 }, samples);
    } catch (err) {
      fail(err);
    }
  });
}
