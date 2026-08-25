"""EasyMeme - captions, timelines and stickers, composed in the browser.

Memes are still built entirely client-side on a <canvas>: photos, GIFs and video
clips are decoded, captioned and encoded on the device and never reach this
process. The one thing the server does hold is the sticker library, because a
subject you cut out of a photo is only useful if it is still there next week and
on your other phone.

The library is shared and unauthenticated by design - this is meant to run on a
home network. Set EASYMEME_STICKERS_RO=1 to make it read-only.
"""

import hashlib
import os
import re
import struct
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

STATIC_DIR = Path(__file__).parent / "static"
DATA_DIR = Path(os.getenv("EASYMEME_DATA", Path(__file__).parent / "data"))
STICKERS_DIR = DATA_DIR / "stickers"

# A cut-out sticker is a small PNG; anything much larger is either a mistake or
# somebody filling the disk.
MAX_STICKER_BYTES = 4 * 1024 * 1024
MAX_STICKER_PIXELS = 4096
MAX_STICKERS = 500
MAX_TOTAL_BYTES = 200 * 1024 * 1024

PNG_SIG = b"\x89PNG\r\n\x1a\n"
ID_RE = re.compile(r"\A[0-9a-f]{16}\Z")

READ_ONLY = os.getenv("EASYMEME_STICKERS_RO", "").strip().lower() in {"1", "true", "yes"}

app = FastAPI(title="EasyMeme", docs_url=None, redoc_url=None)


_storage_ok = False
_storage_error = ""


def _probe_storage() -> bool:
    """Creates the sticker directory and confirms it can be written to.

    Re-checked on every request while it is failing, rather than latched at
    startup: the usual cause is a bind mount owned by the wrong user, and having
    to remember to restart the container after fixing that on the host is a
    needless second step. Once it succeeds the answer is cached.

    A failure is reported, never fatal - the meme editor works perfectly well
    without a library, and a container with a misconfigured volume should still
    serve the app.
    """
    global _storage_ok, _storage_error
    if _storage_ok:
        return True
    try:
        STICKERS_DIR.mkdir(parents=True, exist_ok=True)
        probe = STICKERS_DIR / ".writable"
        probe.write_bytes(b"")
        probe.unlink()
    except OSError as exc:  # pragma: no cover - depends on the host's permissions
        _storage_error = str(exc)
        return False
    _storage_ok = True
    _storage_error = ""
    return True


def _storage_advice() -> str:
    """The actual command that fixes the usual cause, with real numbers in it."""
    head = f"easymeme: sticker storage unavailable at {STICKERS_DIR}: {_storage_error}"
    tail = "easymeme:   the library re-checks itself, so no restart is needed."

    try:
        who = f"{os.getuid()}:{os.getgid()}"
    except AttributeError:
        # No getuid means Windows, which means this is not the containerised
        # deployment - the chown advice below would be noise at best.
        return f"{head}\neasymeme:   check that the path exists and is writable.\n{tail}"

    return (
        f"{head}\n"
        f"easymeme:   this process runs as {who}\n"
        f"easymeme:   if ./data is a bind mount Docker created, it belongs to root.\n"
        f"easymeme:   on the host, run:  mkdir -p data/stickers && chown -R {who} data\n"
        f"{tail}"
    )


if not _probe_storage():
    print(_storage_advice(), flush=True)


def _require_storage() -> None:
    if not _probe_storage():
        raise HTTPException(
            503,
            f"Sticker storage is not writable ({STICKERS_DIR}): {_storage_error}. "
            "See the container log for the fix.",
        )


def _require_writable() -> None:
    _require_storage()
    if READ_ONLY:
        raise HTTPException(403, "The sticker library is read-only on this server.")


def _png_size(data: bytes) -> tuple[int, int]:
    """Width and height from a PNG header, rejecting anything that is not a PNG
    with an alpha channel. Done by hand so the server needs no imaging library:
    the bytes were produced by a <canvas>, and the header is fixed-layout.
    """
    if len(data) < 26 or not data.startswith(PNG_SIG):
        raise HTTPException(415, "Only PNG files are accepted.")
    if data[12:16] != b"IHDR":
        raise HTTPException(415, "Malformed PNG: no IHDR chunk.")

    width, height = struct.unpack(">II", data[16:24])
    colour_type = data[25]

    if not (0 < width <= MAX_STICKER_PIXELS and 0 < height <= MAX_STICKER_PIXELS):
        raise HTTPException(415, f"PNG must be at most {MAX_STICKER_PIXELS}px a side.")
    # 4 = grey+alpha, 6 = RGBA. A sticker without transparency is a rectangle,
    # which is not what this feature is for.
    if colour_type not in (4, 6):
        raise HTTPException(415, "PNG must have an alpha channel.")

    return width, height


def _entry(path: Path) -> dict | None:
    try:
        stat = path.stat()
        with path.open("rb") as fh:
            head = fh.read(26)
        width, height = struct.unpack(">II", head[16:24])
    except (OSError, struct.error):
        return None
    return {
        "id": path.stem,
        "w": width,
        "h": height,
        "bytes": stat.st_size,
        "added": int(stat.st_mtime),
    }


def _library() -> list[dict]:
    items = []
    for path in STICKERS_DIR.glob("*.png"):
        entry = _entry(path)
        if entry:
            items.append(entry)
    items.sort(key=lambda e: e["added"], reverse=True)
    return items


@app.get("/api/health")
def health() -> JSONResponse:
    ok = _probe_storage()
    body = {"status": "ok", "service": "easymeme", "stickers": ok}
    if not ok:
        # Surfaced here so the reason is one curl away, without shelling into
        # the container to read the log.
        body["stickers_error"] = _storage_error
        body["stickers_path"] = str(STICKERS_DIR)
    return JSONResponse(body)


@app.get("/api/stickers")
def list_stickers() -> JSONResponse:
    _require_storage()
    return JSONResponse(_library())


@app.post("/api/stickers")
async def create_sticker(request: Request) -> JSONResponse:
    _require_writable()

    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_STICKER_BYTES:
        raise HTTPException(413, "Sticker is larger than 4 MB.")

    # Streamed rather than request.body() so an oversized upload is cut off
    # instead of being buffered in full first.
    buf = bytearray()
    async for chunk in request.stream():
        buf.extend(chunk)
        if len(buf) > MAX_STICKER_BYTES:
            raise HTTPException(413, "Sticker is larger than 4 MB.")

    data = bytes(buf)
    width, height = _png_size(data)

    existing = _library()
    if len(existing) >= MAX_STICKERS:
        raise HTTPException(507, f"The library is full ({MAX_STICKERS} stickers).")
    if sum(e["bytes"] for e in existing) + len(data) > MAX_TOTAL_BYTES:
        raise HTTPException(507, "The library has reached its size limit.")

    # Content addressing gives deduplication for free: saving the same cut-out
    # twice is a no-op rather than a second copy.
    sticker_id = hashlib.sha256(data).hexdigest()[:16]
    target = STICKERS_DIR / f"{sticker_id}.png"

    if not target.exists():
        tmp = STICKERS_DIR / f".{sticker_id}.tmp"
        try:
            tmp.write_bytes(data)
            os.replace(tmp, target)  # atomic: readers never see a half-written PNG
        except OSError as exc:
            tmp.unlink(missing_ok=True)
            raise HTTPException(507, f"Could not write the sticker: {exc}") from exc

    return JSONResponse(
        {"id": sticker_id, "w": width, "h": height, "bytes": len(data), "added": int(time.time())},
        status_code=201,
    )


@app.delete("/api/stickers/{sticker_id}")
def delete_sticker(sticker_id: str) -> JSONResponse:
    _require_writable()
    # Ids are 16 hex characters and nothing else, so no request can steer this
    # path outside the sticker directory.
    if not ID_RE.match(sticker_id):
        raise HTTPException(400, "Not a sticker id.")

    target = STICKERS_DIR / f"{sticker_id}.png"
    if not target.is_file():
        raise HTTPException(404, "No such sticker.")

    try:
        target.unlink()
    except OSError as exc:
        raise HTTPException(500, f"Could not delete the sticker: {exc}") from exc

    return JSONResponse({"deleted": sticker_id})


# Sticker files are content-addressed, so their bytes can never change under a
# given name and the browser may cache them indefinitely.
class ImmutableStatic(StaticFiles):
    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


# check_dir=False so the mount survives a directory that is not there yet: if the
# volume is fixed while the app is running, these files start serving without a
# restart, matching the re-checking _probe_storage above.
app.mount("/stickers", ImmutableStatic(directory=STICKERS_DIR, check_dir=False), name="stickers")

# html=True already serves static/index.html at "/", so no explicit route for it.
# Mounted last: routes are matched in registration order, so /api/* and
# /stickers/* win over the catch-all.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
