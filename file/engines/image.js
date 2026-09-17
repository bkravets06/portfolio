// Image engine for bjkravets.com/file — see file/_dev/CONTRACT.md.
//
// Strategy: decode natively (createImageBitmap / <img>) whenever the browser
// can, and only fall back to WebAssembly codecs (downloaded from jsDelivr on
// first use) for what it cannot: AVIF (older browsers), HEIC/HEIF (everything
// but Safari), TIFF (everything but Safari), JPEG XL and QOI. Encoding uses
// the canvas for PNG / JPEG / WebP, hand-written encoders for BMP and ICO,
// UTIF for TIFF, gifenc for GIF and the @jsquash codecs for AVIF / WebP
// (Safari) / JPEG XL / QOI. Heavy codecs run in a Blob-URL module worker so
// the page stays responsive and Cancel really stops them; if the worker
// cannot start the same code runs on the main thread.
//
// Nothing heavy is imported at module top level.

export const domain = { id: 'image', name: 'Image' };

// Exact pins. Everything is a plain ES module loaded with import() and
// resolves its own .wasm next to itself via import.meta.url. The @jsquash
// emscripten glue is imported directly (not the package index) so that no
// bare `wasm-feature-detect` specifier has to be resolved.
const CDN = {
  avifEnc:  'https://cdn.jsdelivr.net/npm/@jsquash/avif@2.1.1/codec/enc/avif_enc.js',   // 40 KB + 3.49 MB wasm
  avifDec:  'https://cdn.jsdelivr.net/npm/@jsquash/avif@2.1.1/codec/dec/avif_dec.js',   // 35 KB + 1.17 MB wasm
  avifMeta: 'https://cdn.jsdelivr.net/npm/@jsquash/avif@2.1.1/meta.js',
  webpEnc:  'https://cdn.jsdelivr.net/npm/@jsquash/webp@1.5.0/codec/enc/webp_enc.js',   // 39 KB + 281 KB wasm (Safari only)
  webpMeta: 'https://cdn.jsdelivr.net/npm/@jsquash/webp@1.5.0/meta.js',
  jxlEnc:   'https://cdn.jsdelivr.net/npm/@jsquash/jxl@1.3.0/codec/enc/jxl_enc.js',     // 47 KB + 1.36 MB wasm
  jxlDec:   'https://cdn.jsdelivr.net/npm/@jsquash/jxl@1.3.0/codec/dec/jxl_dec.js',     // 36 KB + 849 KB wasm
  jxlMeta:  'https://cdn.jsdelivr.net/npm/@jsquash/jxl@1.3.0/meta.js',
  qoiEnc:   'https://cdn.jsdelivr.net/npm/@jsquash/qoi@1.1.0/codec/enc/qoi_enc.js',     // 34 KB + 15 KB wasm
  qoiDec:   'https://cdn.jsdelivr.net/npm/@jsquash/qoi@1.1.0/codec/dec/qoi_dec.js',     // 34 KB + 15 KB wasm
  heif:     'https://cdn.jsdelivr.net/npm/libheif-js@1.23.2/libheif-wasm/libheif-bundle.mjs', // 1.99 MB (wasm embedded)
  gifenc:   'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js',             // 9 KB
  utif:     'https://cdn.jsdelivr.net/npm/utif@3.1.0/+esm',                             // 42 KB (+ pako 1.0.10, ~45 KB)
};

export const loadNote =
  'Some formats download a codec on first use and cache it afterwards: ' +
  'writing AVIF ≈ 3.5 MB, reading HEIC ≈ 2 MB, JPEG XL ≈ 0.9–1.4 MB, others under 0.4 MB.';

const quality = (def, help) => ({
  id: 'quality', label: 'Quality', type: 'range', min: 1, max: 100, step: 1, unit: '%', default: def,
  help: help || 'Higher is better quality and a larger file.',
});

export const formats = [
  { id: 'png',  name: 'PNG',  ext: ['png'],  mime: 'image/png',  read: true, write: true, group: 'Image',
    note: 'Lossless, keeps transparency' },
  { id: 'jpeg', name: 'JPEG', ext: ['jpg', 'jpeg', 'jpe', 'jfif'], mime: 'image/jpeg', read: true, write: true, group: 'Image',
    note: 'Lossy, no transparency', options: [quality(90)] },
  { id: 'webp', name: 'WebP', ext: ['webp'], mime: 'image/webp', read: true, write: true, group: 'Image',
    note: 'Lossy, keeps transparency', options: [quality(85)] },
  { id: 'avif', name: 'AVIF', ext: ['avif'], mime: 'image/avif', read: true, write: true, group: 'Image',
    note: 'Smallest files; slow to encode', options: [quality(65)] },
  { id: 'gif',  name: 'GIF',  ext: ['gif'],  mime: 'image/gif',  read: true, write: true, group: 'Image',
    note: '256 colours, single frame' },
  { id: 'bmp',  name: 'BMP',  ext: ['bmp', 'dib'], mime: 'image/bmp', read: true, write: true, group: 'Image',
    note: 'Uncompressed' },
  { id: 'tiff', name: 'TIFF', ext: ['tif', 'tiff'], mime: 'image/tiff', read: true, write: true, group: 'Image',
    note: 'Uncompressed' },
  { id: 'ico',  name: 'ICO',  ext: ['ico', 'cur'], mime: 'image/x-icon', read: true, write: true, group: 'Image',
    note: 'Windows icon, square, up to 256 px',
    options: [{
      id: 'size', label: 'Icon size', type: 'select', default: '256',
      choices: [16, 32, 48, 64, 128, 256].map((n) => ({ value: String(n), label: `${n} × ${n}` })),
      help: 'The image is fitted into a square of this size.',
    }] },
  { id: 'jxl',  name: 'JPEG XL', ext: ['jxl'], mime: 'image/jxl', read: true, write: true, group: 'Image',
    note: 'Modern, few viewers support it yet', options: [quality(80)] },
  { id: 'qoi',  name: 'QOI',  ext: ['qoi'],  mime: 'image/qoi',  read: true, write: true, group: 'Image',
    note: 'Lossless, niche' },
  { id: 'svg',  name: 'SVG',  ext: ['svg'],  mime: 'image/svg+xml', read: true, write: false, group: 'Image',
    note: 'Rasterised at its own size' },
  { id: 'heic', name: 'HEIC / HEIF', ext: ['heic', 'heif', 'hif'], mime: 'image/heic', read: true, write: false, group: 'Image',
    note: 'iPhone photos' },
];

export const options = [
  { id: 'scale', label: 'Scale', type: 'range', min: 10, max: 100, step: 1, unit: '%', default: 100,
    help: 'Shrink the output; 100% keeps the original pixel size.' },
  { id: 'background', label: 'Background', type: 'select', default: 'white',
    choices: [{ value: 'white', label: 'White' }, { value: 'black', label: 'Black' }],
    help: 'Colour placed behind transparent areas when the output cannot hold them (JPEG, GIF).' },
];

const byId = (id) => formats.find((f) => f.id === id);
const REENCODE = new Set(['jpeg', 'webp', 'avif', 'jxl']);
const MAX_SIDE = 16384;            // canvas limit in every major browser
const MAX_AREA = 268435456;        // 2^28 px, Chrome's canvas area limit

// ---------------------------------------------------------------- detect ---

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

function ascii(h, off, len) {
  let s = '';
  for (let i = off; i < off + len && i < h.length; i++) s += String.fromCharCode(h[i]);
  return s;
}
function startsWith(h, bytes) {
  if (h.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (h[i] !== bytes[i]) return false;
  return true;
}
function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function detect(file, head) {
  const h = head instanceof Uint8Array ? head : new Uint8Array(0);
  if (startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(h, [0xff, 0xd8, 0xff])) return 'jpeg';
  const s6 = ascii(h, 0, 6);
  if (s6 === 'GIF87a' || s6 === 'GIF89a') return 'gif';
  if (ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 4) === 'WEBP') return 'webp';
  if (ascii(h, 0, 2) === 'BM' && h.length >= 14) return 'bmp';
  const s4 = ascii(h, 0, 4);
  if (s4 === 'II*\0' || s4 === 'MM\0*') return 'tiff';
  if (s4 === 'qoif') return 'qoi';
  if (h.length >= 6 && h[0] === 0 && h[1] === 0 && (h[2] === 1 || h[2] === 2) && h[3] === 0 && h[5] === 0 && h[4] > 0) return 'ico';
  if (startsWith(h, [0xff, 0x0a]) || startsWith(h, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])) return 'jxl';
  if (ascii(h, 4, 4) === 'ftyp') {
    const boxLen = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
    const end = Math.min(h.length, boxLen > 16 ? boxLen : h.length);
    const brands = [ascii(h, 8, 4)];
    for (let o = 16; o + 4 <= end; o += 4) brands.push(ascii(h, o, 4));
    if (brands.some((b) => b === 'avif' || b === 'avis')) return 'avif';
    if (brands.some((b) => HEIC_BRANDS.has(b))) return 'heic';
    return null; // some other ISO-BMFF file (mp4, mov…) — not ours
  }
  // SVG has no magic bytes: it is text that starts with a tag.
  const text = ascii(h, 0, h.length).replace(/^﻿|^[\xEF\xBB\xBF]{3}/, '').trimStart();
  const ext = extOf(file && file.name);
  const type = (file && file.type || '').toLowerCase();
  if (/^<svg[\s>]/i.test(text) || /<svg[\s>]/i.test(text)) return 'svg';
  if (text.startsWith('<') && (ext === 'svg' || type === 'image/svg+xml')) return 'svg';
  return null;
}

export function targets(inputId) {
  return formats.filter((f) => f.write && (f.id !== inputId || REENCODE.has(f.id))).map((f) => f.id);
}

// ------------------------------------------------------------ codec ops ---
// Every function in OPS is self-contained (only CDN, MODS, OPS and web
// globals) because the same source text is stringified into the worker.

const MODS = new Map();

const OPS = {
  async load(kind) {
    if (!MODS.has(kind)) {
      MODS.set(kind, (async () => {
        const m = await import(CDN[kind]);
        if (kind === 'heif') return m.default();                 // libheif factory → Promise<module>
        if (kind === 'gifenc' || kind === 'utif') return m;      // plain ES modules
        return m.default({ noInitialRun: true });                // @jsquash emscripten glue → Promise<module>
      })().catch((e) => { MODS.delete(kind); throw e; }));
    }
    return MODS.get(kind);
  },

  async preload(kind) {
    await OPS.load(kind);
    return { result: true };
  },

  // @jsquash encoders: data is RGBA (Uint8ClampedArray), returns ArrayBuffer.
  async encode(kind, data, width, height, opts) {
    const mod = await OPS.load(kind);
    const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let out;
    try {
      if (kind === 'qoiEnc') {
        out = mod.encode(rgba, width, height);
      } else {
        const { defaultOptions } = await import(CDN[kind.replace('Enc', 'Meta')]);
        out = mod.encode(rgba, width, height, { ...defaultOptions, ...opts });
      }
    } catch (e) { throw OPS.crashed(kind, e); }
    if (!out) throw new Error('The encoder could not encode this image.');
    const copy = new Uint8Array(out);            // own buffer, never a view into wasm memory
    return { result: copy.buffer, transfer: [copy.buffer] };
  },

  // A wasm abort (usually out of memory) leaves the instance unusable: forget it.
  crashed(kind, e) {
    if (e && /Aborted|out of memory|enlarge memory|unreachable|RuntimeError/i.test(String(e.message || e))) MODS.delete(kind);
    return e;
  },

  // @jsquash decoders and libheif: returns { data (RGBA), width, height }.
  async decode(kind, buffer) {
    const mod = await OPS.load(kind);
    if (kind === 'heif') {
      const decoder = new mod.HeifDecoder();
      const images = decoder.decode(new Uint8Array(buffer));
      if (!images || !images.length) throw new Error('No image was found inside this HEIC/HEIF file.');
      const img = images.find((i) => typeof i.is_primary === 'function' && i.is_primary()) || images[0];
      const width = img.get_width(), height = img.get_height();
      const data = new Uint8ClampedArray(width * height * 4);
      try {
        await new Promise((resolve, reject) => {
          img.display({ data, width, height }, (ok) => (ok ? resolve() : reject(new Error('The HEIC image could not be decoded.'))));
        });
      } finally {
        for (const i of images) { try { i.free(); } catch (e) { /* ignore */ } }
      }
      return { result: { data, width, height }, transfer: [data.buffer] };
    }
    let img;
    try { img = kind === 'avifDec' ? mod.decode(buffer, 8) : mod.decode(buffer); }
    catch (e) { throw OPS.crashed(kind, e); }
    if (!img) throw new Error('The image could not be decoded.');
    const data = new Uint8ClampedArray(img.data);   // copy out of wasm memory
    return { result: { data, width: img.width, height: img.height }, transfer: [data.buffer] };
  },

  async gifEncode(data, width, height) {
    const { GIFEncoder, quantize, applyPalette } = await OPS.load('gifenc');
    const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const palette = quantize(rgba, 256, { format: 'rgb565' });
    const index = applyPalette(rgba, palette, 'rgb565');
    const gif = GIFEncoder();
    gif.writeFrame(index, width, height, { palette });
    gif.finish();
    const bytes = gif.bytes();
    return { result: bytes.buffer, transfer: [bytes.buffer] };
  },

  async tiffDecode(buffer) {
    const UTIF = (await OPS.load('utif')).default;
    const ifds = UTIF.decode(buffer);
    if (!ifds || !ifds.length) throw new Error('No image was found inside this TIFF file.');
    // First page that really carries pixels (some TIFFs start with a thumbnail-less directory).
    const page = ifds.find((p) => p.t256 && p.t257 && p.t273) || ifds[0];
    if (page.t259 && page.t259[0] === 32946) page.t259 = [8];   // legacy Deflate code: same zlib stream as 8
    UTIF.decodeImage(buffer, page, ifds);
    const rgba = UTIF.toRGBA8(page);
    if (!rgba || !page.width || !page.height) throw new Error('This TIFF uses a variant that cannot be decoded here.');
    const data = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    const orientation = page.t274 ? page.t274[0] : 1;
    return { result: { data, width: page.width, height: page.height, orientation }, transfer: [data.buffer] };
  },

  async tiffEncode(data, width, height, hasAlpha) {
    const UTIF = (await OPS.load('utif')).default;
    const spp = hasAlpha ? 4 : 3;
    const ifd = {
      t256: [width], t257: [height], t258: hasAlpha ? [8, 8, 8, 8] : [8, 8, 8], t259: [1], t262: [2],
      t273: [1000], t277: [spp], t278: [height], t279: [width * height * spp],
      t282: [72], t283: [72], t284: [1], t296: [2], t305: ['bjkravets.com/file'],
    };
    if (hasAlpha) ifd.t338 = [2];   // unassociated (straight) alpha
    const header = new Uint8Array(UTIF.encode([ifd]));
    if (header.length > 1000) throw new Error('TIFF header overflow');
    const out = new Uint8Array(1000 + width * height * spp);
    out.set(header, 0);
    if (hasAlpha) {
      out.set(data, 1000);
    } else {
      for (let i = 0, o = 1000; i < data.length; i += 4) { out[o++] = data[i]; out[o++] = data[i + 1]; out[o++] = data[i + 2]; }
    }
    return { result: out.buffer, transfer: [out.buffer] };
  },
};

// ---------------------------------------------------------------- worker ---

const WORKER_MAIN = `
if (typeof ImageData === 'undefined') {
  self.ImageData = class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
}
self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const r = await OPS[op](...args);
    self.postMessage({ id, ok: true, result: r.result }, r.transfer || []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
self.postMessage({ ready: true });
`;

function workerSource() {
  const ops = Object.values(OPS).map((fn) => fn.toString()).join(',\n');
  return `const CDN = ${JSON.stringify(CDN)};\nconst MODS = new Map();\nconst OPS = {\n${ops}\n};\n${WORKER_MAIN}`;
}

let workerPromise = null;
let workerUnavailable = false;
let seq = 0;

function startupFailure(cause) {
  const e = new Error('worker failed to start');
  e.workerStartup = true;
  e.cause = cause;
  return e;
}

function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = new Promise((resolve, reject) => {
    let w;
    try {
      const url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
      w = new Worker(url, { type: 'module' });
      w._url = url;
    } catch (e) { reject(startupFailure(e)); return; }
    const onReady = (e) => {
      if (e.data && e.data.ready) { w.removeEventListener('message', onReady); w.removeEventListener('error', onErr); resolve(w); }
    };
    const onErr = (e) => { w.terminate(); reject(startupFailure(e)); };
    w.addEventListener('message', onReady);
    w.addEventListener('error', onErr);
  }).catch((e) => { workerPromise = null; throw e; });
  return workerPromise;
}

function dropWorker(w) {
  try { w.terminate(); } catch (e) { /* ignore */ }
  if (w._url) URL.revokeObjectURL(w._url);
  workerPromise = null;
}

function abortError() {
  const e = new Error('Conversion cancelled.');
  e.name = 'AbortError';
  return e;
}

function callWorker(w, op, args, transfer, signal) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const cleanup = () => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onMessage = (e) => {
      if (!e.data || e.data.id !== id) return;
      cleanup();
      if (e.data.ok) resolve(e.data.result);
      else reject(new Error(e.data.error));
    };
    const onError = (e) => { cleanup(); dropWorker(w); reject(new Error((e && e.message) || 'The codec crashed.')); };
    const onAbort = () => { cleanup(); dropWorker(w); reject(abortError()); };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try { w.postMessage({ id, op, args }, transfer); }
    catch (e) { cleanup(); reject(e); }
  });
}

const CODEC_NAME = {
  avifEnc: 'AVIF', avifDec: 'AVIF', webpEnc: 'WebP', jxlEnc: 'JPEG XL', jxlDec: 'JPEG XL',
  qoiEnc: 'QOI', qoiDec: 'QOI', heif: 'HEIC', gifenc: 'GIF', utif: 'TIFF',
};

function translateCodecError(e, op, kind) {
  if (!e || e.name === 'AbortError') return e;
  const msg = String(e.message || e);
  const name = CODEC_NAME[kind] || CODEC_NAME[op] || 'image';
  let err = null;
  if (/Aborted\(|out of memory|enlarge memory|unreachable|RuntimeError/i.test(msg)) {
    err = new Error(`The ${name} codec ran out of memory on this image. Lower the scale option and try again.`);
  } else if (/fetch|import|network|wasm|load/i.test(msg) && !/could not (en|de)code/i.test(msg)) {
    err = new Error(`The ${name} codec could not be downloaded. Check your connection and try again.`);
  }
  if (!err) return e;
  err.friendly = true;      // already worded for the user: callers must not re-wrap it
  err.cause = e;
  return err;
}

// Run a codec op in the worker (main thread if workers are unavailable).
async function runCodec(op, args, transfer = [], signal) {
  if (signal && signal.aborted) throw abortError();
  const kind = op === 'gifEncode' ? 'gifenc' : /^tiff/.test(op) ? 'utif' : args[0];
  try {
    if (!workerUnavailable) {
      let w;
      try { w = await getWorker(); }
      catch (e) {
        if (!e.workerStartup) throw e;
        workerUnavailable = true;
        console.warn('image engine: module worker unavailable, running codecs on the main thread', e.cause);
      }
      if (w) return await callWorker(w, op, args, transfer, signal);
    }
    const r = await OPS[op](...args);
    if (signal && signal.aborted) throw abortError();
    return r.result;
  } catch (e) {
    throw translateCodecError(e, op, kind);
  }
}

// ---------------------------------------------------------------- canvas ---

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function canvasToBlob(canvas, type, q) {
  if (canvas.convertToBlob) return canvas.convertToBlob(q === undefined ? { type } : { type, quality: q });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The browser could not encode the image.'))), type, q);
  });
}

const encodeSupport = new Map();
function canvasSupports(type) {
  if (!encodeSupport.has(type)) {
    encodeSupport.set(type, (async () => {
      try {
        const c = makeCanvas(1, 1);
        c.getContext('2d');                    // a context is required before encoding
        const b = await canvasToBlob(c, type);
        return !!b && b.type === type;
      }
      catch (e) { return false; }
    })());
  }
  return encodeSupport.get(type);
}

function hasAlpha(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  return false;
}

function checkSize(w, h) {
  if (w > MAX_SIDE || h > MAX_SIDE) throw new Error(`The output would be ${w} × ${h} px; the browser cannot handle images wider or taller than ${MAX_SIDE} px. Lower the scale option.`);
  if (w * h > MAX_AREA) throw new Error(`The output would be ${w} × ${h} px, which is more than the browser can hold in memory. Lower the scale option.`);
}

// Apply a TIFF/EXIF orientation (1–8) to raw RGBA.
function orient(data, width, height, o) {
  if (!o || o === 1 || o > 8) return { data, width, height };
  const swap = o >= 5;
  const w2 = swap ? height : width, h2 = swap ? width : height;
  const out = new Uint8ClampedArray(w2 * h2 * 4);
  const src = new Uint32Array(data.buffer, data.byteOffset, width * height);
  const dst = new Uint32Array(out.buffer);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let nx, ny;
      switch (o) {
        case 2: nx = width - 1 - x; ny = y; break;                 // mirror horizontal
        case 3: nx = width - 1 - x; ny = height - 1 - y; break;    // rotate 180
        case 4: nx = x; ny = height - 1 - y; break;                // mirror vertical
        case 5: nx = y; ny = x; break;                             // transpose
        case 6: nx = height - 1 - y; ny = x; break;                // rotate 90 CW
        case 7: nx = height - 1 - y; ny = width - 1 - x; break;    // transverse
        default: nx = y; ny = width - 1 - x; break;                // 8: rotate 90 CCW
      }
      dst[ny * w2 + nx] = src[y * width + x];
    }
  }
  return { data: out, width: w2, height: h2 };
}

// --------------------------------------------------------------- decoding ---

function once(fn) { let done = false; return () => { if (!done) { done = true; fn(); } }; }

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The browser could not decode this image.')); };
    img.src = url;
  });
}

// Native decode: ImageBitmap honouring EXIF orientation, else <img> (which
// always honours it), else null when the browser cannot read the format.
async function decodeNative(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: once(() => bmp.close()) };
    } catch (e) {
      // TypeError: this browser does not know 'from-image' — use <img> so EXIF still applies.
      // Anything else: the format is unsupported or the file is broken; <img> is the second opinion.
    }
  }
  try {
    const img = await loadImage(file);
    if (!img.naturalWidth || !img.naturalHeight) return null;
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: once(() => { img.src = ''; }) };
  } catch (e) {
    return null;
  }
}

function fromImageData(data, width, height) {
  const c = makeCanvas(width, height);
  const ctx = c.getContext('2d');
  let img;
  try { img = new ImageData(data, width, height); }
  catch (e) { img = ctx.createImageData(width, height); img.data.set(data); }
  ctx.putImageData(img, 0, 0);
  return { source: c, width, height, close: once(() => { c.width = 0; c.height = 0; }) };
}

const WASM_DECODER = { avif: 'avifDec', heic: 'heif', jxl: 'jxlDec', qoi: 'qoiDec' };

async function decodeInput(file, inputId, signal) {
  const name = (byId(inputId) || {}).name || 'image';
  if (inputId === 'svg') return rasterizeSvg(file);
  if (inputId !== 'qoi') {                       // no browser decodes QOI; skip the attempt
    const native = await decodeNative(file);
    if (native) return native;
  }
  if (signal && signal.aborted) throw abortError();
  const unreadable = () => new Error(`This ${name} file could not be decoded — it may be corrupted, truncated, or use a variant this converter does not support.`);
  if (inputId !== 'tiff' && !WASM_DECODER[inputId]) throw unreadable();
  const buffer = await file.arrayBuffer();
  let r;
  try {
    if (inputId === 'tiff') {
      r = await runCodec('tiffDecode', [buffer], [buffer], signal);
      r = orient(r.data, r.width, r.height, r.orientation);
    } else {
      r = await runCodec('decode', [WASM_DECODER[inputId], buffer], [buffer], signal);
    }
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.friendly)) throw e;
    console.warn('image engine: decode failed', e);
    throw unreadable();
  }
  return fromImageData(r.data, r.width, r.height);
}

// ------------------------------------------------------------------- SVG ---

const UNIT_PX = { '': 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 101.6 };

function parseLength(s) {
  if (!s) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(s);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  if (!(unit in UNIT_PX)) return null;           // %, em, ex… carry no absolute size
  const v = parseFloat(m[1]) * UNIT_PX[unit];
  return Number.isFinite(v) && v > 0 ? v : null;
}

function svgSize(root) {
  const w = parseLength(root.getAttribute('width'));
  const h = parseLength(root.getAttribute('height'));
  const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const hasVB = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  let out;
  if (w && h) out = { w, h };
  else if (w && hasVB) out = { w, h: w * vb[3] / vb[2] };
  else if (h && hasVB) out = { w: h * vb[2] / vb[3], h };
  else if (hasVB) { const s = 1024 / Math.max(vb[2], vb[3]); out = { w: vb[2] * s, h: vb[3] * s }; }
  else if (w) out = { w, h: w };
  else if (h) out = { w: h, h };
  else out = { w: 1024, h: 1024 };
  const over = Math.max(out.w, out.h) / MAX_SIDE;
  if (over > 1) out = { w: out.w / over, h: out.h / over };
  return { w: Math.max(1, Math.round(out.w)), h: Math.max(1, Math.round(out.h)) };
}

async function rasterizeSvg(file) {
  const text = await file.text();
  const parse = (t) => {
    const doc = new DOMParser().parseFromString(t, 'image/svg+xml');
    const root = doc.documentElement;
    const bad = doc.getElementsByTagName('parsererror').length > 0 ||
      !root || root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg';
    return bad ? null : doc;
  };
  let doc = parse(text);
  if (!doc && /<svg[\s>]/i.test(text) && !/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg/.test(text)) {
    // Hand-written SVGs often omit the namespace; browsers will not render those from a Blob.
    doc = parse(text.replace(/<svg(\s|>)/i, '<svg xmlns="http://www.w3.org/2000/svg"$1'));
  }
  if (!doc) throw new Error('This SVG file could not be parsed — it is not well-formed SVG/XML.');
  const root = doc.documentElement;
  const { w, h } = svgSize(root);
  root.setAttribute('width', String(w));
  root.setAttribute('height', String(h));
  const blob = new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml;charset=utf-8' });
  let img;
  try { img = await loadImage(blob); }
  catch (e) { throw new Error('This SVG could not be rendered by the browser.'); }
  return { source: img, width: w, height: h, vector: true, close: once(() => { img.src = ''; }) };
}

// -------------------------------------------------------------- encoders ---

function encodeBmp(data, width, height, alpha) {
  // 32-bit with alpha uses BITMAPV5HEADER: macOS ImageIO ignores alpha in
  // V4/INFOHEADER files, while Windows, Chrome, ffmpeg and Preview all read V5.
  const dib = alpha ? 124 : 40;                             // BITMAPV5HEADER : BITMAPINFOHEADER
  const stride = alpha ? width * 4 : (width * 3 + 3) & ~3;
  const imageSize = stride * height;
  const buf = new ArrayBuffer(14 + dib + imageSize);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8[0] = 0x42; u8[1] = 0x4d;                               // 'BM'
  v.setUint32(2, buf.byteLength, true);
  v.setUint32(10, 14 + dib, true);                          // pixel data offset
  v.setUint32(14, dib, true);
  v.setInt32(18, width, true);
  v.setInt32(22, height, true);                             // positive = bottom-up
  v.setUint16(26, 1, true);
  v.setUint16(28, alpha ? 32 : 24, true);
  v.setUint32(30, alpha ? 3 : 0, true);                     // BI_BITFIELDS : BI_RGB
  v.setUint32(34, imageSize, true);
  v.setInt32(38, 2835, true); v.setInt32(42, 2835, true);   // 72 dpi
  if (alpha) {
    v.setUint32(54, 0x00ff0000, true); v.setUint32(58, 0x0000ff00, true);
    v.setUint32(62, 0x000000ff, true); v.setUint32(66, 0xff000000, true);
    v.setUint32(70, 0x73524742, true);                      // LCS_sRGB ('BGRs' on disk)
    v.setUint32(122, 4, true);                              // intent: LCS_GM_IMAGES
  }
  let o = 14 + dib;
  for (let y = height - 1; y >= 0; y--) {
    let i = y * width * 4;
    const rowEnd = o + stride;
    for (let x = 0; x < width; x++, i += 4) {
      u8[o++] = data[i + 2]; u8[o++] = data[i + 1]; u8[o++] = data[i];
      if (alpha) u8[o++] = data[i + 3];
    }
    o = rowEnd;                                             // zero padding already there
  }
  return buf;
}

function wrapIco(png, w, h) {
  const out = new Uint8Array(22 + png.length);
  const v = new DataView(out.buffer);
  v.setUint16(2, 1, true);                                  // type: icon
  v.setUint16(4, 1, true);                                  // one image
  out[6] = w >= 256 ? 0 : w;
  out[7] = h >= 256 ? 0 : h;
  v.setUint16(10, 1, true);                                 // colour planes
  v.setUint16(12, 32, true);                                // bits per pixel
  v.setUint32(14, png.length, true);
  v.setUint32(18, 22, true);                                // offset of the PNG
  out.set(png, 22);
  return out;
}

// ---------------------------------------------------------------- warmup ---

export async function warmup(outputId) {
  try {
    if (outputId === 'avif') await runCodec('preload', ['avifEnc']);
    else if (outputId === 'jxl') await runCodec('preload', ['jxlEnc']);
    else if (outputId === 'qoi') await runCodec('preload', ['qoiEnc']);
    else if (outputId === 'gif') await runCodec('preload', ['gifenc']);
    else if (outputId === 'tiff') await runCodec('preload', ['utif']);
    else if (outputId === 'webp' && !(await canvasSupports('image/webp'))) await runCodec('preload', ['webpEnc']);
  } catch (e) {
    console.warn('image engine warmup failed (will retry on convert):', e);
  }
}

// --------------------------------------------------------------- convert ---

const num = (v, def) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v !== '' && Number.isFinite(+v) ? +v : def));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function defaultQuality(outputId) {
  const f = byId(outputId);
  const q = f && f.options && f.options.find((o) => o.id === 'quality');
  return q ? q.default : 85;
}

export async function convert({ file, inputId, outputId, options = {}, onProgress = () => {}, signal }) {
  const out = byId(outputId);
  if (!out || !out.write) throw new Error(`Cannot write ${outputId} files.`);
  if (!byId(inputId) || !byId(inputId).read) throw new Error('This file is not a supported image.');
  const progress = (f, m) => { try { onProgress(f, m); } catch (e) { /* ignore */ } };
  const checkAbort = () => { if (signal && signal.aborted) throw abortError(); };

  const scale = clamp(num(options.scale, 100), 10, 100) / 100;
  const background = options.background === 'black' ? '#000000' : '#ffffff';
  const q = clamp(Math.round(num(options.quality, defaultQuality(outputId))), 1, 100);

  progress(0.05, 'Decoding…');
  const src = await decodeInput(file, inputId, signal);
  try {
    checkAbort();

    // Target size.
    let tw, th;
    if (outputId === 'ico') {
      // Fit into the requested square, but never upscale a small source.
      const size = Math.min(clamp(Math.round(num(options.size, 256)), 1, 256), Math.max(src.width, src.height));
      const fit = Math.min(size / src.width, size / src.height);
      tw = Math.max(1, Math.round(src.width * fit));
      th = Math.max(1, Math.round(src.height * fit));
    } else {
      tw = Math.max(1, Math.round(src.width * scale));
      th = Math.max(1, Math.round(src.height * scale));
    }
    checkSize(tw, th);

    // Draw onto the output canvas (flattening where the format has no alpha).
    const flatten = outputId === 'jpeg' || outputId === 'gif';
    const square = outputId === 'ico' ? Math.max(tw, th) : 0;
    const cw = square || tw, ch = square || th;
    const canvas = makeCanvas(cw, ch);
    const ctx = canvas.getContext('2d');
    if (flatten) { ctx.fillStyle = background; ctx.fillRect(0, 0, cw, ch); }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src.source, square ? Math.floor((cw - tw) / 2) : 0, square ? Math.floor((ch - th) / 2) : 0, tw, th);
    src.close();

    progress(0.4, `Encoding ${out.name}…`);
    checkAbort();
    const pixels = () => ctx.getImageData(0, 0, cw, ch);
    let blob;
    switch (outputId) {
      case 'png':
        blob = await canvasToBlob(canvas, 'image/png');
        break;
      case 'jpeg':
        blob = await canvasToBlob(canvas, 'image/jpeg', q / 100);
        if (blob.type !== 'image/jpeg') throw new Error('This browser cannot encode JPEG.');
        break;
      case 'webp':
        if (await canvasSupports('image/webp')) {
          blob = await canvasToBlob(canvas, 'image/webp', q / 100);
        } else {
          progress(null, 'Encoding WebP…');
          const id = pixels();
          const buf = await runCodec('encode', ['webpEnc', id.data, cw, ch, { quality: q }], [id.data.buffer], signal);
          blob = new Blob([buf], { type: 'image/webp' });
        }
        break;
      case 'avif': {
        progress(null, cw * ch > 4e6 ? 'Encoding AVIF — large image, this can take a while…' : 'Encoding AVIF…');
        const id = pixels();
        // speed 6 is the libavif default; big images get a faster preset so they finish in seconds, not minutes.
        const speed = cw * ch > 8e6 ? 8 : cw * ch > 2e6 ? 7 : 6;
        const buf = await runCodec('encode', ['avifEnc', id.data, cw, ch, { quality: q, speed }], [id.data.buffer], signal);
        blob = new Blob([buf], { type: 'image/avif' });
        break;
      }
      case 'jxl': {
        progress(null, cw * ch > 4e6 ? 'Encoding JPEG XL — large image, this can take a while…' : 'Encoding JPEG XL…');
        const id = pixels();
        // effort 7 (libjxl default) needs ~9 s and close to the wasm memory limit at 12 MP; 3–4 is 6× faster for ~15% larger files.
        const effort = cw * ch > 6e6 ? 3 : cw * ch > 2e6 ? 4 : 7;
        const buf = await runCodec('encode', ['jxlEnc', id.data, cw, ch, { quality: q, effort }], [id.data.buffer], signal);
        blob = new Blob([buf], { type: 'image/jxl' });
        break;
      }
      case 'qoi': {
        const id = pixels();
        const buf = await runCodec('encode', ['qoiEnc', id.data, cw, ch, {}], [id.data.buffer], signal);
        blob = new Blob([buf], { type: 'image/qoi' });
        break;
      }
      case 'gif': {
        progress(null, 'Encoding GIF…');
        const id = pixels();
        const buf = await runCodec('gifEncode', [id.data, cw, ch], [id.data.buffer], signal);
        blob = new Blob([buf], { type: 'image/gif' });
        break;
      }
      case 'tiff': {
        const id = pixels();
        const alpha = hasAlpha(id.data);
        const buf = await runCodec('tiffEncode', [id.data, cw, ch, alpha], [id.data.buffer], signal);
        blob = new Blob([buf], { type: 'image/tiff' });
        break;
      }
      case 'bmp': {
        const id = pixels();
        blob = new Blob([encodeBmp(id.data, cw, ch, hasAlpha(id.data))], { type: 'image/bmp' });
        break;
      }
      case 'ico': {
        const png = await canvasToBlob(canvas, 'image/png');
        blob = new Blob([wrapIco(new Uint8Array(await png.arrayBuffer()), cw, ch)], { type: 'image/x-icon' });
        break;
      }
      default:
        throw new Error(`Cannot write ${outputId} files.`);
    }
    checkAbort();
    progress(1, 'Done');
    return { blob };
  } finally {
    src.close();
  }
}

// Test hooks (file/_dev/image.html) — not part of the engine contract.
export const _test = { runCodec, decodeNative, decodeInput, OPS, CDN };
