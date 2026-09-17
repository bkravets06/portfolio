/**
 * file/engines/model-mesh.js — the mesh half of the "3D Model" engine.
 *
 * Reads and writes triangle-mesh formats with Three.js 0.186.0, loaded lazily
 * through the page's import map (`three`, `three/addons/…`).  Geometry is
 * exchanged as a MeshSet (see file/_dev/CONTRACT.md, bottom section).
 * Nothing heavy runs at module top level and nothing here touches the DOM.
 *
 * Exports used by model.js:
 *   meshFormats, detectMesh, readMesh, writeMesh, warmupMesh,
 *   scaleMeshSet, mergeMeshSet, meshSetStats
 * plus a thin standalone engine API (domain/formats/options/detect/targets/
 * warmup/convert) so this module also works on its own for testing.
 */

const THREE_VERSION = '0.186.0';
const CDN = 'https://cdn.jsdelivr.net/npm/';
const FFLATE_URL = `${CDN}fflate@0.8.3/esm/browser.js`;
const DRACO_DECODER_PATH = `${CDN}three@${THREE_VERSION}/examples/jsm/libs/draco/gltf/`;

// 1x1 transparent PNG: every external texture/sidecar URL a loader asks for is
// redirected here, so nothing is fetched from the network and nothing 404s.
const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const binaryToggle = (help) => ({ id: 'binary', label: 'Binary', type: 'toggle', default: true, help });

export const meshFormats = [
  { id: 'stl', name: 'STL', ext: ['stl'], mime: 'model/stl', read: true, write: true, group: 'Mesh',
    note: 'Triangles only; no names, colours or units',
    options: [binaryToggle('Binary STL is about 5x smaller than ASCII')] },
  { id: 'obj', name: 'OBJ', ext: ['obj'], mime: 'model/obj', read: true, write: true, group: 'Mesh',
    note: 'Wavefront text; materials (.mtl) are not carried over' },
  { id: 'ply', name: 'PLY', ext: ['ply'], mime: 'application/x-ply', read: true, write: true, group: 'Mesh',
    note: 'Stanford polygon file; keeps vertex colours',
    options: [binaryToggle('Binary (little-endian) PLY; off for ASCII')] },
  { id: 'glb', name: 'GLB', ext: ['glb'], mime: 'model/gltf-binary', read: true, write: true, group: 'Mesh',
    note: 'Binary glTF 2.0 in a single file' },
  { id: 'gltf', name: 'glTF', ext: ['gltf'], mime: 'model/gltf+json', read: true, write: true, group: 'Mesh',
    note: 'glTF 2.0 JSON; written with embedded data as a single file' },
  { id: '3mf', name: '3MF', ext: ['3mf'], mime: 'model/3mf', read: true, write: true, group: 'Mesh',
    note: '3D Manufacturing Format; written in millimetres' },
  { id: 'usdz', name: 'USDZ', ext: ['usdz'], mime: 'model/vnd.usdz+zip', read: true, write: true, group: 'Mesh',
    note: 'Universal Scene Description package (Apple AR Quick Look)' },
  { id: 'amf', name: 'AMF', ext: ['amf'], mime: 'application/x-amf', read: true, write: false, group: 'Mesh',
    note: 'Additive Manufacturing Format (read only)' },
  { id: 'dae', name: 'Collada', ext: ['dae'], mime: 'model/vnd.collada+xml', read: true, write: false, group: 'Mesh',
    note: 'Collada DAE (read only)' },
  { id: 'fbx', name: 'FBX', ext: ['fbx'], mime: 'application/octet-stream', read: true, write: false, group: 'Mesh',
    note: 'Autodesk FBX 7.0+ / 2011 or newer (read only)' },
  { id: 'wrl', name: 'VRML', ext: ['wrl', 'vrml'], mime: 'model/vrml', read: true, write: false, group: 'Mesh',
    note: 'VRML 2.0 / VRML97 (read only)' },
  { id: 'usd', name: 'USD', ext: ['usda', 'usdc', 'usd'], mime: 'model/vnd.usd', read: true, write: false, group: 'Mesh',
    note: 'Single USD layer, ASCII or crate (read only)' },
];

const byId = (id) => meshFormats.find((f) => f.id === id);

// ---------------------------------------------------------------------------
// Lazy, cached module loading (all through the import map / jsDelivr)
// ---------------------------------------------------------------------------

const moduleCache = new Map();
function load(spec) {
  let p = moduleCache.get(spec);
  if (!p) {
    p = import(spec).catch((err) => {
      moduleCache.delete(spec);
      const name = spec.split('/').pop();
      throw readable(`Could not download ${name} from the CDN (${err && err.message ? err.message : err}). Check your connection and try again.`);
    });
    moduleCache.set(spec, p);
  }
  return p;
}
const three = () => load('three');
const addon = (path) => load('three/addons/' + path);

const READER_MODULES = {
  stl: ['loaders/STLLoader.js'], obj: ['loaders/OBJLoader.js'], ply: ['loaders/PLYLoader.js'],
  glb: ['loaders/GLTFLoader.js'], gltf: ['loaders/GLTFLoader.js'],
  '3mf': ['loaders/3MFLoader.js', 'libs/fflate.module.js'], amf: ['loaders/AMFLoader.js'],
  dae: ['loaders/ColladaLoader.js'], fbx: ['loaders/FBXLoader.js'], wrl: ['loaders/VRMLLoader.js'],
  usdz: ['loaders/USDLoader.js'], usd: ['loaders/USDLoader.js'],
};
const WRITER_MODULES = {
  stl: ['exporters/STLExporter.js'], obj: ['exporters/OBJExporter.js'], ply: ['exporters/PLYExporter.js'],
  glb: ['exporters/GLTFExporter.js'], gltf: ['exporters/GLTFExporter.js'],
  '3mf': [FFLATE_URL], usdz: ['exporters/USDZExporter.js'],
};

/** Prefetch Three and the modules needed for outputId (and inputId when known). Idempotent. */
export function warmupMesh(outputId, inputId) {
  const wanted = [three()];
  for (const spec of (WRITER_MODULES[outputId] || []).concat(READER_MODULES[inputId] || [])) {
    wanted.push(spec.startsWith('http') ? load(spec) : addon(spec));
  }
  return Promise.allSettled(wanted).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function readable(message) {
  const e = new Error(message);
  e.isReadable = true;
  return e;
}

function readError(err, file, fmt) {
  if (err && err.isReadable) return err;
  let msg = String((err && err.message) || err || 'unknown error').replace(/^THREE\.\w+:\s*/, '').trim();
  if (err instanceof RangeError || /out of bounds|outside the bounds|Invalid typed array|Invalid array length|Array buffer allocation/i.test(msg)) {
    msg = 'the file appears to be truncated or corrupt';
  } else if (fmt.id === 'fbx' && /version not supported/i.test(msg)) {
    msg = 'this FBX is too old; FBX 2011 (version 7.0) or newer is required, please re-export it';
  } else if (fmt.id === 'fbx' && /Unknown format|Cannot find the version/i.test(msg)) {
    msg = 'it is not a valid FBX file';
  } else if (fmt.id === 'wrl' && /VRML/i.test(msg)) {
    msg = 'only VRML 2.0 (VRML97, "#VRML V2.0 utf8") files are supported';
  } else if (/invalid zip|unexpected end|end of central directory|zip/i.test(msg) && ['3mf', 'usdz', 'amf'].includes(fmt.id)) {
    msg = 'it is not a valid (zip-based) ' + fmt.name + ' file';
  } else if (/Maximum call stack|allocation failed|out of memory/i.test(msg)) {
    msg = 'it is too large to process in the browser';
  }
  msg = msg.replace(/[.\s]+$/, '');
  if (msg.length > 160) msg = msg.slice(0, 157) + '...';
  return readable(`Could not read ${file.name || 'the file'} as ${fmt.name}: ${msg}.`);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function latin1(head) {
  let s = '';
  for (let i = 0; i < head.length; i++) s += String.fromCharCode(head[i]);
  return s;
}

/** Format id (read:true) for a File given its first 64 bytes, or null. */
export function detectMesh(file, head) {
  const ext = extOf(file && file.name);
  const byExt = meshFormats.find((f) => f.read && f.ext.includes(ext));
  const s = head ? latin1(head) : '';
  if (s.startsWith('glTF')) return 'glb';
  if (/^ply[\r\n]/.test(s)) return 'ply';
  if (s.startsWith('#VRML V2.0')) return 'wrl';
  if (s.startsWith('Kaydara FBX Binary')) return 'fbx';
  if (s.startsWith('PXR-USDC') || s.startsWith('#usda 1.0')) return 'usd';
  if (s.startsWith('PK\x03\x04')) {
    if (byExt && ['3mf', 'usdz', 'amf'].includes(byExt.id)) return byExt.id;
    // Peek at the first zip entry name (offset 30, length at 26..27).
    const len = head.length >= 30 ? head[26] | (head[27] << 8) : 0;
    const entry = s.slice(30, 30 + Math.min(len, 34));
    if (/\.usd[ac]?$/i.test(entry)) return 'usdz';
    if (/\.amf$/i.test(entry)) return 'amf';
    if (/^(\[Content_Types\]\.xml|_rels\/|3D\/)/.test(entry)) return '3mf';
    return byExt ? byExt.id : null;
  }
  if (byExt) return byExt.id;
  // Extension-less fallbacks on content.
  if (/^\s*solid\b/.test(s)) return 'stl';
  if (/^; FBX \d/.test(s)) return 'fbx';
  if (/<amf[\s>]/i.test(s)) return 'amf';
  if (/<COLLADA/i.test(s)) return 'dae';
  if (/^\s*\{\s*"asset"/.test(s)) return 'gltf';
  if (/^(#[^\n]*\n)*\s*(v|vn|vt|o|g|mtllib)\s/.test(s)) return 'obj';
  return null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const textDecoder = new TextDecoder();
const decodeText = (buf) => textDecoder.decode(buf);

function offlineManager(THREE) {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => (/^(data|blob):/i.test(url) ? url : BLANK_PNG));
  return manager;
}

function readGlbJson(buf) {
  const view = new DataView(buf);
  if (buf.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw readable('This is not a valid GLB file (bad header).');
  const total = Math.min(view.getUint32(8, true), buf.byteLength);
  let offset = 12; let json = null; let bin = null;
  while (offset + 8 <= total) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > buf.byteLength) throw readable('This GLB file appears to be truncated.');
    if (type === 0x4e4f534a) json = JSON.parse(decodeText(new Uint8Array(buf, start, length)));
    else if (type === 0x004e4942) bin = new Uint8Array(buf, start, length);
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw readable('This GLB file has no JSON chunk.');
  return { json, bin };
}

function packGlb(json, bin) {
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binLen = bin ? bin.length : 0;
  const binPad = (4 - (binLen % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + (bin ? 8 + binLen + binPad : 0);
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const u8 = new Uint8Array(out);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length + jsonPad, true); view.setUint32(16, 0x4e4f534a, true);
  u8.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) u8[20 + jsonBytes.length + i] = 0x20;
  if (bin) {
    const o = 20 + jsonBytes.length + jsonPad;
    view.setUint32(o, binLen + binPad, true); view.setUint32(o + 4, 0x004e4942, true);
    u8.set(bin, o + 8);
  }
  return out;
}

async function readGltf(buf, THREE) {
  const { GLTFLoader } = await addon('loaders/GLTFLoader.js');
  const isGlb = new DataView(buf).getUint32(0, true) === 0x46546c67;
  let json; let bin = null;
  if (isGlb) {
    ({ json, bin } = readGlbJson(buf));
  } else {
    try { json = JSON.parse(decodeText(buf)); } catch (e) { throw readable('This is not a valid glTF file (the JSON could not be parsed).'); }
  }
  if (!json || typeof json !== 'object' || !json.asset) throw readable('This is not a glTF file (no "asset" block).');
  const external = (json.buffers || []).filter((b) => b && b.uri && !/^data:/i.test(b.uri)).map((b) => b.uri);
  if (external.length) {
    throw readable(`This glTF references external data files (${external.slice(0, 3).join(', ')}) that are not available here. Convert the .glb instead, or export a glTF with embedded buffers.`);
  }
  // Only geometry is kept, so strip every texture reference: no image decoding,
  // no KTX2/WebP/AVIF requirements, no crash on textures without a fallback.
  const patched = stripTextures(json);
  const loader = new GLTFLoader(offlineManager(THREE));
  const used = json.extensionsUsed || [];
  let draco = null;
  if (used.includes('KHR_draco_mesh_compression')) {
    const { DRACOLoader } = await addon('loaders/DRACOLoader.js');
    draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_DECODER_PATH);
    loader.setDRACOLoader(draco);
  }
  if (used.includes('EXT_meshopt_compression')) {
    const { MeshoptDecoder } = await addon('libs/meshopt_decoder.module.js');
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  const data = isGlb ? (patched ? packGlb(json, bin) : buf) : JSON.stringify(json);
  try {
    const gltf = await loader.parseAsync(data, '');
    return gltf.scene || (gltf.scenes && gltf.scenes[0]) || new THREE.Group();
  } finally {
    if (draco) draco.dispose();
  }
}

function requireZip(buf, name) {
  const h = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (h[0] !== 0x50 || h[1] !== 0x4b) throw readable(`This is not a ${name} file (${name} files are zip archives).`);
}

const TEXTURE_EXTENSIONS = ['KHR_texture_basisu', 'KHR_texture_transform', 'EXT_texture_webp', 'EXT_texture_avif'];
const TEXTURE_SLOTS = ['normalTexture', 'occlusionTexture', 'emissiveTexture'];
const PBR_TEXTURE_SLOTS = ['baseColorTexture', 'metallicRoughnessTexture'];

// Remove textures/images/samplers and every material texture slot. Returns true if anything changed.
function stripTextures(json) {
  let changed = false;
  for (const key of ['textures', 'images', 'samplers']) {
    if (json[key] !== undefined) { delete json[key]; changed = true; }
  }
  for (const key of ['extensionsRequired', 'extensionsUsed']) {
    if (Array.isArray(json[key])) {
      const kept = json[key].filter((e) => !TEXTURE_EXTENSIONS.includes(e));
      if (kept.length !== json[key].length) { json[key] = kept; changed = true; }
    }
  }
  for (const material of json.materials || []) {
    if (!material || typeof material !== 'object') continue;
    for (const slot of TEXTURE_SLOTS) if (material[slot] !== undefined) { delete material[slot]; changed = true; }
    const pbr = material.pbrMetallicRoughness;
    if (pbr) for (const slot of PBR_TEXTURE_SLOTS) if (pbr[slot] !== undefined) { delete pbr[slot]; changed = true; }
    if (material.extensions !== undefined) { delete material.extensions; changed = true; }
  }
  return changed;
}

const UNIT_TO_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

async function threeMfUnit(buf) {
  try {
    const { unzipSync } = await addon('libs/fflate.module.js');
    const files = unzipSync(new Uint8Array(buf), { filter: (f) => /^3D\/.*\.model$/i.test(f.name) });
    const name = Object.keys(files)[0];
    if (!name) return 'millimeter';
    const m = /<model\b[^>]*\bunit="([a-z]+)"/i.exec(decodeText(files[name].subarray(0, 4096)));
    return m ? m[1].toLowerCase() : 'millimeter';
  } catch (e) {
    return 'millimeter';
  }
}

// Some loaders convert declared units to metres and rotate Z-up files to Y-up
// by transforming the ROOT object.  The contract wants coordinates exactly as
// the file stores them, so undo that; `metersPerUnit` (when known) only tells
// us whether the file is in millimetres.
function rawRoot(root, ctx, metersPerUnit) {
  if (!root || !root.isObject3D) return root;
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.scale.set(1, 1, 1);
  root.updateMatrix();
  if (Number.isFinite(metersPerUnit) && Math.abs(metersPerUnit - 0.001) < 1e-9) ctx.units = 'mm';
  return root;
}

// Each reader returns an Object3D (scene graph) or a BufferGeometry, and may
// set ctx.unitScale (multiplier to millimetres) / ctx.units.
const readers = {
  async stl(buf) {
    const { STLLoader } = await addon('loaders/STLLoader.js');
    return new STLLoader().parse(buf);
  },
  async obj(buf) {
    const { OBJLoader } = await addon('loaders/OBJLoader.js');
    return new OBJLoader().parse(decodeText(buf));
  },
  async ply(buf) {
    const { PLYLoader } = await addon('loaders/PLYLoader.js');
    const header = decodeText(new Uint8Array(buf, 0, Math.min(buf.byteLength, 2048)));
    if (!/^ply[\r\n]/.test(header)) throw readable('This is not a PLY file (missing "ply" header).');
    const geometry = new PLYLoader().parse(buf);
    if (!geometry.index) throw readable('This PLY file has no triangle faces (it may be a point cloud), so there is nothing to convert.');
    return geometry;
  },
  async glb(buf, THREE) { return readGltf(buf, THREE); },
  async gltf(buf, THREE) { return readGltf(buf, THREE); },
  async '3mf'(buf, THREE, ctx) {
    requireZip(buf, '3MF');
    const { ThreeMFLoader } = await addon('loaders/3MFLoader.js');
    const unit = await threeMfUnit(buf);
    ctx.unitScale = UNIT_TO_MM[unit] || 1;
    ctx.units = 'mm';
    return new ThreeMFLoader(offlineManager(THREE)).parse(buf);
  },
  async amf(buf, THREE, ctx) {
    const { AMFLoader } = await addon('loaders/AMFLoader.js');
    const start = latin1(new Uint8Array(buf, 0, Math.min(64, buf.byteLength)));
    if (!start.startsWith('PK') && !/^\s*</.test(start)) throw readable('This is not an AMF file (expected XML or a zip archive).');
    const group = new AMFLoader(offlineManager(THREE)).parse(buf);
    if (!group) throw readable('This is not an AMF document.');
    ctx.units = 'mm'; // AMFLoader converts the document unit to millimetres itself
    return group;
  },
  async dae(buf, THREE, ctx) {
    const { ColladaLoader } = await addon('loaders/ColladaLoader.js');
    const text = decodeText(buf);
    if (!/<COLLADA[\s>]/i.test(text.slice(0, 4096))) throw readable('This is not a Collada (.dae) document.');
    const result = new ColladaLoader(offlineManager(THREE)).parse(text, '');
    if (!result || !result.scene) throw readable('This Collada document could not be parsed.');
    // ColladaLoader scales the root by <unit meter> and rotates Z_UP assets to Y-up; keep the file's raw coordinates.
    return rawRoot(result.scene, ctx, result.scene.scale.x);
  },
  async fbx(buf, THREE, ctx) {
    const { FBXLoader } = await addon('loaders/FBXLoader.js');
    const group = new FBXLoader(offlineManager(THREE)).parse(buf, '');
    // FBXLoader rotates Z-up files to Y-up at the root; FBX UnitScaleFactor is in cm (0.1 = mm).
    const usf = group && group.userData ? +group.userData.unitScaleFactor : NaN;
    return rawRoot(group, ctx, Number.isFinite(usf) ? usf * 0.01 : NaN);
  },
  async wrl(buf, THREE) {
    const { VRMLLoader } = await addon('loaders/VRMLLoader.js');
    return new VRMLLoader(offlineManager(THREE)).parse(decodeText(buf), '');
  },
  async usdz(buf, THREE, ctx) {
    requireZip(buf, 'USDZ');
    const { USDLoader } = await addon('loaders/USDLoader.js');
    const group = new USDLoader(offlineManager(THREE)).parse(buf, '');
    // USDLoader scales the root by metersPerUnit and rotates Z-up stages to Y-up; keep raw coordinates.
    return rawRoot(group, ctx, group ? group.scale.x : NaN);
  },
  async usd(buf, THREE, ctx) {
    const { USDLoader } = await addon('loaders/USDLoader.js');
    const isCrate = latin1(new Uint8Array(buf, 0, Math.min(8, buf.byteLength))) === 'PXR-USDC';
    const group = new USDLoader(offlineManager(THREE)).parse(isCrate ? buf : decodeText(buf), '');
    return rawRoot(group, ctx, group ? group.scale.x : NaN);
  },
};

/** Read a File of format inputId into a MeshSet. */
export async function readMesh(file, inputId) {
  const fmt = byId(inputId);
  if (!fmt || !fmt.read) throw readable(`Reading ${inputId || 'this'} files is not supported.`);
  const buf = await file.arrayBuffer();
  if (buf.byteLength === 0) throw readable(`${file.name || 'The file'} is empty.`);
  const THREE = await three();
  const ctx = { unitScale: 1, units: 'unknown' };
  let root;
  try {
    root = await readers[inputId](buf, THREE, ctx);
  } catch (err) {
    throw readError(err, file, fmt);
  }
  if (!root) throw readError(new Error('nothing could be parsed'), file, fmt);
  const baseName = (file.name || fmt.name).replace(/\.[^.]+$/, '') || fmt.name;
  const meshes = flatten(root, THREE, baseName, ctx.unitScale);
  if (meshes.length === 0) {
    throw readable(`No triangle meshes were found in ${file.name || 'the file'} (it may contain only points, lines, curves or an empty scene).`);
  }
  return { units: ctx.units, meshes, source: { format: inputId, name: file.name || '' } };
}

// ---------------------------------------------------------------------------
// Scene graph -> MeshSet (world transforms applied)
// ---------------------------------------------------------------------------

function nameFor(obj, fallback) {
  for (let o = obj; o; o = o.parent) {
    if (o.name && o.name.trim()) return o.name.trim();
  }
  return fallback;
}

function flatten(root, THREE, baseName, unitScale) {
  const out = [];
  const push = (geometry, matrix, name) => {
    const mesh = geometryToMesh(geometry, matrix, name, THREE, unitScale);
    if (mesh) out.push(mesh);
  };
  if (root.isBufferGeometry) {
    push(root, null, baseName);
    return out;
  }
  root.updateMatrixWorld(true);
  const tmp = new THREE.Matrix4();
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return; // Mesh, SkinnedMesh, InstancedMesh; skips Points/Line
    const fallback = out.length ? `${baseName} ${out.length + 1}` : baseName;
    const name = nameFor(obj, fallback);
    if (obj.isInstancedMesh) {
      for (let i = 0; i < obj.count; i++) {
        obj.getMatrixAt(i, tmp);
        push(obj.geometry, new THREE.Matrix4().multiplyMatrices(obj.matrixWorld, tmp), `${name} ${i + 1}`);
      }
    } else {
      push(obj.geometry, obj.matrixWorld, name);
    }
  });
  return out;
}

function geometryToMesh(geometry, matrix, name, THREE, unitScale) {
  const pos = geometry.getAttribute('position');
  if (!pos || pos.count < 3) return null;
  const identity = !matrix || isIdentity(matrix.elements);
  const scale = unitScale || 1;
  const count = pos.count;

  const positions = new Float32Array(count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(pos, i);
    if (!identity) v.applyMatrix4(matrix);
    positions[i * 3] = v.x * scale; positions[i * 3 + 1] = v.y * scale; positions[i * 3 + 2] = v.z * scale;
  }

  let normals;
  const nrm = geometry.getAttribute('normal');
  if (nrm && nrm.count === count) {
    normals = new Float32Array(count * 3);
    const nm = identity ? null : new THREE.Matrix3().getNormalMatrix(matrix);
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(nrm, i);
      if (nm) v.applyMatrix3(nm);
      v.normalize();
      normals[i * 3] = v.x; normals[i * 3 + 1] = v.y; normals[i * 3 + 2] = v.z;
    }
  }

  let colors;
  const col = geometry.getAttribute('color');
  if (col && col.count === count) {
    colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = col.getX(i); colors[i * 3 + 1] = col.getY(i); colors[i * 3 + 2] = col.getZ(i);
    }
  }

  let indices;
  if (geometry.index) {
    const src = geometry.index.array;
    const n = src.length - (src.length % 3);
    if (n === 0) return null;
    indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) indices[i] = src[i];
  } else if (count % 3 !== 0) {
    // Non-indexed soup with a dangling vertex or two: drop the remainder.
    const n = count - (count % 3);
    if (n === 0) return null;
    return trim({ name, positions, normals, colors }, n, matrix);
  }

  const mesh = { name, positions };
  if (normals) mesh.normals = normals;
  if (colors) mesh.colors = colors;
  if (indices) mesh.indices = indices;
  if (matrix && matrix.determinant() < 0) flipWinding(mesh);
  return mesh;
}

function trim(mesh, n, matrix) {
  mesh.positions = mesh.positions.slice(0, n * 3);
  if (mesh.normals) mesh.normals = mesh.normals.slice(0, n * 3);
  if (mesh.colors) mesh.colors = mesh.colors.slice(0, n * 3);
  if (matrix && matrix.determinant() < 0) flipWinding(mesh);
  return mesh;
}

function isIdentity(e) {
  return e[0] === 1 && e[5] === 1 && e[10] === 1 && e[15] === 1 &&
    e[1] === 0 && e[2] === 0 && e[3] === 0 && e[4] === 0 && e[6] === 0 && e[7] === 0 &&
    e[8] === 0 && e[9] === 0 && e[11] === 0 && e[12] === 0 && e[13] === 0 && e[14] === 0;
}

// A mirroring transform reverses triangle orientation; swap the 2nd/3rd corner back.
function flipWinding(mesh) {
  if (mesh.indices) {
    const idx = mesh.indices;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  } else {
    for (const arr of [mesh.positions, mesh.normals, mesh.colors]) {
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += 9) {
        for (let k = 0; k < 3; k++) { const t = arr[i + 3 + k]; arr[i + 3 + k] = arr[i + 6 + k]; arr[i + 6 + k] = t; }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// MeshSet utilities (shared with model.js)
// ---------------------------------------------------------------------------

/** Multiply every coordinate by `scale` (normals untouched). Returns a new MeshSet. */
export function scaleMeshSet(meshSet, scale) {
  if (!(scale > 0) || scale === 1) return meshSet;
  return { ...meshSet, meshes: meshSet.meshes.map((m) => ({ ...m, positions: m.positions.map((x) => x * scale) })) };
}

/** Combine all bodies into one mesh (indices offset; normals/colours kept only if every body has them). */
export function mergeMeshSet(meshSet, name) {
  const meshes = meshSet.meshes;
  if (meshes.length <= 1) return meshSet;
  let vertexCount = 0; let indexCount = 0;
  let hasNormals = true; let hasColors = true;
  for (const m of meshes) {
    const n = m.positions.length / 3;
    vertexCount += n;
    indexCount += m.indices ? m.indices.length : n;
    hasNormals = hasNormals && !!m.normals;
    hasColors = hasColors && !!m.colors;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = hasNormals ? new Float32Array(vertexCount * 3) : undefined;
  const colors = hasColors ? new Float32Array(vertexCount * 3) : undefined;
  const indices = new Uint32Array(indexCount);
  let vo = 0; let io = 0;
  for (const m of meshes) {
    const n = m.positions.length / 3;
    positions.set(m.positions, vo * 3);
    if (normals) normals.set(m.normals, vo * 3);
    if (colors) colors.set(m.colors, vo * 3);
    if (m.indices) { for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + vo; io += m.indices.length; }
    else { for (let i = 0; i < n; i++) indices[io + i] = vo + i; io += n; }
    vo += n;
  }
  const merged = { name: name || meshes[0].name || 'Merged', positions, indices };
  if (normals) merged.normals = normals;
  if (colors) merged.colors = colors;
  return { ...meshSet, meshes: [merged] };
}

/** Triangle / vertex counts and bounding box, for logging and tests. */
export function meshSetStats(meshSet) {
  let triangles = 0; let vertices = 0;
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshSet.meshes) {
    vertices += m.positions.length / 3;
    triangles += (m.indices ? m.indices.length : m.positions.length / 3) / 3;
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) { if (p[i + k] < min[k]) min[k] = p[i + k]; if (p[i + k] > max[k]) max[k] = p[i + k]; }
    }
  }
  return { bodies: meshSet.meshes.length, triangles, vertices, min, max, names: meshSet.meshes.map((m) => m.name) };
}

function validateMeshSet(meshSet) {
  if (!meshSet || !Array.isArray(meshSet.meshes) || meshSet.meshes.length === 0) throw readable('There is no geometry to write.');
  meshSet.meshes.forEach((m, i) => {
    const label = m.name || `body ${i + 1}`;
    if (!m.positions || m.positions.length < 9 || m.positions.length % 3 !== 0) throw readable(`Body "${label}" has no valid triangle data.`);
    const count = m.positions.length / 3;
    if (m.indices) {
      if (m.indices.length % 3 !== 0 || m.indices.length === 0) throw readable(`Body "${label}" has an invalid triangle index list.`);
      for (let k = 0; k < m.indices.length; k++) if (m.indices[k] >= count) throw readable(`Body "${label}" references a vertex that does not exist.`);
    } else if (count % 3 !== 0) {
      throw readable(`Body "${label}" has a vertex count that is not a multiple of three.`);
    }
    if (m.normals && m.normals.length !== m.positions.length) throw readable(`Body "${label}" has mismatched normals.`);
    if (m.colors && m.colors.length !== m.positions.length) throw readable(`Body "${label}" has mismatched colours.`);
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// Text formats: 7 significant digits is all a float32 carries; this keeps
// "0.3" from being printed as "0.30000001192092896".
function rounded(arr) {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = +arr[i].toPrecision(7);
  return out;
}
const num = (x) => (x === 0 ? '0' : String(+x.toPrecision(7)));

function safeName(name, i) {
  const n = String(name || '').replace(/[\r\n\t]+/g, ' ').trim();
  return n || `Body${i + 1}`;
}

function toGroup(THREE, meshSet, { round = false, computeNormals = false } = {}) {
  const group = new THREE.Group();
  group.name = 'Scene';
  meshSet.meshes.forEach((m, i) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(round ? rounded(m.positions) : m.positions, 3));
    if (m.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(round ? rounded(m.normals) : m.normals, 3));
    else if (computeNormals) { /* after index */ }
    if (m.colors) geometry.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    if (m.indices) geometry.setIndex(new THREE.BufferAttribute(m.indices, 1));
    if (!m.normals && computeNormals) geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6, metalness: 0, vertexColors: !!m.colors });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = safeName(m.name, i);
    group.add(mesh);
  });
  group.updateMatrixWorld(true);
  return group;
}

const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

const THREE_MF_CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n';
const THREE_MF_RELS = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n';

async function write3mf(meshSet) {
  const { zipSync, strToU8 } = await load(FFLATE_URL);
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
    ' <metadata name="Application">bjkravets.com/file</metadata>\n <resources>\n'];
  meshSet.meshes.forEach((m, i) => {
    const p = m.positions;
    parts.push(`  <object id="${i + 1}" name="${escapeXml(safeName(m.name, i))}" type="model">\n   <mesh>\n    <vertices>\n`);
    for (let k = 0; k < p.length; k += 3) parts.push(`     <vertex x="${num(p[k])}" y="${num(p[k + 1])}" z="${num(p[k + 2])}"/>\n`);
    parts.push('    </vertices>\n    <triangles>\n');
    if (m.indices) {
      const idx = m.indices;
      for (let k = 0; k < idx.length; k += 3) parts.push(`     <triangle v1="${idx[k]}" v2="${idx[k + 1]}" v3="${idx[k + 2]}"/>\n`);
    } else {
      for (let k = 0; k < p.length / 3; k += 3) parts.push(`     <triangle v1="${k}" v2="${k + 1}" v3="${k + 2}"/>\n`);
    }
    parts.push('    </triangles>\n   </mesh>\n  </object>\n');
  });
  parts.push(' </resources>\n <build>\n');
  meshSet.meshes.forEach((m, i) => parts.push(`  <item objectid="${i + 1}"/>\n`));
  parts.push(' </build>\n</model>\n');
  const zip = zipSync({
    '[Content_Types].xml': strToU8(THREE_MF_CONTENT_TYPES),
    '_rels/.rels': strToU8(THREE_MF_RELS),
    '3D/3dmodel.model': strToU8(parts.join('')),
  }, { level: 6 });
  return new Blob([zip], { type: 'model/3mf' });
}

function asBlob(data, mime) {
  if (data instanceof DataView) data = data.buffer;
  return new Blob([data], { type: mime });
}

/** Write a MeshSet as outputId. options: { binary } for stl / ply. Resolves { blob, ext }. */
export async function writeMesh(meshSet, outputId, options = {}) {
  const fmt = byId(outputId);
  if (!fmt || !fmt.write) throw readable(`Writing ${outputId || 'this'} files is not supported.`);
  validateMeshSet(meshSet);
  const THREE = await three();
  const binary = options.binary !== undefined ? !!options.binary : true;
  let blob;
  switch (outputId) {
    case 'stl': {
      const { STLExporter } = await addon('exporters/STLExporter.js');
      blob = asBlob(new STLExporter().parse(toGroup(THREE, meshSet, { round: !binary }), { binary }), fmt.mime);
      break;
    }
    case 'obj': {
      const { OBJExporter } = await addon('exporters/OBJExporter.js');
      blob = asBlob(new OBJExporter().parse(toGroup(THREE, meshSet, { round: true })), fmt.mime);
      break;
    }
    case 'ply': {
      const { PLYExporter } = await addon('exporters/PLYExporter.js');
      const group = toGroup(THREE, meshSet, { round: !binary });
      blob = asBlob(new PLYExporter().parse(group, undefined, { binary, littleEndian: true, excludeAttributes: ['uv'] }), fmt.mime);
      break;
    }
    case 'glb':
    case 'gltf': {
      const { GLTFExporter } = await addon('exporters/GLTFExporter.js');
      const group = toGroup(THREE, meshSet, { computeNormals: true });
      const result = await new GLTFExporter().parseAsync(group, { binary: outputId === 'glb', onlyVisible: false });
      blob = outputId === 'glb' ? asBlob(result, fmt.mime) : new Blob([JSON.stringify(result)], { type: fmt.mime });
      break;
    }
    case '3mf':
      blob = await write3mf(meshSet);
      break;
    case 'usdz': {
      const { USDZExporter } = await addon('exporters/USDZExporter.js');
      const group = toGroup(THREE, meshSet, { computeNormals: true });
      const bytes = await new USDZExporter().parseAsync(group, { includeAnchoringProperties: false });
      blob = new Blob([bytes], { type: fmt.mime });
      break;
    }
    default:
      throw readable(`Writing ${fmt.name} is not supported.`);
  }
  return { blob, ext: fmt.ext[0] };
}

// ---------------------------------------------------------------------------
// Standalone engine API (model.js is the composed engine used by the page)
// ---------------------------------------------------------------------------

export const domain = { id: 'model', name: '3D Model' };
export const formats = meshFormats;
export const options = [
  { id: 'scale', label: 'Scale', type: 'number', default: 1, min: 0.000001, step: 0.001, help: 'Multiply all coordinates' },
  { id: 'merge', label: 'Merge bodies', type: 'toggle', default: false, help: 'Combine all bodies into one' },
];
export const loadNote = '';
export const detect = detectMesh;
export function targets(inputId) {
  return meshFormats.filter((f) => f.write && f.id !== inputId).map((f) => f.id);
}
export const warmup = warmupMesh;
export async function convert({ file, inputId, outputId, options: opts = {}, onProgress }) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  progress(null, 'Loading Three.js');
  await warmupMesh(outputId, inputId);
  progress(0.15, 'Reading ' + (file.name || inputId));
  let meshSet = await readMesh(file, inputId);
  if (opts.scale !== undefined && opts.scale !== null && +opts.scale !== 1) meshSet = scaleMeshSet(meshSet, +opts.scale);
  if (opts.merge) meshSet = mergeMeshSet(meshSet);
  progress(0.6, 'Writing ' + (byId(outputId) || { name: outputId }).name);
  const out = await writeMesh(meshSet, outputId, opts);
  progress(1);
  return out;
}
