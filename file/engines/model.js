/**
 * file/engines/model.js — the "3D Model" engine (meshes + CAD).
 *
 * Composes model-mesh.js (Three.js mesh formats, always available) with
 * model-cad.js (OpenCascade STEP/IGES/BREP, optional).  The CAD module is
 * imported dynamically inside a try/catch — if it is missing or fails to load
 * the engine simply works mesh-only.  Routing:
 *   mesh -> mesh : readMesh  -> writeMesh
 *   mesh -> cad  : readMesh  -> cad.writeCad
 *   cad  -> mesh : cad.readCad -> writeMesh
 *   cad  -> cad  : cad.convertCad (exact B-rep, no tessellation)
 * `scale` and `merge` are applied to the MeshSet in between (so they do not
 * affect cad -> cad, which never tessellates).
 */

import {
  meshFormats, detectMesh, readMesh, writeMesh, warmupMesh,
  scaleMeshSet, mergeMeshSet,
} from './model-mesh.js';

export const domain = { id: 'model', name: '3D Model' };

// Fallback descriptors so CAD inputs are still recognised (and refused with a
// clear message) when the CAD module is unavailable.
const CAD_IDS = ['step', 'iges', 'brep'];
const CAD_EXT = { step: ['step', 'stp'], iges: ['iges', 'igs'], brep: ['brep'] };

let cad = null;          // the loaded CAD module (or null)
let cadLoadError = null; // why it is not available
let cadPromise = null;

/** The CAD module's note (the OpenCascade download). Only relevant when needsCad() is true. */
export let loadNote = '';

function loadCad() {
  if (cad) return Promise.resolve(cad);
  if (!cadPromise) {
    cadPromise = import('./model-cad.js').then((mod) => {
      if (!mod || !Array.isArray(mod.cadFormats)) throw new Error('model-cad.js does not export cadFormats');
      _setCadModule(mod);
      return mod;
    }).catch((err) => {
      cadLoadError = err;
      cadPromise = null; // allow a retry later (e.g. transient network failure)
      console.warn('[model] CAD support unavailable:', err && err.message ? err.message : err);
      return null;
    });
  }
  return cadPromise;
}

export const formats = meshFormats.map((f) => ({ ...f, group: f.group || 'Mesh' }));

function rebuildFormats() {
  formats.length = 0;
  for (const f of meshFormats) formats.push({ ...f, group: f.group || 'Mesh' });
  if (cad) for (const f of cad.cadFormats) formats.push({ ...f, group: f.group || 'CAD' });
}

/** Test hook / injection point: use `mod` (with the model-cad.js interface) as the CAD module. */
export function _setCadModule(mod) {
  cad = mod || null;
  cadLoadError = cad ? null : new Error('CAD module disabled');
  cadPromise = Promise.resolve(cad);
  rebuildFormats();
  loadNote = cad && cad.loadNote ? cad.loadNote : '';
}

// Try the real CAD module now; the page's static import of this engine waits
// for this one small module fetch (never for OpenCascade itself).
await loadCad();

export const options = [
  { id: 'scale', label: 'Scale', type: 'number', default: 1, min: 0.000001, step: 0.001, help: 'Multiply all coordinates' },
  { id: 'merge', label: 'Merge bodies', type: 'toggle', default: false, help: 'Combine all bodies into one' },
  { id: 'deflection', label: 'Mesh fineness', type: 'range', default: 0.1, min: 0.01, max: 1, step: 0.01, unit: 'mm',
    help: 'Mesh fineness when the input is a STEP/IGES/BREP file' },
];

const isCadId = (id) => !!id && (cad ? cad.cadFormats.some((f) => f.id === id) : CAD_IDS.includes(id));
const isMeshId = (id) => meshFormats.some((f) => f.id === id);

/** True when the conversion involves a CAD format (so the UI should show loadNote). */
export function needsCad(inputId, outputId) {
  return isCadId(inputId) || isCadId(outputId);
}

/** Whether CAD support loaded (for diagnostics). */
export function cadAvailable() {
  return !!cad;
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function latin1(head) {
  let s = '';
  for (let i = 0; i < head.length; i++) s += String.fromCharCode(head[i]);
  return s;
}

export function detect(file, head) {
  const mesh = detectMesh(file, head);
  if (mesh) return mesh;
  const cadDetect = cad && (cad.detectCad || cad.detect);
  if (typeof cadDetect === 'function') {
    const id = cadDetect(file, head);
    if (id) return id;
  }
  const ext = extOf(file && file.name);
  const s = head ? latin1(head) : '';
  const cadFormats = cad ? cad.cadFormats : CAD_IDS.map((id) => ({ id, ext: CAD_EXT[id], read: true }));
  const byExt = cadFormats.find((f) => f.read && f.ext.includes(ext));
  if (byExt) return byExt.id;
  if (/^ISO-10303-21/.test(s)) return 'step';
  if (/^DBRep_DrawableShape/.test(s)) return 'brep';
  return null;
}

export function targets(inputId) {
  return formats.filter((f) => f.write && f.id !== inputId).map((f) => f.id);
}

/**
 * Prefetch Three.js (always) and OpenCascade when the pair involves CAD.
 * The UI cannot always know the input when it calls this, so inputId is optional.
 */
export async function warmup(outputId, inputId) {
  const jobs = [warmupMesh(isMeshId(outputId) ? outputId : undefined, isMeshId(inputId) ? inputId : undefined)];
  if (needsCad(inputId, outputId)) {
    jobs.push(loadCad().then((mod) => (mod && typeof mod.warmup === 'function' ? mod.warmup() : undefined)));
  }
  await Promise.allSettled(jobs);
}

async function requireCad(what) {
  const mod = await loadCad();
  if (!mod) {
    const why = cadLoadError && cadLoadError.message ? ` (${cadLoadError.message})` : '';
    throw new Error(`${what} needs the CAD module, which could not be loaded${why}. Mesh formats still work.`);
  }
  return mod;
}

function applyMeshOptions(meshSet, opts) {
  const scale = opts.scale === undefined || opts.scale === null || opts.scale === '' ? 1 : +opts.scale;
  if (!(scale > 0)) throw new Error('Scale must be a positive number.');
  if (scale !== 1) meshSet = scaleMeshSet(meshSet, scale);
  if (opts.merge) meshSet = mergeMeshSet(meshSet);
  return meshSet;
}

const nameOf = (id) => (formats.find((f) => f.id === id) || { name: id }).name;

export async function convert({ file, inputId, outputId, options: opts = {}, onProgress, signal }) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const inCad = isCadId(inputId);
  const outCad = isCadId(outputId);
  if (!inCad && !isMeshId(inputId)) throw new Error(`Unknown input format "${inputId}".`);
  if (!outCad && !isMeshId(outputId)) throw new Error(`Unknown output format "${outputId}".`);
  const checkAbort = () => { if (signal && signal.aborted) throw new Error('Conversion cancelled.'); };
  const cadOpts = { ...opts, deflection: opts.deflection === undefined ? 0.1 : +opts.deflection, onProgress: progress, signal };

  if (inCad && outCad) {
    const mod = await requireCad(`Converting ${nameOf(inputId)} to ${nameOf(outputId)}`);
    progress(null, `Converting ${nameOf(inputId)} to ${nameOf(outputId)}`);
    const out = await mod.convertCad(file, inputId, outputId, cadOpts);
    progress(1);
    return out;
  }

  let meshSet;
  if (inCad) {
    const mod = await requireCad(`Reading ${nameOf(inputId)}`);
    progress(null, `Reading ${file.name || nameOf(inputId)} (tessellating at ${cadOpts.deflection} mm)`);
    meshSet = await mod.readCad(file, inputId, cadOpts);
  } else {
    progress(null, 'Loading Three.js');
    await warmupMesh(outCad ? undefined : outputId, inputId);
    checkAbort();
    progress(0.15, `Reading ${file.name || nameOf(inputId)}`);
    meshSet = await readMesh(file, inputId);
  }
  checkAbort();
  meshSet = applyMeshOptions(meshSet, opts);

  progress(0.6, `Writing ${nameOf(outputId)}`);
  let out;
  if (outCad) {
    const mod = await requireCad(`Writing ${nameOf(outputId)}`);
    out = await mod.writeCad(meshSet, outputId, cadOpts);
  } else {
    out = await writeMesh(meshSet, outputId, opts);
  }
  progress(1);
  return out;
}
