/**
 * Video -> frames.
 *
 * No demuxer and no WebCodecs: the output of this app is a GIF, so all that is
 * needed is pictures at chosen timestamps. A <video> element seeked in a loop
 * gives exactly that, works in every browser that can play the file at all, and
 * does not have to run in real time the way capturing playback would.
 *
 * Audio is discarded - a GIF has nowhere to put it.
 */

import { fitWidth } from "./gif.js";

const SEEK_TIMEOUT_MS = 8000;

function waitFor(el, event, ms) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("video error")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for " + event)); }, ms);
    function cleanup() {
      clearTimeout(timer);
      el.removeEventListener(event, done);
      el.removeEventListener("error", failed);
    }
    el.addEventListener(event, done, { once: true });
    el.addEventListener("error", failed, { once: true });
  });
}

/**
 * Loads a video far enough to know its size and duration.
 * The caller must call close() on the result when finished with it.
 */
export async function openVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");

  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";

  // Kept in the document but out of sight: a detached or display:none video is
  // allowed to skip decoding in some browsers, which would hand back blank frames.
  video.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(video);

  try {
    await waitFor(video, "loadedmetadata", SEEK_TIMEOUT_MS);
  } catch (err) {
    close();
    throw err;
  }

  function close() {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }

  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (!duration || !video.videoWidth) {
    close();
    throw new Error("unreadable video");
  }

  return { video, duration, width: video.videoWidth, height: video.videoHeight, close };
}

/**
 * Grabs frames from an open video between `start` and `start + seconds`.
 * Returns { frames, width, height }.
 */
export async function extractFrames(handle, opts) {
  const { start = 0, seconds, fps, maxWidth, maxFrames, onProgress } = opts;
  const { video } = handle;

  const target = fitWidth(handle.width, handle.height, maxWidth);
  const stage = document.createElement("canvas");
  stage.width = target.width;
  stage.height = target.height;
  const ctx = stage.getContext("2d");

  const wanted = Math.max(1, Math.floor(seconds * fps));
  const count = Math.min(wanted, maxFrames);
  // Fewer frames than asked for means a longer gap between them; keep the clip
  // playing at the right speed by stretching the delay to match.
  const step = seconds / count;
  const delayMs = Math.max(20, Math.round(step * 1000));

  const frames = [];
  for (let i = 0; i < count; i++) {
    // Half a step in lands in the middle of each slice rather than on the cut,
    // which avoids grabbing a transition frame at the very start.
    const t = Math.min(start + i * step + step / 2, handle.duration - 0.001);

    if (Math.abs(video.currentTime - t) > 0.001) {
      video.currentTime = t;
      await waitFor(video, "seeked", SEEK_TIMEOUT_MS);
    }

    ctx.drawImage(video, 0, 0, target.width, target.height);
    frames.push({ bitmap: await createImageBitmap(stage), delayMs });

    if (onProgress) onProgress((i + 1) / count);
  }

  return { frames, width: target.width, height: target.height };
}
