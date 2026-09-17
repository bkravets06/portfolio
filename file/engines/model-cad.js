/**
 * model-cad.js — CAD engine (STEP / IGES / BREP) for bjkravets.com/file.
 *
 * Runs OpenCascade (opencascade.js, full build) entirely in the browser. The
 * ~50 MB wasm is fetched lazily from jsDelivr on first use and shared by every
 * call through one promise.
 *
 * Contract exports (see file/_dev/CONTRACT.md, "MeshSet" section):
 *   cadFormats, loadNote, readCad, writeCad, convertCad, warmup
 * Extra exports (optional for the host):
 *   tessellationOptions — Option objects for readCad's deflection settings
 *   detectCad(file, head) — magic-byte / extension sniffing -> 'step'|'iges'|'brep'|null
 *   getOcc(options)      — the raw opencascade.js module (advanced / tests)
 *   loadInfo             — { state, fraction, message, loadMs, fastRead } of the wasm load
 *
 * Every entry point accepts, inside `options`:
 *   onProgress(fraction|null, message) — wasm download + conversion phases
 *   signal (AbortSignal) — honoured between phases and, while faces are being
 *     built, every ~80 ms (the loop yields to the event loop so the page can
 *     paint progress). Single OpenCascade calls (tessellation, sewing, the
 *     STEP/IGES writers) cannot be interrupted once started.
 *
 * Mesh -> CAD (writeCad) builds a faceted B-rep: vertices are welded with a
 * tolerance, one planar face per triangle, faces share edges exactly, triangle
 * winding is made consistent per connected component and each closed
 * component becomes a solid. BRepBuilderAPI_Sewing is only used for
 * components that are still not closed manifolds after that, and only up to
 * SEW_MAX_FACES faces (above that the shell is written unsewn, see writeCad).
 * Faceted STEP output is written without 2D parameter curves (pcurves) and
 * carries a marker in its header; when such a file comes back through readCad
 * the STEP reader's default per-face shape healing is skipped (it is
 * redundant for planar faces and costs ~1 ms per face).
 */

const OCC_VERSION = '2.0.0-beta.b5ff984';
const OCC_BASE = `https://cdn.jsdelivr.net/npm/opencascade.js@${OCC_VERSION}/dist/`;
const OCC_JS = `${OCC_BASE}opencascade.full.js`;
const OCC_WASM = `${OCC_BASE}opencascade.full.wasm`;
const OCC_WASM_BYTES = 50305130; // uncompressed size, used for download progress

export const loadNote =
  'Downloads ~50 MB of OpenCascade (the CAD kernel) on first use; your browser usually caches it afterwards.';

const FACETED_NOTE = 'Meshes become faceted: one flat face per triangle';

export const cadFormats = [
  {
    id: 'step', name: 'STEP', ext: ['step', 'stp'], mime: 'model/step',
    read: true, write: true, group: 'CAD', note: FACETED_NOTE,
  },
  {
    id: 'iges', name: 'IGES', ext: ['iges', 'igs'], mime: 'model/iges',
    read: true, write: true, group: 'CAD', note: FACETED_NOTE,
  },
  {
    id: 'brep', name: 'BREP', ext: ['brep'], mime: 'application/octet-stream',
    read: true, write: true, group: 'CAD', note: FACETED_NOTE,
  },
];

// Options that make sense when a CAD file is tessellated into a mesh
// (readCad reads options.deflection / options.angularDeflection).
export const tessellationOptions = [
  {
    id: 'deflection', label: 'Tessellation accuracy', type: 'number',
    default: 0.1, min: 0.001, max: 10, step: 0.01, unit: 'mm',
    help: 'Largest gap allowed between a curved CAD surface and its triangles. Smaller = more triangles.',
  },
  {
    id: 'angularDeflection', label: 'Angular deflection', type: 'number',
    default: 0.5, min: 0.05, max: 1.5, step: 0.05, unit: 'rad',
    help: 'Largest angle allowed between neighbouring triangles on curved surfaces.',
  },
];

const DEFAULT_DEFLECTION = 0.1;      // mm
const DEFAULT_ANGULAR = 0.5;         // radians

// Mesh -> B-rep tuning (all relative to the mesh's bounding-box diagonal).
const WELD_TOLERANCE_FACTOR = 1e-5;  // vertices closer than this are the same vertex
const SEW_TOLERANCE_FACTOR = 1e-4;   // BRepBuilderAPI_Sewing tolerance
// Components that are not closed manifolds after welding/orientation are sewn
// only up to this many faces; larger ones are written as unsewn shells.
// (Measured here: sewing ~10k faces takes 1.5-7 s, ~100k faces ~40 s.)
export const SEW_MAX_FACES = 50000;

// Header marker written into faceted STEP output (see readShape).
const MARKER = 'bjkravets.com/file';
const FACETED_DESCRIPTION = `Faceted B-rep (one planar face per triangle) written by ${MARKER}`;
// Resource name/dir used to switch the STEP reader's default shape healing off
// for marked files: OpenCascade only skips its default ShapeFix when a resource
// file <CSF_<name>Defaults>/<name> defines "FromSTEP.exec.op".
const RSC_DIR = '/occ-rsc';
const FAST_RSC_NAME = 'STEPFAST';

const MIME = { step: 'model/step', iges: 'model/iges', brep: 'application/octet-stream' };
const NAMES = { step: 'STEP', iges: 'IGES', brep: 'BREP' };

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

let occPromise = null;
const progressListeners = new Set();
export const loadInfo = { state: 'idle', fraction: 0, message: '', loadMs: 0, fastRead: false };

function emitLoad(fraction, message) {
  loadInfo.fraction = fraction;
  loadInfo.message = message;
  for (const fn of progressListeners) {
    try { fn(fraction, message); } catch { /* listener errors are not ours */ }
  }
}

/** Start (or join) the wasm download. Idempotent; safe to call concurrently. */
let warmupPromise = null;
export function warmup() {
  if (!warmupPromise) {
    warmupPromise = getOcc().then(() => undefined, (err) => { warmupPromise = null; throw err; });
  }
  return warmupPromise;
}

/** Resolve the initialised opencascade.js module (shared promise). */
export function getOcc(options) {
  if (!occPromise) {
    loadInfo.state = 'loading';
    occPromise = loadOcc().then(
      (oc) => { loadInfo.state = 'ready'; return oc; },
      (err) => { occPromise = null; loadInfo.state = 'error'; throw err; },
    );
  }
  const onProgress = options && typeof options.onProgress === 'function' ? options.onProgress : null;
  if (onProgress && loadInfo.state === 'loading') {
    progressListeners.add(onProgress);
    return occPromise.finally(() => progressListeners.delete(onProgress));
  }
  return occPromise;
}

async function loadOcc() {
  const t0 = performance.now();
  emitLoad(0, 'Loading CAD engine…');
  let factory;
  try {
    ({ default: factory } = await import(/* @vite-ignore */ OCC_JS));
  } catch {
    throw new Error('Could not load the CAD engine (opencascade.js) from jsDelivr. Check your connection and try again.');
  }
  let failLoad;
  const failed = new Promise((_, reject) => { failLoad = reject; });
  const memoryRef = { memory: null };
  let envInjected = false;
  const ready = factory({
    // The factory resolves its wasm relative to document.currentScript, which is
    // null for an ES-module import, so point it at the CDN explicitly.
    locateFile: (path) => OCC_BASE + path,
    // Stream the wasm ourselves so the 50 MB download can report progress.
    instantiateWasm(imports, onSuccess) {
      try { envInjected = injectEnv(imports, memoryRef, { [`CSF_${FAST_RSC_NAME}Defaults`]: RSC_DIR }); } catch { envInjected = false; }
      streamInstantiate(imports).then(
        ({ instance, module }) => {
          memoryRef.memory = Object.values(instance.exports).find((v) => v instanceof WebAssembly.Memory) || null;
          onSuccess(instance, module);
        },
        (err) => failLoad(err),
      );
      return {};
    },
    print: (s) => console.debug('[occ]', s),
    printErr: (s) => console.warn('[occ]', s),
    onAbort: (what) => failLoad(new Error(`The CAD engine failed to start (${what}).`)),
  });
  const oc = await Promise.race([ready, failed]);
  loadInfo.fastRead = envInjected && !!memoryRef.memory && setupResources(oc);
  loadInfo.loadMs = Math.round(performance.now() - t0);
  emitLoad(1, 'CAD engine ready');
  return oc;
}

/**
 * Add environment variables to the Emscripten process. The glue keeps its ENV
 * object private, so wrap the two WASI imports it answers getenv() from.
 */
function injectEnv(imports, memoryRef, extra) {
  const entries = Object.entries(extra).map(([k, v]) => `${k}=${v}`);
  let ns = null, sizesKey = null, getKey = null;
  for (const obj of Object.values(imports)) {
    if (!obj || typeof obj !== 'object') continue;
    for (const [k, fn] of Object.entries(obj)) {
      if (typeof fn !== 'function') continue;
      if (fn.name === '_environ_sizes_get') { ns = obj; sizesKey = k; }
      else if (fn.name === '_environ_get') { ns = obj; getKey = k; }
    }
  }
  if (!ns || !sizesKey || !getKey) return false;
  const origSizes = ns[sizesKey], origGet = ns[getKey];
  const state = { count: 0, size: 0 };
  let extraBytes = 0;
  for (const s of entries) extraBytes += s.length + 1;
  ns[sizesKey] = function environSizesGet(pCount, pSize) {
    const r = origSizes(pCount, pSize);
    const mem = memoryRef.memory;
    if (r !== 0 || !mem) return r;
    const u32 = new Uint32Array(mem.buffer);
    state.count = u32[pCount >> 2];
    state.size = u32[pSize >> 2];
    u32[pCount >> 2] = state.count + entries.length;
    u32[pSize >> 2] = state.size + extraBytes;
    return 0;
  };
  ns[getKey] = function environGet(pEnviron, pBuf) {
    const r = origGet(pEnviron, pBuf);
    const mem = memoryRef.memory;
    if (r !== 0 || !mem) return r;
    const u32 = new Uint32Array(mem.buffer), u8 = new Uint8Array(mem.buffer);
    let off = pBuf + state.size;
    entries.forEach((s, i) => {
      u32[(pEnviron >> 2) + state.count + i] = off;
      for (let j = 0; j < s.length; j++) u8[off + j] = s.charCodeAt(j) & 0x7f;
      u8[off + s.length] = 0;
      off += s.length + 1;
    });
    return 0;
  };
  return true;
}

/** Write the resource file that turns the STEP reader's default healing off. */
function setupResources(oc) {
  try {
    try { oc.FS.mkdir(RSC_DIR); } catch { /* exists */ }
    // An empty operator list: OpenCascade finds the sequence, runs nothing.
    oc.FS.writeFile(`${RSC_DIR}/${FAST_RSC_NAME}`, 'FromSTEP.exec.op :\n');
    return true;
  } catch (e) {
    console.warn('[occ] could not set up resources:', e);
    return false;
  }
}

async function streamInstantiate(imports) {
  const netError = 'Could not download the CAD engine (~50 MB) from jsDelivr. Check your connection and try again.';
  let res;
  try { res = await fetch(OCC_WASM); } catch { throw new Error(netError); }
  if (!res.ok) throw new Error(`Could not download the CAD engine (HTTP ${res.status} from jsDelivr).`);
  const total = OCC_WASM_BYTES;
  let loaded = 0;
  const canStream = typeof WebAssembly.instantiateStreaming === 'function'
    && res.body && typeof ReadableStream === 'function';
  if (canStream) {
    const reader = res.body.getReader();
    const counted = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          emitLoad(0.99, 'Compiling CAD engine…');
          controller.close();
          return;
        }
        loaded += value.byteLength;
        emitLoad(Math.min(loaded / total, 0.98),
          `Downloading CAD engine… ${Math.round(loaded / 1048576)} / ${Math.round(total / 1048576)} MB`);
        controller.enqueue(value);
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    const response = new Response(counted, { headers: { 'Content-Type': 'application/wasm' } });
    try {
      return await WebAssembly.instantiateStreaming(response, imports);
    } catch (err) {
      console.warn('[occ] streaming instantiation failed, falling back to ArrayBuffer:', err);
    }
  }
  let buf;
  try {
    const again = canStream ? await fetch(OCC_WASM) : res;
    if (!again.ok) throw new Error();
    buf = await again.arrayBuffer();
  } catch { throw new Error(netError); }
  emitLoad(0.99, 'Compiling CAD engine…');
  return WebAssembly.instantiate(buf, imports);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

let jobCounter = 0;

function progressFn(options) {
  const fn = options && typeof options.onProgress === 'function' ? options.onProgress : null;
  return (fraction, message) => { if (fn) { try { fn(fraction, message); } catch { /* ignore */ } } };
}

function abortError(signal) {
  const r = signal && signal.reason;
  if (r instanceof Error && r.name !== 'AbortError') return r;
  return new Error('Conversion cancelled.');
}

function throwIfAborted(options) {
  const signal = options && options.signal;
  if (signal && signal.aborted) throw abortError(signal);
}

const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

function enumIs(a, b) {
  return a === b || (a != null && b != null && a.value !== undefined && a.value === b.value);
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Translate a C++ exception thrown through Embind into a readable Error. */
function occError(oc, e, what) {
  if (e instanceof Error) return e;
  let detail = '';
  if (typeof e === 'number' && oc.OCJS && typeof oc.OCJS.getStandard_FailureData === 'function') {
    try {
      const failure = oc.OCJS.getStandard_FailureData(e);
      detail = String(failure.GetMessageString() || '');
      if (typeof failure.delete === 'function') failure.delete();
    } catch { /* not a Standard_Failure */ }
  } else if (e && typeof e === 'object' && e.message) {
    detail = String(e.message);
  }
  return new Error(`${what} failed inside the CAD kernel${detail ? ` (${detail})` : ''}.`);
}

function occTry(oc, what, fn) {
  try { return fn(); } catch (e) { throw occError(oc, e, what); }
}

function withFile(oc, path, bytes, fn) {
  oc.FS.writeFile(path, bytes);
  try { return fn(path); } finally { try { oc.FS.unlink(path); } catch { /* already gone */ } }
}

function hstring(oc, text) {
  return new oc.Handle_TCollection_HAsciiString_2(new oc.TCollection_HAsciiString_2(String(text)));
}

/** Copies of every sub-shape of `type` (caller deletes them). */
function listShapes(oc, root, type, avoid) {
  const out = [];
  const ex = new oc.TopExp_Explorer_2(root, type, avoid || oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  try { for (; ex.More(); ex.Next()) out.push(ex.Current()); } finally { ex.delete(); }
  return out;
}

function deleteAll(list) { for (const s of list) { try { s.delete(); } catch { /* ignore */ } } }

function bboxOfShape(oc, shape) {
  const box = new oc.Bnd_Box_1();
  try {
    oc.BRepBndLib.Add(shape, box, false);
    if (box.IsVoid()) return null;
    const mn = box.CornerMin(), mx = box.CornerMax();
    const r = { min: [mn.X(), mn.Y(), mn.Z()], max: [mx.X(), mx.Y(), mx.Z()] };
    mn.delete(); mx.delete();
    return r;
  } finally { box.delete(); }
}

function diagonal(bbox) {
  if (!bbox) return 0;
  const dx = bbox.max[0] - bbox.min[0], dy = bbox.max[1] - bbox.min[1], dz = bbox.max[2] - bbox.min[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function bboxOfPositions(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < pos.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = pos[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return pos.length >= 3 && Number.isFinite(min[0]) ? { min, max } : null;
}

/** True when the first bytes of a STEP file carry our faceted-output marker. */
function hasFacetedMarker(bytes) {
  const n = Math.min(bytes.length, 2048);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]);
  return s.includes(MARKER) && s.includes('Faceted B-rep');
}

// ---------------------------------------------------------------------------
// Reading a shape from a file
// ---------------------------------------------------------------------------

/**
 * Read STEP / IGES / BREP bytes into a TopoDS_Shape (caller deletes it).
 * Returns { shape, faceted } — faceted is true when the STEP file carried our
 * marker, in which case the reader's default healing was skipped.
 */
function readShape(oc, bytes, formatId, fileName) {
  const label = fileName ? `"${fileName}"` : 'the file';
  const fmt = NAMES[formatId];
  if (!fmt) throw new Error(`Unknown CAD format "${formatId}".`);
  if (!bytes.length) throw new Error(`${label} is empty.`);
  const path = `/in_${++jobCounter}.${formatId}`;
  return withFile(oc, path, bytes, () => {
    if (formatId === 'brep') {
      const shape = new oc.TopoDS_Shape();
      const builder = new oc.BRep_Builder();
      const progress = new oc.Message_ProgressRange_1();
      let ok = false;
      try { ok = oc.BRepTools.Read_2(shape, path, builder, progress); }
      catch (e) { console.warn('[occ] BRep read:', e); ok = false; }
      finally { progress.delete(); builder.delete(); }
      if (!ok || shape.IsNull()) {
        shape.delete();
        throw new Error(`Could not read ${label}: it does not look like a valid BREP (OpenCascade) file.`);
      }
      return { shape, faceted: false };
    }
    const faceted = formatId === 'step' && loadInfo.fastRead && hasFacetedMarker(bytes);
    const reader = formatId === 'step' ? new oc.STEPControl_Reader_1() : new oc.IGESControl_Reader_1();
    if (formatId === 'step') oc.Interface_Static.SetCVal('read.step.resource.name', faceted ? FAST_RSC_NAME : 'STEP');
    try {
      let status = null;
      try { status = reader.ReadFile(path); }
      catch (e) { console.warn('[occ] read:', occError(oc, e, 'Reading').message); }
      if (!enumIs(status, oc.IFSelect_ReturnStatus.IFSelect_RetDone)) {
        throw new Error(`Could not read ${label}: it does not look like a valid ${fmt} file (it may be damaged or truncated).`);
      }
      const progress = new oc.Message_ProgressRange_1();
      let roots = 0;
      try { roots = occTry(oc, `Reading the ${fmt} geometry`, () => reader.TransferRoots(progress)); }
      finally { progress.delete(); }
      if (!(roots > 0)) throw new Error(`${label} contains no geometry that could be converted.`);
      const shape = reader.OneShape();
      if (shape.IsNull()) {
        shape.delete();
        throw new Error(`${label} contains no geometry that could be converted.`);
      }
      return { shape, faceted };
    } finally {
      reader.delete();
      if (formatId === 'step') oc.Interface_Static.SetCVal('read.step.resource.name', 'STEP');
    }
  });
}

// ---------------------------------------------------------------------------
// Tessellation: shape -> MeshSet
// ---------------------------------------------------------------------------

function tessellate(oc, shape, linear, angular) {
  const mesher = occTry(oc, 'Tessellation',
    () => new oc.BRepMesh_IncrementalMesh_2(shape, linear, false, angular, false));
  mesher.delete();
}

function applyTransform(pos, m) {
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    pos[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
    pos[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    pos[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  }
}

/** Area-weighted per-vertex normals (nodes are per face, so creases stay sharp). */
function computeNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
    const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2];
    const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (l > 0) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; } else { n[i + 2] = 1; }
  }
  return n;
}

/** Triangulations of every face under `root`, skipping sub-shapes of type `avoid`. */
function collectFaces(oc, root, avoid) {
  const chunks = [];
  const explorer = new oc.TopExp_Explorer_2(root, oc.TopAbs_ShapeEnum.TopAbs_FACE, avoid);
  const loc = new oc.TopLoc_Location_1();
  const REVERSED = oc.TopAbs_Orientation.TopAbs_REVERSED;
  try {
    for (; explorer.More(); explorer.Next()) {
      const current = explorer.Current();
      const face = oc.TopoDS.Face_1(current);
      current.delete();
      // Poly_MeshPurpose is not bound in this build; 0 = Poly_MeshPurpose_NONE.
      const handle = oc.BRep_Tool.Triangulation(face, loc, 0);
      try {
        if (handle.IsNull()) continue;
        const tri = handle.get();
        const nbNodes = tri.NbNodes(), nbTris = tri.NbTriangles();
        if (nbNodes < 3 || nbTris < 1) continue;
        const pos = new Float32Array(nbNodes * 3);
        for (let i = 1, k = 0; i <= nbNodes; i++, k += 3) {
          const p = tri.Node(i);
          pos[k] = p.X(); pos[k + 1] = p.Y(); pos[k + 2] = p.Z();
          p.delete();
        }
        let mirrored = false;
        if (!loc.IsIdentity()) {
          const trsf = loc.Transformation();
          mirrored = !!trsf.IsNegative();
          const m = [];
          for (let r = 1; r <= 3; r++) for (let c = 1; c <= 4; c++) m.push(trsf.Value(r, c));
          trsf.delete();
          applyTransform(pos, m);
        }
        const reversed = enumIs(face.Orientation_1(), REVERSED);
        const flip = reversed !== mirrored;
        const idx = new Uint32Array(nbTris * 3);
        for (let i = 1, k = 0; i <= nbTris; i++, k += 3) {
          const t = tri.Triangle(i);
          const a = t.Value(1) - 1, b = t.Value(2) - 1, c = t.Value(3) - 1;
          t.delete();
          idx[k] = a;
          if (flip) { idx[k + 1] = c; idx[k + 2] = b; } else { idx[k + 1] = b; idx[k + 2] = c; }
        }
        chunks.push({ pos, idx });
      } finally { handle.delete(); face.delete(); }
    }
  } finally { loc.delete(); explorer.delete(); }
  return chunks;
}

function mergeChunks(chunks, name) {
  let nv = 0, ni = 0;
  for (const c of chunks) { nv += c.pos.length; ni += c.idx.length; }
  if (!ni) return null;
  const positions = new Float32Array(nv);
  const normals = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const c of chunks) {
    positions.set(c.pos, vo);
    normals.set(computeNormals(c.pos, c.idx), vo);
    const base = vo / 3;
    for (let k = 0; k < c.idx.length; k++) indices[io + k] = c.idx[k] + base;
    vo += c.pos.length; io += c.idx.length;
  }
  return { name, positions, normals, indices };
}

function extractMeshes(oc, shape) {
  const E = oc.TopAbs_ShapeEnum;
  const meshes = [];
  const solids = listShapes(oc, shape, E.TopAbs_SOLID);
  try {
    solids.forEach((solid, i) => {
      const m = mergeChunks(collectFaces(oc, solid, E.TopAbs_SHAPE), `Body${i + 1}`);
      if (m) meshes.push(m);
    });
    // Faces that belong to no solid (free shells / sheet bodies).
    const loose = mergeChunks(collectFaces(oc, shape, E.TopAbs_SOLID), `Body${meshes.length + 1}`);
    if (loose) meshes.push(loose);
  } finally { deleteAll(solids); }
  if (!meshes.length) {
    throw new Error('This CAD file has no surfaces to tessellate (it may only contain curves or points).');
  }
  return meshes;
}

/**
 * Tessellate a STEP / IGES / BREP file into a MeshSet.
 * options.deflection (mm, default 0.1) and options.angularDeflection (rad,
 * default 0.5) control the triangle density.
 */
export async function readCad(file, inputId, options = {}) {
  const progress = progressFn(options);
  if (!NAMES[inputId]) throw new Error(`Unknown CAD format "${inputId}".`);
  throwIfAborted(options);
  const oc = await getOcc(options);
  throwIfAborted(options);
  progress(null, `Reading ${NAMES[inputId]} file…`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(options);
  const { shape } = readShape(oc, bytes, inputId, file && file.name);
  try {
    throwIfAborted(options);
    let linear = positiveNumber(options.deflection, DEFAULT_DEFLECTION);
    const angular = positiveNumber(options.angularDeflection, DEFAULT_ANGULAR);
    // Never finer than 1e-5 of the model size: protects huge models from
    // exploding into tens of millions of triangles.
    const diag = diagonal(bboxOfShape(oc, shape));
    if (diag > 0) linear = Math.max(linear, diag * 1e-5);
    progress(null, 'Tessellating…');
    await yieldToEventLoop();
    throwIfAborted(options);
    tessellate(oc, shape, linear, angular);
    throwIfAborted(options);
    const meshes = extractMeshes(oc, shape);
    progress(1, 'Tessellated');
    return { units: 'mm', meshes };
  } finally { shape.delete(); }
}

// ---------------------------------------------------------------------------
// MeshSet -> faceted B-rep -> file
// ---------------------------------------------------------------------------

function triangleIndices(mesh) {
  if (mesh.indices && mesh.indices.length) return mesh.indices;
  const n = Math.floor(mesh.positions.length / 3);
  const idx = new Uint32Array(n - (n % 3));
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  return idx;
}

/**
 * Weld vertices closer than `tol` (grid hash, so float noise between the
 * copies of a shared vertex still welds), drop degenerate triangles and split
 * the mesh into connected components.
 * Returns { verts: Float64Array, tris: Uint32Array, comp: Int32Array (per triangle), nComp, skipped }.
 */
function weldMesh(mesh, tol, bbox) {
  const pos = mesh.positions;
  const src = triangleIndices(mesh);
  const nSrc = Math.floor(pos.length / 3);
  const cell = tol * 2, inv = 1 / cell, tol2 = tol * tol;
  const ox = bbox.min[0] - tol, oy = bbox.min[1] - tol, oz = bbox.min[2] - tol;
  const K = 131072; // cells per axis never exceed 1 / (2 * WELD_TOLERANCE_FACTOR)
  const remap = new Uint32Array(nSrc);
  const vx = new Float64Array(nSrc), vy = new Float64Array(nSrc), vz = new Float64Array(nSrc);
  const next = new Int32Array(nSrc); // per welded vertex: next vertex in the same cell
  const head = new Map();            // cell key -> first welded vertex in that cell
  let nV = 0;
  for (let i = 0; i < nSrc; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const x0 = Math.floor((x - ox - tol) * inv), x1 = Math.floor((x - ox + tol) * inv);
    const y0 = Math.floor((y - oy - tol) * inv), y1 = Math.floor((y - oy + tol) * inv);
    const z0 = Math.floor((z - oz - tol) * inv), z1 = Math.floor((z - oz + tol) * inv);
    let found = -1;
    for (let ix = x0; ix <= x1 && found < 0; ix++) {
      for (let iy = y0; iy <= y1 && found < 0; iy++) {
        for (let iz = z0; iz <= z1 && found < 0; iz++) {
          let v = head.get((ix * K + iy) * K + iz);
          while (v !== undefined && v >= 0) {
            const dx = vx[v] - x, dy = vy[v] - y, dz = vz[v] - z;
            if (dx * dx + dy * dy + dz * dz <= tol2) { found = v; break; }
            v = next[v];
          }
        }
      }
    }
    if (found < 0) {
      found = nV++;
      vx[found] = x; vy[found] = y; vz[found] = z;
      const key = (Math.floor((x - ox) * inv) * K + Math.floor((y - oy) * inv)) * K + Math.floor((z - oz) * inv);
      const h = head.get(key);
      next[found] = h === undefined ? -1 : h;
      head.set(key, found);
    }
    remap[i] = found;
  }
  const verts = new Float64Array(nV * 3);
  for (let i = 0; i < nV; i++) { verts[i * 3] = vx[i]; verts[i * 3 + 1] = vy[i]; verts[i * 3 + 2] = vz[i]; }

  // union-find over vertices -> connected components
  const parent = new Int32Array(nV);
  for (let i = 0; i < nV; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };

  const nT = Math.floor(src.length / 3);
  const tris = new Uint32Array(nT * 3);
  let kept = 0, skipped = 0;
  for (let t = 0; t < nT; t++) {
    const ia = src[t * 3], ib = src[t * 3 + 1], ic = src[t * 3 + 2];
    if (!(ia < nSrc && ib < nSrc && ic < nSrc)) { skipped++; continue; }
    const a = remap[ia], b = remap[ib], c = remap[ic];
    if (a === b || b === c || c === a) { skipped++; continue; }
    const ax = verts[a * 3], ay = verts[a * 3 + 1], az = verts[a * 3 + 2];
    const abx = verts[b * 3] - ax, aby = verts[b * 3 + 1] - ay, abz = verts[b * 3 + 2] - az;
    const acx = verts[c * 3] - ax, acy = verts[c * 3 + 1] - ay, acz = verts[c * 3 + 2] - az;
    const bcx = acx - abx, bcy = acy - aby, bcz = acz - abz;
    const lab = Math.hypot(abx, aby, abz), lac = Math.hypot(acx, acy, acz), lbc = Math.hypot(bcx, bcy, bcz);
    const cross = Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
    // Degenerate: an edge shorter than the tolerance, or a height below it.
    if (!(Math.min(lab, lac, lbc) > tol) || !(cross > tol * Math.max(lab, lac, lbc))) { skipped++; continue; }
    tris[kept * 3] = a; tris[kept * 3 + 1] = b; tris[kept * 3 + 2] = c;
    kept++;
    union(a, b); union(b, c);
  }
  const compOfRoot = new Map();
  const comp = new Int32Array(kept);
  for (let t = 0; t < kept; t++) {
    const r = find(tris[t * 3]);
    let id = compOfRoot.get(r);
    if (id === undefined) { id = compOfRoot.size; compOfRoot.set(r, id); }
    comp[t] = id;
  }
  return { verts, tris: tris.subarray(0, kept * 3), comp, nComp: compOfRoot.size, skipped };
}

/**
 * Make the winding consistent across every manifold edge (flood fill), and
 * report per component whether it is a closed 2-manifold. Modifies `tris`.
 * Returns { closed: Uint8Array(nComp), reoriented }.
 */
function orientMesh(tris, comp, nComp, nV) {
  const nTri = tris.length / 3;
  const eMap = new Map();
  const triEdge = new Int32Array(nTri * 3);
  const eT1 = new Int32Array(nTri * 3).fill(-1), eT2 = new Int32Array(nTri * 3).fill(-1);
  const eN = new Uint32Array(nTri * 3);
  let nE = 0;
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tris[t * 3 + k], b = tris[t * 3 + (k + 1) % 3];
      const key = a < b ? a * nV + b : b * nV + a;
      let e = eMap.get(key);
      if (e === undefined) { e = nE++; eMap.set(key, e); }
      triEdge[t * 3 + k] = e;
      eN[e]++;
      if (eT1[e] < 0) eT1[e] = t; else if (eT2[e] < 0) eT2[e] = t;
    }
  }
  const flip = new Uint8Array(nTri), visited = new Uint8Array(nTri), stack = new Int32Array(nTri);
  const bad = new Uint8Array(nComp);
  for (let s = 0; s < nTri; s++) {
    if (visited[s]) continue;
    visited[s] = 1;
    let sp = 0;
    stack[sp++] = s;
    while (sp) {
      const t = stack[--sp];
      for (let k = 0; k < 3; k++) {
        const e = triEdge[t * 3 + k];
        if (eN[e] !== 2) continue; // boundary or non-manifold: nothing to propagate
        const n = eT1[e] === t ? eT2[e] : eT1[e];
        if (n < 0 || n === t) continue;
        const fwdT = tris[t * 3 + k] < tris[t * 3 + (k + 1) % 3];
        let fwdN = false;
        for (let j = 0; j < 3; j++) {
          if (triEdge[n * 3 + j] === e) { fwdN = tris[n * 3 + j] < tris[n * 3 + (j + 1) % 3]; break; }
        }
        const dirT = fwdT !== (flip[t] === 1);
        const needFlip = fwdN === dirT ? 1 : 0; // n must traverse the edge the other way
        if (!visited[n]) { visited[n] = 1; flip[n] = needFlip; stack[sp++] = n; }
        else if (flip[n] !== needFlip) bad[comp[t]] = 1;
      }
    }
  }
  for (let e = 0; e < nE; e++) if (eN[e] !== 2) bad[comp[eT1[e]]] = 1;
  let reoriented = 0;
  for (let t = 0; t < nTri; t++) {
    if (!flip[t]) continue;
    const b = tris[t * 3 + 1]; tris[t * 3 + 1] = tris[t * 3 + 2]; tris[t * 3 + 2] = b;
    reoriented++;
  }
  const closed = new Uint8Array(nComp);
  for (let c = 0; c < nComp; c++) closed[c] = bad[c] ? 0 : 1;
  return { closed, reoriented };
}

function signedVolume(verts, tris, from, to) {
  let v = 0;
  for (let t = from; t < to; t++) {
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    v += verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1])
       - verts[a + 1] * (verts[b] * verts[c + 2] - verts[b + 2] * verts[c])
       + verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c]);
  }
  return v / 6;
}

function copyShape(oc, shape) {
  // Cheap copy of the handle (same underlying TShape); keeps ownership simple.
  return shape.Oriented(shape.Orientation_1());
}

/** Closed shell -> solid (oriented by ShapeFix); open shell -> itself (copied). */
function shellToSolidOrSelf(oc, shellShape) {
  const shell = oc.TopoDS.Shell_1(shellShape);
  try {
    if (!oc.BRep_Tool.IsClosed_1(shell)) return { shape: copyShape(oc, shellShape), solid: false };
    const fix = new oc.ShapeFix_Solid_1();
    try {
      const solid = fix.SolidFromShell(shell); // also orients the solid correctly
      if (solid.IsNull()) { solid.delete(); return { shape: copyShape(oc, shellShape), solid: false }; }
      return { shape: solid, solid: true };
    } finally { fix.delete(); }
  } finally { shell.delete(); }
}

/** Turn sewn shells into solids where they are closed; returns { shape, solids, shells }. */
function solidify(oc, sewed) {
  const E = oc.TopAbs_ShapeEnum;
  const type = sewed.ShapeType();
  if (enumIs(type, E.TopAbs_SHELL)) {
    const r = shellToSolidOrSelf(oc, sewed);
    return { shape: r.shape, solids: r.solid ? 1 : 0, shells: r.solid ? 0 : 1 };
  }
  if (!enumIs(type, E.TopAbs_COMPOUND)) return { shape: copyShape(oc, sewed), solids: 0, shells: 0 };
  const builder = new oc.BRep_Builder();
  const comp = new oc.TopoDS_Compound();
  builder.MakeCompound(comp);
  let solids = 0, shells = 0;
  const shellList = listShapes(oc, sewed, E.TopAbs_SHELL);
  const faceList = listShapes(oc, sewed, E.TopAbs_FACE, E.TopAbs_SHELL); // faces outside any shell
  try {
    for (const sh of shellList) {
      const r = shellToSolidOrSelf(oc, sh);
      builder.Add(comp, r.shape);
      r.shape.delete();
      if (r.solid) solids++; else shells++;
    }
    for (const f of faceList) builder.Add(comp, f);
  } finally { deleteAll(shellList); deleteAll(faceList); builder.delete(); }
  return { shape: comp, solids, shells };
}

/** Sew an open / non-manifold shell with the given tolerance and solidify the result. */
function sewAndSolidify(oc, shape, tol) {
  const sewing = new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
  const range = new oc.Message_ProgressRange_1();
  let sewed;
  try {
    occTry(oc, 'Sewing the faces', () => { sewing.Load(shape); sewing.Perform(range); });
    sewed = sewing.SewedShape();
  } finally { range.delete(); sewing.delete(); }
  try { return solidify(oc, sewed); } finally { sewed.delete(); }
}

/**
 * Build a faceted B-rep from one mesh: vertices and edges are shared exactly
 * (welded), one planar face per triangle, one shell per connected component.
 * A closed, consistently oriented component becomes a solid directly; anything
 * else is sewn (up to SEW_MAX_FACES faces) or left as an unsewn shell.
 * Returns { shape, stats }.
 */
async function meshToShape(oc, mesh, index, progress, total, opts) {
  const t0 = performance.now();
  const bbox = bboxOfPositions(mesh.positions);
  const diag = diagonal(bbox);
  if (!(diag > 0)) throw new Error(`Mesh "${mesh.name || index + 1}" has no usable triangles.`);
  let maxAbs = 0;
  for (let a = 0; a < 3; a++) maxAbs = Math.max(maxAbs, Math.abs(bbox.min[a]), Math.abs(bbox.max[a]));
  // Weld tolerance: 1e-5 of the size, but never below a few float32 ulps of
  // the largest coordinate (parts far from the origin carry coarser noise).
  const tol = Math.max(diag * WELD_TOLERANCE_FACTOR, maxAbs * 4 * 6e-8, 1e-9);
  const sewTol = Math.max(diag * SEW_TOLERANCE_FACTOR, 1e-7);
  const sewMax = positiveNumber(opts.sewMaxFaces, SEW_MAX_FACES);
  const { verts, tris, comp, nComp, skipped } = weldMesh(mesh, tol, bbox);
  const nTri = tris.length / 3;
  if (!nTri) throw new Error(`Mesh "${mesh.name || index + 1}" has no usable triangles (all degenerate).`);
  const nV = verts.length / 3;
  const { closed: closedComp, reoriented } = orientMesh(tris, comp, nComp, nV);
  const weldMs = performance.now() - t0;

  // Group triangles by component; flip components whose winding points inward.
  const order = new Uint32Array(nTri);
  const compStart = new Uint32Array(nComp + 1);
  for (let t = 0; t < nTri; t++) compStart[comp[t] + 1]++;
  for (let c = 0; c < nComp; c++) compStart[c + 1] += compStart[c];
  { const fill = compStart.slice(0, nComp); for (let t = 0; t < nTri; t++) order[fill[comp[t]]++] = t; }
  const sorted = new Uint32Array(nTri * 3);
  for (let i = 0; i < nTri; i++) { const t = order[i]; sorted[i * 3] = tris[t * 3]; sorted[i * 3 + 1] = tris[t * 3 + 1]; sorted[i * 3 + 2] = tris[t * 3 + 2]; }
  let flipped = 0;
  for (let c = 0; c < nComp; c++) {
    if (closedComp[c] && signedVolume(verts, sorted, compStart[c], compStart[c + 1]) < 0) {
      flipped++;
      for (let t = compStart[c]; t < compStart[c + 1]; t++) { const b = sorted[t * 3 + 1]; sorted[t * 3 + 1] = sorted[t * 3 + 2]; sorted[t * 3 + 2] = b; }
    }
  }

  const builder = new oc.BRep_Builder();
  const vertexObjs = new Array(nV).fill(null);
  const edgeMap = new Map(); // key -> { e, r }
  const vertexOf = (i) => {
    let v = vertexObjs[i];
    if (!v) {
      const p = new oc.gp_Pnt_3(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
      const mv = new oc.BRepBuilderAPI_MakeVertex(p);
      v = mv.Vertex();
      mv.delete(); p.delete();
      vertexObjs[i] = v;
    }
    return v;
  };
  const edgeOf = (i, j) => { // directed i -> j; returns the oriented edge shape to add to a wire
    const lo = i < j ? i : j, hi = i < j ? j : i;
    const key = lo * nV + hi;
    let rec = edgeMap.get(key);
    if (!rec) {
      const me = new oc.BRepBuilderAPI_MakeEdge_2(vertexOf(lo), vertexOf(hi));
      const e = me.Edge();
      me.delete();
      rec = { e, r: e.Reversed() };
      edgeMap.set(key, rec);
    }
    return i < j ? rec.e : rec.r;
  };

  const shells = [];
  const stats = {
    name: mesh.name, triangles: Math.floor(triangleIndices(mesh).length / 3), faces: 0, skipped, vertices: nV,
    components: nComp, reoriented, flipped, closed: 0, solids: 0, shells: 0, sewn: 0, unsewn: 0,
    weldMs, buildMs: 0, sewMs: 0, tolerance: tol, sewTolerance: sewTol,
  };
  const shapes = [];
  try {
    const step = Math.max(1, Math.floor(nTri / 100));
    let lastYield = performance.now();
    for (let c = 0; c < nComp; c++) {
      const shell = new oc.TopoDS_Shell();
      builder.MakeShell(shell);
      for (let t = compStart[c]; t < compStart[c + 1]; t++) {
        const a = sorted[t * 3], b = sorted[t * 3 + 1], cc = sorted[t * 3 + 2];
        const ax = verts[a * 3], ay = verts[a * 3 + 1], az = verts[a * 3 + 2];
        const abx = verts[b * 3] - ax, aby = verts[b * 3 + 1] - ay, abz = verts[b * 3 + 2] - az;
        const acx = verts[cc * 3] - ax, acy = verts[cc * 3 + 1] - ay, acz = verts[cc * 3 + 2] - az;
        const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
        const e1 = edgeOf(a, b), e2 = edgeOf(b, cc), e3 = edgeOf(cc, a);
        const wire = new oc.TopoDS_Wire();
        builder.MakeWire(wire);
        builder.Add(wire, e1); builder.Add(wire, e2); builder.Add(wire, e3);
        wire.Closed_2(true);
        const p = new oc.gp_Pnt_3(ax, ay, az);
        const d = new oc.gp_Dir_4(nx, ny, nz);
        const pln = new oc.gp_Pln_3(p, d);
        const mf = new oc.BRepBuilderAPI_MakeFace_16(pln, wire, false);
        try {
          if (mf.IsDone()) {
            const face = mf.Face();
            builder.Add(shell, face);
            face.delete();
            stats.faces++;
          } else stats.skipped++;
        } finally { mf.delete(); pln.delete(); d.delete(); p.delete(); wire.delete(); }
        if (t % step === 0) {
          progress((index + (t / nTri) * 0.6) / total, `Building faces ${t}/${nTri}…`);
          if (performance.now() - lastYield > 80) {
            await yieldToEventLoop();
            throwIfAborted(opts);
            lastYield = performance.now();
          }
        }
      }
      shells.push({ shell, closed: closedComp[c] === 1, faces: compStart[c + 1] - compStart[c] });
    }
    stats.buildMs = performance.now() - t0 - weldMs;

    for (const { shell, closed, faces } of shells) {
      if (closed && !opts.forceSew) {
        shell.Closed_2(true);
        const ms = new oc.BRepBuilderAPI_MakeSolid_3(shell);
        try {
          if (ms.IsDone()) { shapes.push(ms.Solid()); stats.closed++; stats.solids++; continue; }
        } finally { ms.delete(); }
      }
      if (faces > sewMax && !opts.forceSew) {
        // Too many faces to sew in reasonable time: keep the shell as built
        // (faces already share their welded edges; it is just not closed).
        shapes.push(copyShape(oc, shell));
        stats.unsewn++; stats.shells++;
        continue;
      }
      progress((index + 0.6) / total, `Sewing ${faces} faces…`);
      await yieldToEventLoop();
      throwIfAborted(opts);
      const t1 = performance.now();
      const r = sewAndSolidify(oc, shell, sewTol);
      stats.sewMs += performance.now() - t1;
      stats.sewn++;
      stats.solids += r.solids; stats.shells += r.shells;
      shapes.push(r.shape);
    }
  } catch (e) {
    deleteAll(shapes);
    throw e;
  } finally {
    for (const { shell } of shells) shell.delete();
    for (const rec of edgeMap.values()) { rec.e.delete(); rec.r.delete(); }
    for (const v of vertexObjs) if (v) v.delete();
    builder.delete();
  }
  if (!stats.faces) { deleteAll(shapes); throw new Error(`Mesh "${mesh.name || index + 1}" has no usable triangles (all degenerate).`); }
  if (shapes.length === 1) return { shape: shapes[0], stats };
  const b2 = new oc.BRep_Builder();
  const compound = new oc.TopoDS_Compound();
  b2.MakeCompound(compound);
  for (const s of shapes) b2.Add(compound, s);
  b2.delete(); deleteAll(shapes);
  return { shape: compound, stats };
}

/**
 * Write a shape as STEP / IGES / BREP and return the bytes.
 * opts.surfaceCurves — STEP: also write 2D parameter curves (pcurves). Off
 *   for faceted output (planar faces do not need them; files are ~2x smaller
 *   and write ~7x faster), on for CAD -> CAD conversions.
 * opts.faceted — STEP: stamp the header with the faceted-output marker.
 */
function writeShape(oc, shape, formatId, baseName, opts = {}) {
  const fmt = NAMES[formatId];
  if (!fmt) throw new Error(`Unknown CAD format "${formatId}".`);
  const dir = `/job_${++jobCounter}`;
  const name = `${(baseName || 'model').replace(/[^\w.-]+/g, '_').slice(0, 64) || 'model'}.${formatId === 'iges' ? 'igs' : formatId}`;
  const path = `${dir}/${name}`;
  oc.FS.mkdir(dir);
  try {
    const progress = new oc.Message_ProgressRange_1();
    try {
      if (formatId === 'step') {
        // write.surfacecurve.mode: 1 = also write 2D parameter curves (pcurves),
        // 0 = 3D curves only (readers recompute pcurves).
        oc.Interface_Static.SetIVal('write.surfacecurve.mode', opts.surfaceCurves ? 1 : 0);
        const writer = new oc.STEPControl_Writer_1();
        try {
          const st = occTry(oc, 'Preparing the STEP data',
            () => writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, progress));
          if (!enumIs(st, oc.IFSelect_ReturnStatus.IFSelect_RetDone)) throw new Error('The shape could not be translated to STEP.');
          stampStepHeader(oc, writer, name, !!opts.faceted);
          const wst = occTry(oc, 'Writing the STEP file', () => writer.Write(path));
          if (!enumIs(wst, oc.IFSelect_ReturnStatus.IFSelect_RetDone)) throw new Error('The STEP file could not be written.');
        } finally { writer.delete(); }
      } else if (formatId === 'iges') {
        // BRep mode preserves topology for curved solids. Faces mode (0) can
        // write a syntactically valid IGES whose curved faces do not survive
        // OpenCascade's own reader (for example, a sphere).
        const writer = new oc.IGESControl_Writer_2('MM', 1); // 1 = BRep
        try {
          const ok = occTry(oc, 'Preparing the IGES data', () => writer.AddShape(shape, progress));
          if (!ok) throw new Error('The shape could not be translated to IGES.');
          occTry(oc, 'Preparing the IGES data', () => writer.ComputeModel());
          const wok = occTry(oc, 'Writing the IGES file', () => writer.Write_2(path, false));
          if (!wok) throw new Error('The IGES file could not be written.');
        } finally { writer.delete(); }
      } else {
        const ok = occTry(oc, 'Writing the BREP file', () => oc.BRepTools.Write_3(shape, path, progress));
        if (!ok) throw new Error('The BREP file could not be written.');
      }
    } finally { progress.delete(); }
    return oc.FS.readFile(path);
  } finally {
    try { oc.FS.unlink(path); } catch { /* ignore */ }
    try { oc.FS.rmdir(dir); } catch { /* ignore */ }
  }
}

/** FILE_NAME / FILE_DESCRIPTION of the STEP header (best effort). */
function stampStepHeader(oc, writer, fileName, faceted) {
  let model = null, header = null;
  try {
    model = writer.Model(false);
    if (!model || model.IsNull()) return;
    header = new oc.APIHeaderSection_MakeHeader_2(model);
    if (!header.HasFd()) return;
    header.SetName(hstring(oc, fileName));
    header.SetOriginatingSystem(hstring(oc, MARKER));
    if (faceted) header.SetDescriptionValue(1, hstring(oc, FACETED_DESCRIPTION));
  } catch (e) {
    console.warn('[occ] could not stamp the STEP header:', e);
  } finally {
    if (header) header.delete();
    if (model) model.delete();
  }
}

function baseNameOf(options, fallback) {
  const raw = options && (options.fileName || options.name);
  if (typeof raw !== 'string' || !raw) return fallback;
  return raw.replace(/\.[^.]+$/, '');
}

/**
 * Write a MeshSet as a faceted B-rep STEP / IGES / BREP.
 * Each mesh becomes one shape (solid when watertight, else shell/compound);
 * several meshes are grouped in a compound.
 * options: onProgress, signal, fileName; surfaceCurves (STEP pcurves, default
 * off); sewMaxFaces / forceSew (advanced, mainly for tests).
 */
export async function writeCad(meshSet, outputId, options = {}) {
  const progress = progressFn(options);
  if (!NAMES[outputId]) throw new Error(`Unknown CAD format "${outputId}".`);
  const meshes = ((meshSet && meshSet.meshes) || []).filter((m) => m && m.positions && m.positions.length >= 9);
  if (!meshes.length) throw new Error('The model contains no triangles to convert.');
  throwIfAborted(options);
  const oc = await getOcc(options);
  throwIfAborted(options);
  const shapes = [];
  const stats = [];
  try {
    for (let i = 0; i < meshes.length; i++) {
      const r = await meshToShape(oc, meshes[i], i, progress, meshes.length, options);
      shapes.push(r.shape);
      stats.push(r.stats);
    }
    let shape = shapes[0];
    let compound = null;
    if (shapes.length > 1) {
      const builder = new oc.BRep_Builder();
      compound = new oc.TopoDS_Compound();
      builder.MakeCompound(compound);
      for (const s of shapes) builder.Add(compound, s);
      builder.delete();
      shape = compound;
    }
    try {
      progress(null, `Writing ${NAMES[outputId]}…`);
      await yieldToEventLoop();
      throwIfAborted(options);
      const t0 = performance.now();
      const bytes = writeShape(oc, shape, outputId, baseNameOf(options, 'model'),
        { surfaceCurves: !!options.surfaceCurves, faceted: true });
      const writeMs = performance.now() - t0;
      progress(1, 'Done');
      const blob = new Blob([bytes], { type: MIME[outputId] });
      return { blob, stats: { meshes: stats, writeMs, bytes: bytes.length } };
    } finally { if (compound) compound.delete(); }
  } finally { deleteAll(shapes); }
}

/** CAD -> CAD without tessellation: the B-rep is passed through as-is. */
export async function convertCad(file, inputId, outputId, options = {}) {
  const progress = progressFn(options);
  if (!NAMES[inputId]) throw new Error(`Unknown CAD format "${inputId}".`);
  if (!NAMES[outputId]) throw new Error(`Unknown CAD format "${outputId}".`);
  throwIfAborted(options);
  const oc = await getOcc(options);
  throwIfAborted(options);
  progress(null, `Reading ${NAMES[inputId]} file…`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(options);
  const { shape, faceted } = readShape(oc, bytes, inputId, file && file.name);
  try {
    throwIfAborted(options);
    progress(null, `Writing ${NAMES[outputId]}…`);
    await yieldToEventLoop();
    throwIfAborted(options);
    // Faceted input stays faceted (marker kept); real CAD keeps its pcurves.
    const surfaceCurves = options.surfaceCurves === undefined ? !faceted : !!options.surfaceCurves;
    const out = writeShape(oc, shape, outputId, baseNameOf(options, (file && file.name) || 'model'),
      { surfaceCurves, faceted });
    progress(1, 'Done');
    return { blob: new Blob([out], { type: MIME[outputId] }) };
  } finally { shape.delete(); }
}

// ---------------------------------------------------------------------------
// Detection helper (optional for the host)
// ---------------------------------------------------------------------------

/** Sniff the first bytes (and the extension) of a file: 'step' | 'iges' | 'brep' | null. */
export function detectCad(file, head) {
  let text = '';
  if (head && head.length) {
    for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]);
  }
  const t = text.replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
  if (t.startsWith('ISO-10303-21')) return 'step';
  if (t.startsWith('DBRep_DrawableShape') || t.startsWith('CASCADE Topology V')) return 'brep';
  const ext = ((file && file.name) || '').split('.').pop().toLowerCase();
  if (ext === 'step' || ext === 'stp') return 'step';
  if (ext === 'iges' || ext === 'igs') return 'iges';
  if (ext === 'brep') return 'brep';
  return null;
}

// Private: used by file/_dev/cad.html to build sample files with the same code paths.
export const _internals = {
  readShape, writeShape, tessellate, extractMeshes, bboxOfShape, meshToShape, weldMesh, orientMesh,
  MARKER, FACETED_DESCRIPTION, FAST_RSC_NAME, RSC_DIR,
};
