#!/usr/bin/env node
/**
 * Fetches the third-party assets EasyMeme ships in static/vendor/.
 *
 * The results are committed, so nobody needs Node to build or run the app —
 * this script exists so it is documented and repeatable where those blobs came
 * from, the same reason requirements.txt is fully pinned.
 *
 *   node tools/fetch-vendor.mjs           verify against tools/vendor.lock.json
 *   node tools/fetch-vendor.mjs --init    (re)write the lock from what was fetched
 *
 * Everything is pinned to an exact version. A checksum mismatch is a hard
 * failure: a CDN quietly serving different bytes than the ones that were
 * reviewed is precisely what the lock file is here to catch.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "static", "vendor");
const LOCK = path.join(ROOT, "tools", "vendor.lock.json");

const ORT = "1.23.0";      // CPU/wasm build only - see BUILT below
const GIFENC = "1.0.3";
const GIFUCT = "2.1.2";
const ESBUILD = "0.25.0";  // only used to bundle gifuct, never shipped

// u2netp: the small (4.4 MB) U^2-Net variant. Apache-2.0, Qin et al.
// Served from the rembg release that has hosted these weights for years.
const U2NETP =
  "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx";

const DOWNLOADS = [
  {
    dest: "gifenc.esm.js",
    url: `https://cdn.jsdelivr.net/npm/gifenc@${GIFENC}/dist/gifenc.esm.js`,
  },
  {
    // The ".bundle" variant inlines the Emscripten glue, so the runtime is two
    // files instead of three. Deliberately NOT the .jsep build: that one carries
    // WebGPU and is twice the size, and we run on the CPU backend anyway.
    dest: "ort/ort.wasm.bundle.min.mjs",
    url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT}/dist/ort.wasm.bundle.min.mjs`,
  },
  {
    dest: "ort/ort-wasm-simd-threaded.wasm",
    url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT}/dist/ort-wasm-simd-threaded.wasm`,
  },
  { dest: "u2netp.onnx", url: U2NETP },
];

// gifuct-js publishes no bundle and pulls in js-binary-schema-parser, so it is
// flattened into one self-contained ES module here rather than shipping a
// node_modules tree.
const BUILT = [
  {
    dest: "gifuct.esm.js",
    pkg: `gifuct-js@${GIFUCT}`,
    entry: 'export { parseGIF, decompressFrames } from "gifuct-js";',
  },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const mb = (n) => (n / 1048576).toFixed(2) + " MB";

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function bundle({ pkg, entry }) {
  // npm and esbuild run in a throwaway directory: nothing lands in the repo but
  // the single bundled file.
  const dir = mkdtempSync(path.join(tmpdir(), "easymeme-vendor-"));
  try {
    const run = (cmd, args) =>
      execFileSync(cmd, args, { cwd: dir, stdio: "pipe", shell: process.platform === "win32" });

    run("npm", ["init", "-y"]);
    run("npm", ["install", "--no-audit", "--no-fund", pkg]);
    writeFileSync(path.join(dir, "entry.js"), entry);
    run("npx", ["--yes", `esbuild@${ESBUILD}`, "entry.js", "--bundle", "--format=esm", "--minify", "--outfile=out.js"]);

    return readFileSync(path.join(dir, "out.js"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const init = process.argv.includes("--init");
  const lock = init ? {} : JSON.parse(await readFile(LOCK, "utf8"));
  const fresh = {};
  let failed = false;

  for (const item of [...DOWNLOADS, ...BUILT]) {
    const bytes = item.url ? await download(item.url) : bundle(item);
    const hash = sha256(bytes);
    fresh[item.dest] = { sha256: hash, bytes: bytes.length, source: item.url ?? item.pkg };

    if (!init) {
      const want = lock[item.dest];
      if (!want) {
        console.error(`  MISSING FROM LOCK  ${item.dest}`);
        failed = true;
        continue;
      }
      if (want.sha256 !== hash) {
        console.error(`  CHECKSUM MISMATCH  ${item.dest}`);
        console.error(`    expected ${want.sha256}`);
        console.error(`    got      ${hash}`);
        failed = true;
        continue;
      }
    }

    const out = path.join(VENDOR, item.dest);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, bytes);
    console.log(`  ok  ${item.dest.padEnd(38)} ${mb(bytes.length).padStart(9)}  ${hash.slice(0, 12)}`);
  }

  if (failed) {
    console.error("\nRefusing to continue: vendored bytes do not match tools/vendor.lock.json.");
    process.exit(1);
  }

  if (init) {
    await writeFile(LOCK, JSON.stringify(fresh, null, 2) + "\n");
    console.log(`\nWrote ${path.relative(ROOT, LOCK)}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
