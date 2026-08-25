# Vendored assets

Third-party code and model weights, committed so the app builds and runs with no
network access and no package manager. Everything here is fetched and checksummed
by `tools/fetch-vendor.mjs`; the exact bytes are pinned in `tools/vendor.lock.json`.

To refresh after changing a version in that script:

```
node tools/fetch-vendor.mjs --init
```

Running it without `--init` re-downloads and verifies against the lock, and fails
loudly if a CDN serves anything other than the reviewed bytes.

| File | Version | Size | Licence | Upstream |
| --- | --- | --- | --- | --- |
| `gifenc.esm.js` | gifenc 1.0.3 | 9 kB | MIT | [mattdesl/gifenc](https://github.com/mattdesl/gifenc) |
| `gifuct.esm.js` | gifuct-js 2.1.2 | 8 kB | MIT | [matt-way/gifuct-js](https://github.com/matt-way/gifuct-js) |
| `ort/ort.wasm.bundle.min.mjs` | onnxruntime-web 1.23.0 | 67 kB | MIT | [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) |
| `ort/ort-wasm-simd-threaded.wasm` | onnxruntime-web 1.23.0 | 11.3 MB | MIT | as above |
| `u2netp.onnx` | U²-Net (u2netp) | 4.4 MB | Apache-2.0 | [xuebinqin/U-2-Net](https://github.com/xuebinqin/U-2-Net) |

Notes:

- `gifuct.esm.js` is not an upstream release file. gifuct-js ships no bundle and
  depends on `js-binary-schema-parser`, so the fetch script flattens the two into
  one self-contained ES module with esbuild.
- The ONNX runtime is the **CPU/wasm** build. The `.jsep` variant carries WebGPU
  and is more than twice the size; this app runs inference on the CPU backend, so
  it is not shipped.
- `u2netp.onnx` is the small U²-Net variant, downloaded from the `rembg` release
  that has hosted these weights for years. Weights are Apache-2.0 (Qin et al.,
  *U²-Net: Going Deeper with Nested U-Structure for Salient Object Detection*).

None of this is loaded on page open. The GIF codecs are pulled in when a GIF is
imported or exported, and the ONNX runtime and model only when someone cuts out
their first sticker.
