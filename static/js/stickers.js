/**
 * The sticker library.
 *
 * Unlike everything else in this app, stickers live on the server: the whole
 * point of cutting your mate out of one photo is to still have him next week,
 * on a different device. The library is shared by everyone who can reach the
 * app - there are no accounts, which is a deliberate choice for a LAN selfhost
 * and the reason the README says not to expose the port.
 */

const grid = document.getElementById("stickerGrid");
const note = document.getElementById("stickerNote");
const refreshBtn = document.getElementById("refreshStickers");

const ICON_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

let handlers = { onPick: null, notify: () => {} };
let items = [];

const urlFor = (id) => "/stickers/" + id + ".png";

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body && body.detail) detail = body.detail;
    } catch (_) { /* not JSON; the status text will do */ }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

function render() {
  grid.innerHTML = "";
  for (const item of items) {
    const cell = document.createElement("button");
    cell.className = "sticker";
    cell.type = "button";
    cell.title = item.w + "×" + item.h;

    const img = document.createElement("img");
    img.src = urlFor(item.id);
    img.alt = "";
    img.loading = "lazy";
    cell.appendChild(img);

    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.title = "Delete from the library";
    del.innerHTML = ICON_X;
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      // Shared library, no undo: worth one question.
      if (!confirm("Delete this sticker for everyone?")) return;
      try {
        await api("/api/stickers/" + item.id, { method: "DELETE" });
        await refreshLibrary();
      } catch (err) {
        handlers.notify("Could not delete: " + err.message);
      }
    });
    cell.appendChild(del);

    cell.addEventListener("click", () => {
      if (handlers.onPick) handlers.onPick({ id: item.id, url: urlFor(item.id) });
    });

    grid.appendChild(cell);
  }
}

export async function refreshLibrary() {
  try {
    items = await api("/api/stickers");
    note.textContent = items.length
      ? "Tap a sticker to drop it on the canvas."
      : "";
    render();
  } catch (err) {
    items = [];
    render();
    // A 503 means the server started but its data directory is not writable,
    // which is nearly always a volume owned by the wrong user. Pass the server's
    // own reason through - it names the path and the OS error.
    note.textContent =
      err.status === 503
        ? "Sticker library unavailable. " + err.message
        : "Could not reach the library: " + err.message;
  }
}

/** Uploads a PNG blob and refreshes the grid. Returns the new sticker's id. */
export async function saveSticker(blob) {
  const created = await api("/api/stickers", {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: blob,
  });
  await refreshLibrary();
  return created.id;
}

export function initStickers(opts) {
  handlers = { ...handlers, ...opts };
  refreshBtn.addEventListener("click", refreshLibrary);
  refreshLibrary();
}
