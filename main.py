"""EasyMeme - white caption bars on a photo, composed in the browser.

The server does nothing but hand over a single HTML file. All image work
happens client-side on a <canvas>, so nothing is uploaded and nothing is
written to disk.
"""

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

STATIC_DIR = Path(__file__).parent / "static"
INDEX = STATIC_DIR / "index.html"

app = FastAPI(title="EasyMeme", docs_url=None, redoc_url=None)


@app.get("/api/health")
def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "service": "easymeme"})


@app.get("/")
def index() -> FileResponse:
    return FileResponse(INDEX, media_type="text/html")


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
