# Engine contract — `file/engines/*.js`

`bjkravets.com/file` is a static, entirely in-browser file converter hosted on
GitHub Pages (repo root = this Portfolio folder, `file/` = the page). There is
no build step, no bundler and no `node_modules` in the repo: everything is plain
ES modules served as-is. Each file *domain* is one engine module in
`file/engines/<domain>.js` that the page (`file/index.html`, `file/app.js`,
`file/style.css` — owned by the lead) imports statically. Engines must therefore
be light at module top level and load their heavy libraries lazily.

Domains: `image` (engines/image.js), `av` (engines/av.js — audio + video),
`model` (engines/model.js — 3D meshes and CAD; composed from `model-mesh.js`
and `model-cad.js`, see the MeshSet section).

## Module shape

```js
export const domain = { id: 'image', name: 'Image' };

export const formats = [
  {
    id: 'jpeg',                     // unique within this engine, lowercase
    name: 'JPEG',                   // shown to the user
    ext: ['jpg', 'jpeg'],           // recognised extensions; ext[0] names output files
    mime: 'image/jpeg',
    read: true,                     // accepted as input
    write: true,                    // offered as output
    group: 'Image',                 // optional heading used when listing targets (av: 'Video' / 'Audio')
    note: 'Lossy, no transparency', // optional one-liner shown beside the target
    options: [ /* Option objects, shown when this is the OUTPUT format */ ],
  },
];

// Option objects shown for every output of this engine (optional).
export const options = [];

// Option object:
// { id, label, type: 'range' | 'select' | 'toggle' | 'number', default,
//   min, max, step, unit,                // range / number
//   choices: [{ value, label }],         // select
//   help: 'one-line explanation' }       // optional
// The UI passes chosen values back keyed by id: strings for select, numbers for
// range/number, booleans for toggle. Always fall back to `default` when a key is
// missing.

// Identify a File. `head` is a Uint8Array of its first 64 bytes for magic-byte
// sniffing; extension and file.type are also fine. Return a format id whose
// read is true, or null.
export function detect(file, head) {}

// Valid output ids for an input id. Optional; default = every write:true format
// except inputId. May include inputId when re-encoding is meaningful (e.g. JPEG
// at a lower quality) — the UI labels that "re-encode".
export function targets(inputId) {}

// Optional. Start downloading / instantiating the heavy library early
// (called when the user picks a target). Must be idempotent and safe to call
// concurrently.
export async function warmup(outputId) {}

// Optional. Shown once before the first conversion that needs a big download,
// e.g. 'Downloads ~32 MB of FFmpeg on first use; cached afterwards.'
export const loadNote = '';

// The conversion. Runs in the page (workers inside are fine). Never touches the
// DOM. onProgress(fraction, message?) — fraction 0..1 or null for indeterminate.
// signal is an AbortSignal (honouring it is optional but appreciated).
// Resolve { blob, ext? } (ext overrides ext[0] of the output format when
// needed). Reject with an Error whose message a non-technical user can read.
export async function convert({ file, inputId, outputId, options, onProgress, signal }) {}
```

## Rules

- Pin every CDN import to an exact version on jsDelivr:
  `https://cdn.jsdelivr.net/npm/<pkg>@<x.y.z>/...`. Known-good pins:
  `three@0.186.0`, `@ffmpeg/ffmpeg@0.12.15`, `@ffmpeg/core@0.12.10`
  (single-thread; `dist/umd/ffmpeg-core.wasm` is 32.2 MB), `@ffmpeg/util@0.12.2`,
  `opencascade.js@2.0.0-beta.b5ff984` (`dist/opencascade.full.js` 0.4 MB +
  `dist/opencascade.full.wasm` 50.3 MB), `fflate@0.8.3`.
- Dynamic `import()` heavy libraries inside `warmup` / `convert`, never at module
  top level, so the page itself loads instantly.
- The host page (and every test page) provides this import map, so bare
  `three` / `three/addons/…` specifiers work, including in dynamic imports:
  ```html
  <script type="importmap">
  {"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.module.js",
              "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/"}}
  </script>
  ```
- Web workers must be same-origin, so anything that spawns one (the
  `@ffmpeg/ffmpeg` wrapper) is vendored into `file/lib/<pkg>/`. Keep vendored
  files small (well under 1 MB); large wasm always stays on the CDN.
- GitHub Pages cannot set COOP/COEP headers, so there is no
  `SharedArrayBuffer`: use single-threaded builds only.
- Multi-file inputs are one File at a time; sidecar files (OBJ's .mtl, GLTF's
  external .bin) are not available — degrade gracefully.
- Don't touch files you don't own. Don't run `git commit`. No `vendor/` or
  `node_modules/` directories anywhere in the repo.
- Errors: throw `new Error('…')` with a plain-English message; the UI shows it
  verbatim.

## Testing

- Dev server: `.claude/launch.json` has a `portfolio` configuration
  (`python3 -m http.server 8765 --bind 127.0.0.1` at the repo root). Start it
  with `preview_start` name `portfolio`; it is shared with other agents, so if it
  is already running just reuse it.
- Other agents test in the same browser pane at the same time: create your own
  tab with `tabs_create`, then pass that `tabId` to every browser call
  (`navigate`, `computer`, `read_console_messages`, `javascript_tool`, …).
- Test pages live in `file/_dev/` (gitignored), samples in `file/_dev/samples/`.
  Copy `file/_dev/template.html` as a starting point. It exposes a log and a
  file input; load samples with `fetch('/file/_dev/samples/x.ext')` → `File`.
- `python http.server` sends no cache headers: bust caches when re-testing
  (`import('../engines/x.js?v=' + Date.now())`, and add `?v=N` to the page URL).
- Verify outputs for real: re-decode the result (createImageBitmap, `<video>`
  metadata, re-read the mesh / STEP, check magic bytes and sizes). "It produced
  a blob" is not verification.

## MeshSet — exchange format between model-mesh.js and model-cad.js

```js
// Triangles only. positions are xyz triples; with `indices` the mesh is indexed,
// without it every 3 positions form a triangle. Right-handed, Y-up or Z-up as
// the source had it — do not re-orient. Do not rescale unless options.scale
// says so.
{
  units: 'mm' | 'unknown',
  meshes: [
    { name: 'Body1',
      positions: Float32Array,
      normals?: Float32Array,     // per vertex
      indices?: Uint32Array,
      colors?: Float32Array }     // rgb 0..1 per vertex
  ]
}
```

`model-mesh.js` (mesh agent) exports, besides the engine API:
- `meshFormats` — the format objects for mesh formats
- `readMesh(file, inputId) -> Promise<MeshSet>`
- `writeMesh(meshSet, outputId, options) -> Promise<{ blob, ext? }>`

`model-cad.js` (CAD agent) exports:
- `cadFormats` — format objects for `step` (ext step, stp), `iges` (iges, igs), `brep`
- `loadNote`
- `readCad(file, inputId, options) -> Promise<MeshSet>` — tessellated
  (`options.deflection` in mm, default ~0.1; `options.angularDeflection` optional)
- `writeCad(meshSet, outputId, options) -> Promise<{ blob }>` — builds a faceted
  B-rep (one face per triangle, sewn; a solid when watertight, otherwise a shell
  or compound) and writes STEP / IGES / BREP.
- `convertCad(file, inputId, outputId, options) -> Promise<{ blob }>` — CAD to
  CAD, preserving the exact B-rep (no tessellation).
- `warmup()`

`model.js` (mesh agent) composes both: `formats = [...meshFormats, ...cadFormats]`,
routes mesh→mesh, mesh→cad, cad→mesh, cad→cad, and imports `./model-cad.js`
lazily inside a try/catch so the page keeps working (mesh only) if that module
is missing or fails to load.
