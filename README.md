# EasyMeme

Drop a photo in, type a caption, get a meme with a white bar and black text — then share it.

## What it does

Pick a photo, type into the **Top bar** and/or **Bottom bar** field, and a white
caption strip is added above and/or below the image. Leave a field empty and that
bar is not drawn. Drag the size slider to fit more or less text. Then **Share**
(mobile share sheet) or **Download** (JPEG).

Everything runs on the client in a `<canvas>`. Nothing is uploaded, nothing is
stored, there is no database. The server hands over one HTML file and gets out of
the way.

Desktop extras: drag-and-drop a file onto the page, or paste one with `Ctrl+V`.

## Port and variables

| Variable        | Default | Meaning                                  |
| --------------- | ------- | ---------------------------------------- |
| `EASYMEME_PORT` | `8104`  | Host port on mordor                      |
| `EASYMEME_UID`  | `1000`  | UID the container runs as                |
| `EASYMEME_GID`  | `1000`  | GID the container runs as                |

Copy `.env.example` to `.env` only if you need to override a default — the
container starts fine without it.

## Deployment

Through Foreman on mordor, or by hand:

```
docker compose up -d --build
```

Then open `http://<host>:8104/`.

Health check:

```
curl -so /dev/null -w '%{http_code}\n' http://localhost:8104/api/health
```

## Disk

Nothing. The app writes no files, so there is no `data/` directory and no bind
mount — the container is disposable.

## Notes

- Web fonts (Archivo, IBM Plex) load from Google Fonts, so a client with no
  internet falls back to system faces. Layout still works.
- Export is JPEG at quality 0.92, capped at 1600 px wide.
- Adding text to GIFs is not implemented.
