# EasyMeme

Drop a photo, GIF or clip in, put text on it, get a meme out — then share it.

## What it does

**Captions.** Type into the **Top bar** and/or **Bottom bar** field and a white
caption strip is added above and/or below the picture. Leave a field empty and
that bar is not drawn. Drag the size slider to fit more or less text.

**Timeline.** Load an animated GIF or a video clip and a filmstrip appears.
Click or drag along it to step through frames, drag the handles at either end to
trim, press **Play** to loop it. Arrow keys step one frame, space plays.

**Layers.** Beyond the two caption bars you can drop free-floating text anywhere
on the picture — drag it around, pick a fill and outline colour, set the size and
alignment. On an animated document every layer has an **in and out point**: select
the layer, then drag the purple bar under the filmstrip to choose which frames it
appears on. Text that pops in halfway through and disappears again is the whole
point.

**Stickers.** Point EasyMeme at a photo of a friend and it lifts them off the
background into a PNG with an alpha channel, which you can then stick onto any
other photo or GIF as a layer — dragged, scaled, rotated, flipped, and with its
own in/out points. Long-press the canvas on a still photo to cut out whatever is
in it without leaving the editor.

The cut-outs are kept in a **shared library on the server** so they are still
there tomorrow and on your other phone. Everything else — decoding, captioning,
compositing, encoding, and the background removal itself — happens on your device.

Desktop extras: drag-and-drop a file onto the page, or paste one with `Ctrl+V`.

## What comes out

| Loaded | Exported |
| ------ | -------- |
| Photo  | JPEG, quality 0.92, capped at 1600 px wide |
| GIF    | GIF |
| Video  | GIF |

Video goes in but only GIF comes out, which means no audio. Clips are capped at
**30 seconds**; a longer file is not rejected, you are asked to pick a 30 second
window out of it. Frame rate (5–20, default 12) is chosen on import, and output
width (240–720 px, default 640) can be changed at any time from the timeline
panel. A live size estimate sits next to the filmstrip, because a 400 frame GIF
at 640 px is a 40 MB file and it is better to find that out before encoding it.

## Cutting stickers

The background removal is [U²-Net](https://github.com/xuebinqin/U-2-Net)
(`u2netp`, 4.4 MB) run through onnxruntime-web. It is worth knowing what that
model actually does: it finds the **most salient object** in the picture. It is
not prompted by where you tapped. One friend in the frame and it does exactly what
you want; a group photo and it will lift the whole group. That is what the
**Restore** and **Erase** brushes are for, along with the **Edge** slider that
tightens or loosens the matte.

The runtime is deliberately single-threaded. Threads would need SharedArrayBuffer,
which needs COOP/COEP headers, which would break the Google Fonts link — so one
cut-out takes a second or two rather than a fraction of one. The model and the
11 MB runtime are only downloaded the first time you cut something out, and are
then cached by the browser.

## Port and variables

| Variable                | Default | Meaning                                        |
| ----------------------- | ------- | ---------------------------------------------- |
| `EASYMEME_PORT`         | `8104`  | Host port the container is published on        |
| `EASYMEME_UID`          | `1000`  | UID the container runs as                      |
| `EASYMEME_GID`          | `1000`  | GID the container runs as                      |
| `EASYMEME_STICKERS_RO`  | unset   | Set to `1` to make the sticker library read-only |
| `EASYMEME_DATA`         | `./data`| Where the sticker library is stored (in-container path) |

Copy `.env.example` to `.env` only if you need to override a default — the
container starts fine without it.

Inside the container the app listens on `PORT`, which defaults to `8000`. Compose
maps `EASYMEME_PORT` on the host to that port, so there is normally no reason to
set `PORT` yourself.

## Deployment

```
docker compose up -d --build
```

Then open `http://<host>:8104/`.[^1]

The container ships a healthcheck (`/api/health`, every 30s), so `docker ps`
reports `healthy` once it is up. To check by hand from the host:

```
curl -so /dev/null -w '%{http_code}\n' http://localhost:8104/api/health
```

The health response also reports whether the sticker library came up:

```json
{"status": "ok", "service": "easymeme", "stickers": true}
```

## Disk

One directory: `./data/stickers`, bind-mounted into the container, holding the
shared sticker library as PNG files named after their own SHA-256. Saving the
same cut-out twice is therefore a no-op rather than a second copy. Uploads are
capped at 4 MB each, and the library at 500 stickers or 200 MB, whichever comes
first.

`./data/stickers` is committed to the repository (empty, via a `.gitkeep`) on
purpose. Docker creates a missing bind-mount source directory as `root`, and this
container runs unprivileged — so if the directory did not already exist, the app
could not write into it. Shipping it means the checkout owns it and `docker
compose up` works with no extra steps.

Nothing else is written. There is no database.

### "Sticker library unavailable"

The meme editor still works; only the library is down, and it means `./data` is
not writable by `EASYMEME_UID:EASYMEME_GID`. Ask the server what it thinks:

```
curl -s http://localhost:8104/api/health
```

A broken library reports the path and the underlying OS error:

```json
{"status": "ok", "service": "easymeme", "stickers": false,
 "stickers_error": "[Errno 13] Permission denied: '/app/data/stickers'",
 "stickers_path": "/app/data/stickers"}
```

The container log prints the same thing plus the command to run. Nearly always
the fix is on the host, in the deployment directory:

```
mkdir -p data/stickers && chown -R 1000:1000 data
```

using whatever `EASYMEME_UID:EASYMEME_GID` is set to. **No restart is needed** —
the app re-checks the directory on every request while it is failing, so the
library comes back on the next page load.

## A word on exposure

The sticker library has **no authentication**. Anyone who can reach the port can
browse it, add to it, and delete from it. That is a deliberate trade for a
single-household selfhost, and it means this should sit on your home network,
behind a VPN, or behind your own reverse proxy auth — not on a public IP.

If you do need it reachable somewhere less trusted, `EASYMEME_STICKERS_RO=1`
turns off writes and deletes entirely.

## Privacy

Photos, GIFs and clips are decoded, captioned and encoded in the browser. They are
never uploaded, and the background removal runs on your device too. The one thing
that leaves the browser is a **finished sticker**, and only when you press *Save
to library* — at which point, by design, it is shared with everyone else using
that server.

## Notes

- Web fonts (Archivo, IBM Plex) load from Google Fonts, so a client with no
  internet falls back to system faces. Layout still works.
- Frontend is plain ES modules with no build step; the server serves the files as
  they are in the repo.
- Third-party code and the model weights are committed under `static/vendor/` and
  pinned by checksum — see [`static/vendor/README.md`](static/vendor/README.md)
  for versions and licences.

## License

Released under the MIT License — see [LICENSE](LICENSE). Vendored dependencies
keep their own licences, listed in `static/vendor/README.md`.

[^1]: In my own homelab this is deployed through Foreman rather than by hand;
      that is specific to my environment and irrelevant to anyone else running
      the compose file above.
