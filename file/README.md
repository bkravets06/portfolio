# `/file` — in-browser file converter

A hidden page at **bjkravets.com/file** (unlinked, `noindex`, not in the
sitemap) that converts files entirely in the browser: images, audio, video, 3D
meshes and STEP/IGES/BREP. Nothing is uploaded anywhere; the heavy engines
(FFmpeg, OpenCascade, Three.js, image codecs) are fetched from jsDelivr on
first use and cached by the browser.

This file is the handoff for whoever continues the work — human or AI. The
**Status** and **TODO** sections are the important part.

## How it is put together

| Path | Role |
| --- | --- |
| `index.html`, `app.js`, `style.css` | The UI: drop/pick/paste files, detect their type, choose a target format, SETTINGS from the engine's option definitions, sequential batch conversion with progress and Cancel, per-file Save and "Save all · zip". Styled after the Pebble watch look used in the Ride Glance phone app (`PebbleStyle.swift` in the `PebbleRideGlance` repo). |
| `engines/CONTRACT.md` | The interface every engine implements (`domain`, `formats`, `detect`, `targets`, `warmup`, `loadNote`, `convert`) and the `MeshSet` format shared by the 3D modules. **Read it before touching an engine or the UI.** |
| `engines/image.js` | Native canvas decode/encode plus wasm codecs from jsDelivr: `@jsquash/avif`, `@jsquash/jxl`, `@jsquash/qoi`, `@jsquash/webp` (Safari fallback), `libheif-js` (HEIC), `utif` (TIFF), `gifenc` (GIF). |
| `engines/av.js` + `lib/ffmpeg/` | ffmpeg.wasm. `lib/ffmpeg/` is the `@ffmpeg/ffmpeg` 0.12.15 ESM wrapper vendored verbatim (MIT) because its Worker must be same-origin; the 32 MB single-thread `@ffmpeg/core` 0.12.10 is fetched from jsDelivr into blob URLs. Inputs over 1.5 GB are refused (wasm32 heap). |
| `engines/model.js` | The "3D Model" engine: composes `model-mesh.js` and `model-cad.js`, routes mesh↔mesh, mesh↔CAD and CAD↔CAD, applies `scale` / `merge`, exports `needsCad()` so the UI shows the 50 MB note only when CAD is involved. |
| `engines/model-mesh.js` | Three.js 0.186.0 through the page's import map (loaders/exporters from `three/addons/`); own 3MF writer (fflate zip). |
| `engines/model-cad.js` | opencascade.js `2.0.0-beta.b5ff984` full build (0.4 MB glue + 50 MB wasm from jsDelivr). STEP/IGES/BREP read (tessellated to a `MeshSet`), write (faceted B-rep: one face per triangle, sewn into a solid when watertight; unsewn compound above `SEW_MAX_FACES` = 50 000) and CAD→CAD without tessellation. |
| `_dev/` | Test harnesses (`image.html`, `av.html`, `model.html`, `cad.html`, `template.html`), a fake engine (`stub.js`, loaded by `index.html?stub` on localhost only), a CAD stand-in for routing tests, and sample generators (`gen_samples.py`, `gen_samples_three.mjs`). `_dev/samples/` is gitignored — regenerate as described below. |

Design rules baked into the UI: engines are light at module top level and
`import()` their libraries lazily; every CDN URL is pinned to an exact version;
a file already in the target format passes through unchanged (so an STL next
to an OBJ can still be sent to STL); option values persist per engine+format in
`localStorage`; all user-facing errors are the engine's `Error.message`
verbatim, so engines must throw plain English.

## Local development

```bash
python3 -m http.server 8765 --bind 127.0.0.1     # from the repo root
```

Open `http://127.0.0.1:8765/file/` (add `?stub` to also load the fake engine).
Python's server sends no cache headers, so hard-reload or append `?v=<n>`.
From the console, `fileConverter.addFiles([...File])` feeds files in and
`fileConverter.state` exposes everything. No SharedArrayBuffer is available on
GitHub Pages (no COOP/COEP), so only single-threaded wasm builds can be used.

Regenerating samples (`_dev/samples/`, ~50 MB, not committed):
- images: `ffmpeg -f lavfi -i testsrc=size=320x240:rate=1 -frames:v 1 test.png` (and jpg/webp/gif/bmp/tif); HEIC via macOS `sips -s format heic`; SVGs by hand;
- audio/video: 3–10 s `testsrc` + `sine` clips from the ffmpeg CLI in each container (`_dev/av.html` lists the exact commands it expects);
- meshes: `python3 _dev/gen_samples.py` (STL/OBJ/PLY) and `_dev/gen_samples_three.mjs` (the rest, needs `npm install three@0.186.0` in a scratch folder — see its header);
- CAD: `_dev/cad.html` builds box/sphere/cylinder STEP/IGES/BREP with OpenCascade itself.

## Status (2026-09-17)

Work was done by a lead session plus parallel sub-agents; two of the agents
were killed by API rate limits before finishing, which is why the picture is
uneven. Everything below was tested only in Chromium (the desktop app's
browser pane) unless stated otherwise.

| Part | State |
| --- | --- |
| UI | Exercised end-to-end with the stub engine and with real image and mesh conversions: batches, settings controls, progress, Cancel/Esc, per-file Save, ZIP building, pass-through, dark mode, 375 px layout. Not yet opened in Safari, Firefox or on a phone. |
| `image.js` | **Verified** by its agent: 24 inputs × 10 outputs = 240 conversions re-decoded and checked (dimensions, EXIF orientation, alpha). HEIC only with macOS-made samples (no real iPhone photo). Safari-specific paths were exercised by forcing them in Chromium, not in Safari. |
| `model-mesh.js`, `model.js` | **Verified** by its agent: 34/34 reads, 36/36 write→read round-trips (STL binary/ASCII, OBJ, PLY, GLB, glTF, 3MF, USDZ), 26 bad inputs rejected cleanly, 200k-triangle STL timings. CAD routing verified with real STEP→STL, STL→STEP and STEP→IGES through `model.js`. |
| `model-cad.js` | **Partially verified.** Loads in ~1.4 s here; the three routes above work. Its own test suite (`_dev/cad.html`: IGES/BREP round-trips, timings at 1k/10k/100k triangles, the sewing fallback, garbage and truncated inputs, memory after a 100k case) was **never run to completion** — the agent was cut off mid-run twice. Everything runs synchronously on the main thread (see TODO 3). |
| `av.js` | **Unverified.** Written and syntax-checked, but no conversion has ever been run through it in a browser; both attempts were cut off before the first test. Whether the core loads from blob URLs, which encoders the wasm build actually has, progress and cancel behaviour, and real speed are all unknown. Treat every claim in its comments as a hypothesis. |

## TODO, in priority order

1. **Verify `av.js` in the browser** with `_dev/av.html` (and then through the
   page): the load mechanism (vendored wrapper + `toBlobURL` core, no
   SharedArrayBuffer); `-encoders`/`-formats` inside the wasm build and prune
   `formats` to what works; mp4→webm, mp4→gif, mp4→mp3 (soundtrack
   extraction), mov/mkv→mp4 with resolution 480 + fps 15, wav→mp3 at 128 kbps,
   mp3→flac, ogg→opus, mp4→mp4 with mute; garbage input → readable error;
   cancel mid-way then a successful conversion; `onProgress` fractions in
   0..1; throughput for a 10 s 720p clip (x264 in wasm is slow — use
   ultrafast/veryfast). Re-probe every output (`-i` in the wasm ffmpeg, or
   `<video>`/`<audio>` metadata).
2. **Finish `model-cad.js` verification** (`_dev/cad.html`): STEP→IGES→STEP and
   BREP round-trips; `readCad` triangle counts/bboxes at deflection 0.1 and
   0.02; `writeCad` from ~1k/10k/100k-triangle STLs with timings, re-read and
   checked, `MANIFOLD_SOLID_BREP` present for watertight input; the
   `SEW_MAX_FACES` fallback; garbage/truncated STEP; a second large conversion
   after the first (memory headroom).
3. **Move OpenCascade off the main thread** (a module Worker holding the OCC
   instance; transfer the input `ArrayBuffer` and the `MeshSet` typed arrays;
   progress via `postMessage`; abort = `worker.terminate()` + a fresh instance).
   Today a large STL→STEP freezes the tab for the whole sewing loop and Cancel
   cannot take effect. The heavy image codecs already run in a worker.
4. **Save-all ZIP without buffering** (`app.js` `saveAll`): it currently
   copies every result into the JS heap, runs `zipSync`, then copies again
   (~3× the total output size on the main thread, no ZIP64). Build the archive
   as a `Blob` of parts — local headers + the result blobs + central directory —
   with CRC32 computed by streaming each `blob.stream()` in chunks; cap at 4 GB
   and fall back to per-file downloads above that. A try/catch with a visible
   message and a "Building zip…" state is the only mitigation in place.
5. **UI state bugs from the code review** (found by static review; a second
   opinion was cut off, so confirm each before fixing):
   - `image.js` and `av.js` both claim `gif`, and the first engine wins, so an
     animated GIF can never be sent to MP4/WebM. Record every engine that
     accepts a file and let the domain segments re-route the batch (or give
     `av` precedence for multi-frame GIFs).
   - `reconcile()` keeps the target/options when the batch engine changes but
     the format id survives (again `gif`): options from the other engine leak.
     Track which engine the target was chosen for and re-run `setTarget`.
   - Adding a file that invalidates the target calls `setTarget(null)`, which
     discards every finished result. Keep results; mark the new file instead.
   - Changing a setting after a run leaves stale results and no "Convert again";
     picking another target silently drops unsaved results.
   - Files added before `loadEngines()` resolves are stuck as "unsupported";
     `await` the engines promise at the top of `addFiles`, and show
     "loading…" rather than the failure hint meanwhile.
   - `addFiles` can land mid-run (its `await`s happen after the `running`
     guard); the drag counter can drift when rows re-render under a drag.
   - Every `onProgress` call rebuilds the whole file list, which loses clicks
     on Save buttons and keyboard focus. Patch rows in place keyed by
     `item.id` (also fixes the focus loss on every re-render).
6. **Accessibility**: `aria-live` region for start/finish/error announcements;
   `<label for>`/`aria-label` on the settings select/range/number controls;
   headings for the status bar and strips; `aria-label="Save <name>"` per row;
   `role="progressbar"` on the gauge; 44 px touch targets for Save/Clear/× on
   coarse pointers; hide or replace the Keyboard section on touch devices
   (paste needs a button calling `navigator.clipboard.read()`); light-mode
   contrast of `.badge.light`, the disabled "Converting k/N" button and
   `--muted` (4.48:1).
7. **Smaller items**: `model.js` `scale` has `min: 0.000001, step: 0.001`,
   so browsers flag every round value as a step mismatch — use `step: 'any'`
   or `min: 0.001`; show `unit` next to number inputs; the load note appears
   only after `warmup()` has already started the 32/50 MB download — show it
   under "Convert to" and/or defer warmup to Convert on cellular
   (`navigator.connection.saveData`); CAD→CAD ignores Scale/Merge (apply with
   `gp_Trsf` or refuse); pass-through rows ignore settings (say so); `image.js`
   offers no same-format target for lossless formats, so PNG→PNG at 50 % scale
   is impossible; check `HTMLScriptElement.supports('importmap')` and give a
   clear message on old iOS; output-name line truncates the extension and
   size on narrow screens.
8. **Repository hygiene**: `HeadShotCloseUp.JPG` and
   `assets/images/wireless-audio/IMG_0274_cover.jpg` are untracked in the
   working copy although the home page commit refers to the cover image —
   check whether the live site is missing it. GitHub Pages "Enforce HTTPS" is
   off in the repo settings.

## Licences of third-party code

`lib/ffmpeg/` is `@ffmpeg/ffmpeg` (MIT). Everything else — `@ffmpeg/core`
(LGPL/GPL build with x264), opencascade.js (LGPL 2.1), Three.js (MIT), the
jSquash codecs, libheif-js, utif, gifenc, fflate — is loaded at runtime from
jsDelivr with pinned versions and is not redistributed by this repository.
