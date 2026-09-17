// file/engines/av.js — Audio & Video engine for bjkravets.com/file, backed by ffmpeg.wasm.
//
// Runtime pieces:
//   ../lib/ffmpeg/        vendored @ffmpeg/ffmpeg@0.12.15 ESM wrapper; it spawns a same-origin
//                         module Web Worker (worker.js) that hosts the wasm core.
//   @ffmpeg/core@0.12.10  single-thread core fetched from jsDelivr on first use (ffmpeg-core.js
//                         112 KB + ffmpeg-core.wasm 32.2 MB, ~9 MB brotli on the wire). Both are
//                         turned into blob: URLs (the worker import()s the JS and instantiates the
//                         wasm from them) and stored in the Cache API so later visits skip the download.
//
// Everything at module top level is cheap; the wrapper and the core are loaded lazily.

export const domain = { id: 'av', name: 'Audio & Video' };

const CORE_VERSION = '0.12.10';
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm/`;
const CORE_JS_URL = CORE_BASE + 'ffmpeg-core.js';
const CORE_WASM_URL = CORE_BASE + 'ffmpeg-core.wasm';
const CORE_WASM_BYTES = 32232419;
const CACHE_NAME = `ffmpeg-core-${CORE_VERSION}`;
const MAX_INPUT_BYTES = 1.5 * 1024 * 1024 * 1024;

export const loadNote =
  'Downloads FFmpeg (about 32 MB of WebAssembly, ~9 MB compressed) on first use; it is cached afterwards.';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const sel = (id, label, def, choices, help) => ({
  id, label, type: 'select', default: def,
  choices: choices.map(([value, text]) => ({ value, label: text })),
  ...(help ? { help } : {}),
});

const OPT_RESOLUTION = sel('resolution', 'Resolution', 'keep', [
  ['keep', 'Keep original'], ['2160', '2160p (4K)'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p'],
], 'Shrinks the video so its shorter side is this many pixels; never upscales.');
const OPT_QUALITY = sel('quality', 'Quality', 'medium', [
  ['high', 'High (bigger file)'], ['medium', 'Medium'], ['low', 'Low (smaller file)'],
], 'Constant-quality encoding — the file size follows the content.');
const OPT_FPS = sel('fps', 'Frame rate', 'keep', [
  ['keep', 'Keep original'], ['60', '60 fps'], ['30', '30 fps'], ['24', '24 fps'], ['15', '15 fps'],
]);
const OPT_MUTE = { id: 'mute', label: 'Remove audio', type: 'toggle', default: false };
const OPT_REENCODE = {
  id: 'reencode', label: 'Always re-encode', type: 'toggle', default: false,
  help: 'Off: tracks the new container already supports are copied untouched (seconds instead of minutes, no quality loss); '
      + 'quality and bitrate settings then only apply to tracks that must be re-encoded. On: everything is re-encoded.',
};
const GIF_FPS = sel('fps', 'Frame rate', '10', [['5', '5 fps'], ['10', '10 fps'], ['15', '15 fps'], ['20', '20 fps']]);
const GIF_WIDTH = sel('width', 'Width', '480', [['320', '320 px'], ['480', '480 px'], ['640', '640 px'], ['800', '800 px']],
  'Output width in pixels; never upscales.');
const OPT_BITRATE = sel('bitrate', 'Bitrate', '192', [
  ['320', '320 kbps'], ['256', '256 kbps'], ['192', '192 kbps'], ['128', '128 kbps'], ['96', '96 kbps'],
]);
const OPT_SAMPLERATE = sel('sampleRate', 'Sample rate', 'keep', [
  ['keep', 'Keep original'], ['48000', '48 kHz'], ['44100', '44.1 kHz'], ['22050', '22.05 kHz'],
]);
const OPT_SAMPLERATE_OPUS = { ...OPT_SAMPLERATE, help: 'Opus only supports 48 / 24 kHz: 44.1 kHz becomes 48 kHz and 22.05 kHz becomes 24 kHz.' };
const OPT_CHANNELS = sel('channels', 'Channels', 'keep', [['keep', 'Keep original'], ['stereo', 'Stereo'], ['mono', 'Mono']]);

const VIDEO_OPTS = [OPT_RESOLUTION, OPT_QUALITY, OPT_FPS, OPT_MUTE, OPT_REENCODE];
const GIF_OPTS = [GIF_FPS, GIF_WIDTH];
const LOSSY_AUDIO_OPTS = [OPT_BITRATE, OPT_SAMPLERATE, OPT_CHANNELS, OPT_REENCODE];
const OPUS_AUDIO_OPTS = [OPT_BITRATE, OPT_SAMPLERATE_OPUS, OPT_CHANNELS, OPT_REENCODE];
const LOSSLESS_AUDIO_OPTS = [OPT_SAMPLERATE, OPT_CHANNELS, OPT_REENCODE];

export const options = [];

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

const V = 'Video', A = 'Audio';

export const formats = [
  { id: 'mp4',  name: 'MP4',                ext: ['mp4'],                mime: 'video/mp4',        read: true, write: true, group: V, note: 'H.264 + AAC — plays everywhere',            options: VIDEO_OPTS },
  { id: 'webm', name: 'WebM',               ext: ['webm'],               mime: 'video/webm',       read: true, write: true, group: V, note: 'VP8 + Opus — open web format',  options: VIDEO_OPTS },
  { id: 'mov',  name: 'QuickTime MOV',      ext: ['mov', 'qt'],          mime: 'video/quicktime',  read: true, write: true, group: V, note: 'H.264 + AAC',                               options: VIDEO_OPTS },
  { id: 'mkv',  name: 'Matroska MKV',       ext: ['mkv'],                mime: 'video/x-matroska', read: true, write: true, group: V, note: 'H.264 + AAC; keeps almost any codec as-is',  options: VIDEO_OPTS },
  { id: 'gif',  name: 'Animated GIF',       ext: ['gif'],                mime: 'image/gif',        read: true, write: true, group: V, note: 'No audio; palette-optimised (two passes)',    options: GIF_OPTS },
  { id: 'avi',  name: 'AVI',                ext: ['avi'],                mime: 'video/x-msvideo',  read: true, write: true, group: V, note: 'MPEG-4 + MP3',                              options: VIDEO_OPTS },
  { id: 'm4v',  name: 'M4V',                ext: ['m4v'],                mime: 'video/x-m4v',      read: true, write: true, group: V, note: 'Apple-flavoured MP4, H.264 + AAC',           options: VIDEO_OPTS },
  { id: 'mpeg', name: 'MPEG',               ext: ['mpg', 'mpeg'],        mime: 'video/mpeg',       read: true, write: true, group: V, note: 'MPEG-2 program stream + MP2 audio',          options: VIDEO_OPTS },
  { id: '3gp',  name: '3GP',                ext: ['3gp', '3gpp', '3g2'], mime: 'video/3gpp',       read: true, write: true, group: V, note: 'Mobile; H.264 baseline + AAC',               options: VIDEO_OPTS },
  { id: 'ts',   name: 'MPEG-TS',            ext: ['ts', 'm2ts', 'mts'],  mime: 'video/mp2t',       read: true, write: true, group: V, note: 'Transport stream, H.264 + AAC',              options: VIDEO_OPTS },
  { id: 'flv',  name: 'Flash Video FLV',    ext: ['flv'],                mime: 'video/x-flv',      read: true, write: true, group: V, note: 'H.264 + AAC',                               options: VIDEO_OPTS },
  { id: 'ogv',  name: 'Ogg Video',          ext: ['ogv'],                mime: 'video/ogg',        read: true, write: true, group: V, note: 'Theora + Vorbis',                           options: VIDEO_OPTS },
  { id: 'wmv',  name: 'Windows Media WMV',  ext: ['wmv', 'asf'],         mime: 'video/x-ms-wmv',   read: true, write: true, group: V, note: 'WMV2 + WMA',                                options: VIDEO_OPTS },

  { id: 'mp3',  name: 'MP3',                ext: ['mp3'],                mime: 'audio/mpeg',       read: true, write: true, group: A, note: 'Lossy, universal',                          options: LOSSY_AUDIO_OPTS },
  { id: 'm4a',  name: 'M4A (AAC)',          ext: ['m4a', 'm4b'],         mime: 'audio/mp4',        read: true, write: true, group: A, note: 'AAC in an MP4 container',                   options: LOSSY_AUDIO_OPTS },
  { id: 'aac',  name: 'AAC',                ext: ['aac'],                mime: 'audio/aac',        read: true, write: true, group: A, note: 'Raw AAC stream (ADTS)',                     options: LOSSY_AUDIO_OPTS },
  { id: 'wav',  name: 'WAV',                ext: ['wav', 'wave'],        mime: 'audio/wav',        read: true, write: true, group: A, note: 'Uncompressed 16-bit PCM',                   options: LOSSLESS_AUDIO_OPTS },
  { id: 'flac', name: 'FLAC',               ext: ['flac'],               mime: 'audio/flac',       read: true, write: true, group: A, note: 'Lossless, compressed',                      options: LOSSLESS_AUDIO_OPTS },
  { id: 'ogg',  name: 'Ogg Vorbis',         ext: ['ogg', 'oga'],         mime: 'audio/ogg',        read: true, write: true, group: A, note: 'Lossy, open format',                        options: LOSSY_AUDIO_OPTS },
  { id: 'opus', name: 'Opus',               ext: ['opus'],               mime: 'audio/ogg',        read: true, write: true, group: A, note: 'Lossy; best quality per kbps',              options: OPUS_AUDIO_OPTS },
  { id: 'weba', name: 'WebM audio',         ext: ['weba'],               mime: 'audio/webm',       read: true, write: true, group: A, note: 'Opus in a WebM container',                  options: OPUS_AUDIO_OPTS },
  { id: 'aiff', name: 'AIFF',               ext: ['aiff', 'aif', 'aifc'], mime: 'audio/aiff',      read: true, write: true, group: A, note: 'Uncompressed 16-bit PCM (Apple)',           options: LOSSLESS_AUDIO_OPTS },
  { id: 'wma',  name: 'Windows Media Audio', ext: ['wma'],               mime: 'audio/x-ms-wma',   read: true, write: true, group: A, note: 'WMA v2',                                    options: LOSSY_AUDIO_OPTS },
];

const byId = (id) => formats.find((f) => f.id === id) || null;
const EXT_TO_ID = Object.create(null);
for (const f of formats) if (f.read) for (const e of f.ext) EXT_TO_ID[e] = f.id;
EXT_TO_ID.vob = 'mpeg'; EXT_TO_ID.m2v = 'mpeg'; EXT_TO_ID.mpegts = 'ts'; EXT_TO_ID.f4v = 'flv';

const LOSSLESS = new Set(['wav', 'flac', 'aiff']);

// ---------------------------------------------------------------------------
// detect / targets
// ---------------------------------------------------------------------------

export function detect(file, head) {
  const name = String((file && file.name) || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const byExt = EXT_TO_ID[ext] || null;
  const h = head instanceof Uint8Array ? head : new Uint8Array(0);
  let s = '';
  for (let i = 0; i < Math.min(h.length, 64); i++) s += String.fromCharCode(h[i]);

  if (h.length >= 12 && s.slice(4, 8) === 'ftyp') {                       // ISO base media (MP4 family)
    const brand = s.slice(8, 12);
    if (brand === 'qt  ') return 'mov';
    if (brand === 'M4A ') return 'm4a';
    if (brand === 'M4V ' || brand === 'M4VP' || brand === 'M4VH') return 'm4v';
    if (brand.startsWith('3g')) return '3gp';
    if (['mp4', 'm4v', 'm4a', 'mov', '3gp'].includes(byExt)) return byExt;
    return 'mp4';
  }
  if (s.startsWith('\x1A\x45\xDF\xA3')) {                                   // EBML: Matroska / WebM
    if (s.includes('webm')) return byExt === 'weba' ? 'weba' : 'webm';
    return 'mkv';
  }
  if (s.startsWith('RIFF')) {
    if (s.slice(8, 12) === 'AVI ') return 'avi';
    if (s.slice(8, 12) === 'WAVE') return 'wav';
  }
  if (s.startsWith('OggS')) {
    if (s.includes('theora') || s.includes('OVP8') || s.includes('dirac')) return 'ogv';
    if (s.includes('OpusHead')) return 'opus';
    if (byExt === 'ogv') return 'ogv';
    return 'ogg';                                                          // vorbis / flac / speex in Ogg
  }
  if (s.startsWith('\x30\x26\xB2\x75\x8E\x66\xCF\x11')) return byExt === 'wma' ? 'wma' : 'wmv';   // ASF
  if (s.startsWith('fLaC')) return 'flac';
  if (s.startsWith('FORM') && (s.slice(8, 12) === 'AIFF' || s.slice(8, 12) === 'AIFC')) return 'aiff';
  if (s.startsWith('FLV\x01')) return 'flv';
  if (s.startsWith('GIF87a') || s.startsWith('GIF89a')) return 'gif';
  if (s.startsWith('ID3')) return byExt === 'aac' ? 'aac' : 'mp3';
  if (h.length >= 4 && h[0] === 0 && h[1] === 0 && h[2] === 1 && (h[3] === 0xBA || h[3] === 0xB3)) return 'mpeg';  // PS pack / video sequence header
  if (h.length >= 2 && h[0] === 0xFF && (h[1] & 0xF6) === 0xF0) return 'aac';                  // ADTS sync (layer bits 00)
  if (h.length >= 2 && h[0] === 0xFF && (h[1] & 0xE0) === 0xE0 && ((h[1] >> 1) & 3) !== 0) return 'mp3';   // MPEG audio frame sync
  // Transport streams have no magic beyond the 0x47 sync byte (at 0, or at 4 in M2TS); without it a
  // ".ts" file is more likely TypeScript than MPEG.
  if (['ts', 'm2ts', 'mts', 'mpegts'].includes(ext)) return h.length >= 5 && (h[0] === 0x47 || h[4] === 0x47) ? 'ts' : null;
  return byExt;
}

export function targets(inputId) {
  const inFmt = byId(inputId);
  if (!inFmt || !inFmt.read) return [];
  const video = formats.filter((f) => f.write && f.group === V).map((f) => f.id);
  const audio = formats.filter((f) => f.write && f.group === A).map((f) => f.id);
  const list = inFmt.group === V ? [...video, ...audio] : audio;
  return list.filter((id) => id !== inputId || !LOSSLESS.has(id));       // same-id re-encode only for lossy formats
}

// ---------------------------------------------------------------------------
// Loading ffmpeg.wasm
// ---------------------------------------------------------------------------

let wrapperP = null;      // import() of the vendored wrapper
let coreP = null;         // Promise<{ coreURL, wasmURL }> (blob: URLs, reused when the worker is re-created)
let instanceP = null;     // Promise<FFmpeg>
let instance = null;      // the resolved FFmpeg (for terminate)
let activeJob = null;     // receives log / progress events
let queue = Promise.resolve();
let jobCounter = 0;
const loadWatchers = new Set();

function notifyLoad(fraction, message) {
  for (const w of loadWatchers) { try { w(fraction, message); } catch { /* ignore */ } }
}

const mb = (n) => (n / 1048576).toFixed(1);

async function fetchCoreFile(url, mime, expectedBytes) {
  let cache = null;
  try { if (typeof caches !== 'undefined') cache = await caches.open(CACHE_NAME); } catch { cache = null; }
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) return new Blob([await hit.arrayBuffer()], { type: mime });
    } catch { /* fall through to the network */ }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  let data;
  if (res.body && expectedBytes) {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0, lastReport = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const now = performance.now();                                    // ~10 reports/s, not one per chunk
      if (now - lastReport > 100) { lastReport = now; notifyLoad(null, `Downloading FFmpeg… ${mb(received)} / ${mb(expectedBytes)} MB`); }
    }
    data = new Uint8Array(received);
    let pos = 0;
    for (const c of chunks) { data.set(c, pos); pos += c.length; }
  } else {
    data = new Uint8Array(await res.arrayBuffer());
  }
  if (cache) {
    try { await cache.put(url, new Response(data, { headers: { 'Content-Type': mime, 'Content-Length': String(data.byteLength) } })); }
    catch { /* quota / private mode: the HTTP cache still helps */ }
  }
  return new Blob([data], { type: mime });
}

function getCore() {
  if (!coreP) {
    coreP = (async () => {
      notifyLoad(null, 'Downloading FFmpeg…');
      const [js, wasm] = await Promise.all([
        fetchCoreFile(CORE_JS_URL, 'text/javascript', 0),
        fetchCoreFile(CORE_WASM_URL, 'application/wasm', CORE_WASM_BYTES),
      ]);
      return { coreURL: URL.createObjectURL(js), wasmURL: URL.createObjectURL(wasm) };
    })().catch((e) => {
      coreP = null;
      throw new Error(`Could not download FFmpeg (about 32 MB) — check your connection and try again. (${(e && e.message) || e})`);
    });
  }
  return coreP;
}

function getWrapper() {
  if (!wrapperP) wrapperP = import('../lib/ffmpeg/index.js').catch((e) => { wrapperP = null; throw e; });
  return wrapperP;
}

function getInstance() {
  if (!instanceP) {
    instanceP = (async () => {
      const [{ FFmpeg }, core] = await Promise.all([getWrapper(), getCore()]);
      const ff = new FFmpeg();
      ff.on('log', (e) => { if (activeJob) activeJob.onLog(e); });
      ff.on('progress', (e) => { if (activeJob) activeJob.onProgressEvent(e); });
      notifyLoad(null, 'Starting FFmpeg…');
      await ff.load({ coreURL: core.coreURL, wasmURL: core.wasmURL });
      instance = ff;
      return ff;
    })().catch((e) => {
      instanceP = null; instance = null;
      throw e;
    });
  }
  return instanceP;
}

function dropInstance() {
  const ff = instance;
  instance = null; instanceP = null;
  if (ff) { try { ff.terminate(); } catch { /* ignore */ } }
}

export async function warmup() {
  await getInstance();
}

// ---------------------------------------------------------------------------
// Job bookkeeping: logs, progress
// ---------------------------------------------------------------------------

function fmtTime(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = s - m * 60;
  return m ? `${m}:${r < 10 ? '0' : ''}${r.toFixed(0)}` : `${r.toFixed(1)} s`;
}

class Job {
  constructor(onProgress) {
    this.onProgress = onProgress;
    this.logs = [];
    this.stdout = [];
    this.phase = 'Converting';
    this.range = [0, 1];
    this.duration = 0;
    this.passStart = 0;
    this.aborted = false;
    this.lastReport = 0;
  }
  onLog({ type, message }) {
    if (type === 'stdout') this.stdout.push(message);
    else { this.logs.push(message); if (this.logs.length > 600) this.logs.splice(0, 300); }
  }
  beginPass(phase, range, duration) {
    this.phase = phase; this.range = range; this.duration = duration || 0;
    this.passStart = performance.now();
    this.logs.length = 0;
    this.onProgress(range[0], phase + '…');
  }
  onProgressEvent({ progress, time }) {
    // `time` is the output timestamp in MICROSECONDS (verified: 4017052 for a 4.017 s clip). The first
    // event of a run can carry AV_NOPTS_VALUE (int64 max) before any frame is out — skipped, or the bar
    // would flash 100%. `progress` is the core's own time/duration ratio (NaN / huge when the input
    // duration is unknown); it is only the fallback when ffprobe gave no duration.
    if (!Number.isFinite(time) || time < 0 || time > 1e14) return;
    const secs = time / 1e6;
    let frac = null;
    if (this.duration > 0) frac = secs / this.duration;
    else if (Number.isFinite(progress) && progress >= 0 && progress <= 1.5) frac = progress;
    if (frac != null) frac = Math.max(0, Math.min(1, frac));
    const overall = frac == null ? null : this.range[0] + frac * (this.range[1] - this.range[0]);
    const elapsed = (performance.now() - this.passStart) / 1000;
    const speed = elapsed > 0.4 && Number.isFinite(secs) && secs > 0 ? secs / elapsed : 0;
    let msg = this.phase;
    if (Number.isFinite(secs) && secs >= 0) msg += ` · ${fmtTime(secs)}${this.duration ? ' of ' + fmtTime(this.duration) : ''}`;
    if (speed) msg += ` · ${speed >= 10 ? Math.round(speed) : speed.toFixed(1)}× realtime`;
    this.onProgress(overall, msg);
  }
}

function withLock(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

function cancelled() {
  const e = new Error('Conversion cancelled.');
  e.name = 'AbortError';
  return e;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw cancelled();
}

function raceAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

const errText = (e) => (typeof e === 'string' ? e : (e && e.message) || String(e));

// The wrapper resolves every call with ffmpeg's own return code and only REJECTS when the worker itself
// threw: a wasm trap (RuntimeError: memory access out of bounds), the core's catch block tripping over a
// non-Error exception (TypeError … 'startsWith'), out-of-memory, or terminate(). After any of those the
// instance is suspect, so every rejection is flagged as a crash; the caller drops the worker and retries once.
async function core(promise) {
  try { return await promise; }
  catch (e) {
    const err = new Error(errText(e));
    err.crashed = true;
    throw err;
  }
}

const cleanLine = (l) => String(l).replace(/^\[[^\]]*\]\s*/, '').replace(/^(in|out|pal)\d+\.[a-z0-9]+:\s*/i, '').trim();
const ERR_RE = /error|invalid|not supported|unsupported|could not|couldn't|cannot|can't|unable|failed|unknown|too large|no such|does not|not divisible|not found/i;
const GENERIC_RE = /^(Conversion failed!?|Error (initializing|while|opening|submitting|muxing|during)|Task finished|Terminating thread|Exiting normally|Press \[q\]|Error while decoding|Error while filtering|Nothing was written)/i;

function explainFailure(logs, fallback = 'FFmpeg could not convert this file.') {
  // Every run ends with an 'Aborted()' stderr line (the core traps ffmpeg's exit()); it is never the reason.
  const lines = logs.map(cleanLine).filter((l) => l && !/^\s*(frame=|size=)/.test(l) && !/^Aborted\(/.test(l));
  const specific = [...lines].reverse().find((l) => ERR_RE.test(l) && !GENERIC_RE.test(l));
  const any = specific || [...lines].reverse().find((l) => ERR_RE.test(l)) || lines[lines.length - 1];
  return any ? `FFmpeg could not convert this file: ${any.slice(0, 220)}` : fallback;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

const NOT_MEDIA_FORMATS = new Set(['tty', 'data', 'bin']);
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const ratio = (s) => { if (!s) return 0; const [a, b] = String(s).split('/').map(Number); return b ? a / b : num(a); };

async function probe(ff, job, name, jsonName) {
  job.stdout.length = 0; job.logs.length = 0;
  // The core's ffprobe wrapper never sets Module.ret (it always reports -1), so success is judged by
  // the report itself. The report is written to a MEMFS file rather than scraped from stdout: stdout
  // also carries any other output of the process (verified: after a `-version` run FFmpeg's help log
  // callback stays installed and debug chatter corrupts the JSON). Option globals persist between
  // calls inside one wasm instance, hence the full, explicit option set every time.
  await core(ff.ffprobe(['-v', 'error', '-show_streams', '-show_format', '-of', 'json', name, '-o', jsonName]));
  let json = null;
  try { json = JSON.parse(await core(ff.readFile(jsonName, 'utf8'))); } catch (e) { if (e && e.crashed) throw e; json = null; }
  try { await ff.deleteFile(jsonName); } catch { /* never written */ }
  const streams = (json && json.streams) || [];
  if (!streams.length) {
    const why = [...job.logs].reverse().map(cleanLine).find((l) => l && ERR_RE.test(l));
    throw new Error(`This doesn't look like an audio or video file FFmpeg can read${why ? ` (${why.slice(0, 160)})` : ''}.`);
  }
  const format = (json && json.format) || {};
  // FFmpeg happily "demuxes" plain text (tty: ANSI art as video) and raw bytes (data); those are not media.
  if (NOT_MEDIA_FORMATS.has(String(format.format_name || ''))) {
    throw new Error("This doesn't look like an audio or video file: FFmpeg only sees plain text or raw data in it.");
  }
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)) || null;
  const audio = streams.find((s) => s.codec_type === 'audio') || null;
  const duration = num(format.duration) || (video && num(video.duration)) || (audio && num(audio.duration)) || 0;
  return { video, audio, duration, format, streams };
}

// ---------------------------------------------------------------------------
// Encoding recipes
// ---------------------------------------------------------------------------

// Copy lists are deliberately conservative for the MP4 family: only codecs that browsers and phones play
// (an Xvid AVI remuxed into MP4 would be a valid file that nothing plays). MKV copies almost anything.
const MP4_V = ['h264', 'hevc'];
const MP4_A = ['aac', 'mp3'];
const ANY_V = ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mpeg2video', 'mpeg1video', 'theora', 'mjpeg', 'wmv1', 'wmv2', 'wmv3', 'vc1', 'msmpeg4v3', 'msmpeg4v2', 'h263', 'flv1', 'prores', 'dnxhd'];
const ANY_A = ['aac', 'mp3', 'mp2', 'opus', 'vorbis', 'flac', 'ac3', 'eac3', 'dts', 'alac', 'truehd', 'wmav1', 'wmav2', 'wmapro',
  'pcm_s16le', 'pcm_s16be', 'pcm_s24le', 'pcm_s24be', 'pcm_s32le', 'pcm_f32le', 'pcm_u8'];

const VIDEO_RECIPES = {
  mp4:  { muxer: 'mp4',      video: 'libx264',    audio: 'aac',        copyV: MP4_V, copyA: MP4_A, extra: ['-movflags', '+faststart'] },
  m4v:  { muxer: 'ipod',     video: 'libx264',    audio: 'aac',        copyV: MP4_V, copyA: [...MP4_A, 'alac'], extra: ['-movflags', '+faststart'] },
  mov:  { muxer: 'mov',      video: 'libx264',    audio: 'aac',        copyV: [...MP4_V, 'mjpeg', 'prores', 'dnxhd'], copyA: [...MP4_A, 'pcm_s16le', 'pcm_s16be', 'pcm_s24le', 'pcm_s24be'], extra: ['-movflags', '+faststart'] },
  mkv:  { muxer: 'matroska', video: 'libx264',    audio: 'aac',        copyV: ANY_V, copyA: ANY_A },
  // libvpx-vp9 crashes in this core build (RuntimeError: memory access out of bounds on the first frame;
  // verified here with -deadline realtime/good, -threads 1 -row-mt 0 -tile-columns 0 -lag-in-frames 0
  // -auto-alt-ref 0, with and without audio), so WebM is written with VP8 (1.75x realtime for 720p).
  // VP9 input still decodes fine.
  webm: { muxer: 'webm',     video: 'libvpx',     audio: 'libopus',    copyV: ['vp8', 'vp9', 'av1'], copyA: ['opus', 'vorbis'] },
  avi:  { muxer: 'avi',      video: 'mpeg4',      audio: 'libmp3lame', copyV: ['mpeg4', 'msmpeg4v3', 'msmpeg4v2', 'mjpeg'], copyA: ['mp3', 'ac3', 'pcm_s16le', 'mp2', 'wmav2'] },
  mpeg: { muxer: 'vob',      video: 'mpeg2video', audio: 'mp2',        copyV: ['mpeg2video', 'mpeg1video'], copyA: ['mp2', 'mp3', 'ac3'] },
  '3gp': { muxer: '3gp',     video: 'libx264',    audio: 'aac',        copyV: ['h264', 'h263', 'mpeg4'], copyA: ['aac', 'amr_nb', 'amr_wb'] },
  ts:   { muxer: 'mpegts',   video: 'libx264',    audio: 'aac',        copyV: ['h264', 'hevc', 'mpeg2video', 'mpeg1video'], copyA: ['aac', 'mp3', 'mp2', 'ac3', 'eac3'] },
  flv:  { muxer: 'flv',      video: 'libx264',    audio: 'aac',        copyV: ['h264'], copyA: ['aac'] },
  ogv:  { muxer: 'ogg',      video: 'libtheora',  audio: 'libvorbis',  copyV: ['theora'], copyA: ['vorbis', 'opus', 'flac'] },
  wmv:  { muxer: 'asf',      video: 'wmv2',       audio: 'wmav2',      copyV: ['wmv1', 'wmv2', 'wmv3', 'vc1', 'msmpeg4v3', 'mpeg4'], copyA: ['wmav1', 'wmav2', 'wmapro', 'mp3'] },
};

const AUDIO_RECIPES = {
  mp3:  { muxer: 'mp3',  codec: 'libmp3lame', lossy: true, copy: ['mp3'], maxCh: 2 },
  m4a:  { muxer: 'ipod', codec: 'aac',        lossy: true, copy: ['aac', 'alac'] },
  aac:  { muxer: 'adts', codec: 'aac',        lossy: true, copy: ['aac'] },
  wav:  { muxer: 'wav',  codec: 'pcm_s16le',  lossy: false, copy: ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8'] },
  flac: { muxer: 'flac', codec: 'flac',       lossy: false, copy: ['flac'] },
  ogg:  { muxer: 'ogg',  codec: 'libvorbis',  lossy: true, copy: ['vorbis', 'flac'] },
  opus: { muxer: 'opus', codec: 'libopus',    lossy: true, copy: ['opus'] },
  weba: { muxer: 'webm', codec: 'libopus',    lossy: true, copy: ['opus', 'vorbis'] },
  aiff: { muxer: 'aiff', codec: 'pcm_s16be',  lossy: false, copy: ['pcm_s16be', 'pcm_s24be', 'pcm_s8'] },
  wma:  { muxer: 'asf',  codec: 'wmav2',      lossy: true, copy: ['wmav2', 'wmav1', 'wmapro'], maxCh: 2 },
};

const OPUS_RATES = [48000, 24000, 16000, 12000, 8000];
// libopus in this core build traps ("memory access out of bounds") when it encodes STEREO at 48 kHz with
// its default complexity 10 — measured in this session: every complexity >= 5 crashes, <= 4 works; mono and
// 5.1 are fine at 10, and stereo at 24 kHz is fine too. Complexity only trades CPU for a little quality,
// so every libopus encode runs at 4.
const OPUS_ARGS = ['-c:a', 'libopus', '-compression_level', '4'];
const MP2_RATES = [48000, 44100, 32000, 24000, 22050, 16000];
const MPEG_FPS = [24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60];
const CRF_X264 = { high: '18', medium: '23', low: '28' };
const CRF_VP9 = { high: '28', medium: '33', low: '38' };
const QSCALE = { high: '3', medium: '5', low: '8' };
const BPP = { high: 0.16, medium: 0.1, low: 0.06 };   // bits per pixel per frame, for bitrate-driven codecs

function frameRate(v) {
  return ratio(v.avg_frame_rate) || ratio(v.r_frame_rate) || 30;
}

function outputDims(v, opt) {
  let w = num(v.width) || 0, h = num(v.height) || 0;
  if (w && h && opt.resolution !== 'keep') {
    const target = Number(opt.resolution);
    const short = Math.min(w, h);
    if (short > target) { const k = target / short; w = Math.round(w * k); h = Math.round(h * k); }
  }
  return { w, h };
}

function videoFilters(rec, v, opt) {
  const vf = [];
  let fps = opt.fps !== 'keep' ? Number(opt.fps) : frameRate(v);
  if (opt.fps !== 'keep') vf.push(`fps=${opt.fps}`);
  if (rec.video === 'mpeg2video' && !MPEG_FPS.some((f) => Math.abs(f - fps) < 0.01)) {
    const pick = [24, 25, 30, 50, 60].reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a));
    vf.push(`fps=${pick}`);
    fps = pick;
  }
  if (opt.resolution !== 'keep') {
    const t = Number(opt.resolution);
    // Shorter side -> t (portrait-aware, never upscales), other side keeps the aspect ratio, both even.
    vf.push(`scale=w='if(gt(iw,ih),-2,2*trunc(min(${t},iw)/2))':h='if(gt(iw,ih),2*trunc(min(${t},ih)/2),-2)'`);
  } else if ((num(v.width) % 2) || (num(v.height) % 2)) {
    vf.push('crop=trunc(iw/2)*2:trunc(ih/2)*2');                       // 4:2:0 encoders need even dimensions
  }
  return { vf, fps };
}

function videoEncodeArgs(rec, v, opt, outId) {
  const q = opt.quality;
  const { vf, fps } = videoFilters(rec, v, opt);
  const { w, h } = outputDims(v, opt);
  const kbps = Math.max(250, Math.min(20000, Math.round((w * h * fps * BPP[q]) / 1000))) || 2000;
  const args = [];
  if (vf.length) args.push('-vf', vf.join(','));
  switch (rec.video) {
    case 'libx264':
      // 10 s 720p clip, single-thread wasm: veryfast 7.6 s / 3.0 MB, superfast 4.9 s / 5.4 MB,
      // ultrafast 2.5 s / 8.4 MB at crf 23. veryfast keeps files sane; the CRF carries the quality choice.
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', CRF_X264[q]);
      if (outId === '3gp') args.push('-profile:v', 'baseline', '-level', '3.1');
      break;
    case 'libvpx-vp9':
      args.push('-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-crf', CRF_VP9[q], '-b:v', '0');
      break;
    case 'libvpx':
      args.push('-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', `${kbps}k`, '-crf', { high: '8', medium: '12', low: '18' }[q]);
      break;
    case 'libtheora':
      args.push('-c:v', 'libtheora', '-q:v', { high: '8', medium: '6', low: '4' }[q]);
      break;
    case 'mpeg4':
      args.push('-c:v', 'mpeg4', '-q:v', QSCALE[q]);
      break;
    case 'mpeg2video':
      args.push('-c:v', 'mpeg2video', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`);
      break;
    case 'wmv2':
      args.push('-c:v', 'wmv2', '-b:v', `${kbps}k`);
      break;
    default:
      args.push('-c:v', rec.video);
  }
  args.push('-pix_fmt', 'yuv420p');
  return args;
}

function audioArgsForVideo(rec, a) {
  const base = {
    aac: ['-c:a', 'aac', '-b:a', '128k'],
    libopus: [...OPUS_ARGS, '-b:a', '96k'],
    libvorbis: ['-c:a', 'libvorbis', '-q:a', '4'],
    libmp3lame: ['-c:a', 'libmp3lame', '-b:a', '128k'],
    mp2: ['-c:a', 'mp2', '-b:a', '192k'],
    wmav2: ['-c:a', 'wmav2', '-b:a', '128k'],
  }[rec.audio] || ['-c:a', rec.audio];
  const args = [...base];
  const ch = num(a.channels) || 2, sr = num(a.sample_rate) || 44100;
  if (ch > 2 && rec.audio !== 'aac') args.push('-ac', '2');
  if (rec.audio === 'libopus' && !OPUS_RATES.includes(sr)) args.push('-ar', '48000');
  if (rec.audio === 'mp2' && !MP2_RATES.includes(sr)) args.push('-ar', '48000');
  return args;
}

function audioEncodeArgs(rec, a, opt) {
  const args = rec.codec === 'libopus' ? [...OPUS_ARGS] : ['-c:a', rec.codec];
  if (rec.lossy) args.push('-b:a', `${opt.bitrate}k`);
  const ch = num(a.channels) || 2, sr = num(a.sample_rate) || 44100;
  let rate = opt.sampleRate !== 'keep' ? Number(opt.sampleRate) : 0;
  if (rec.codec === 'libopus') {
    if (rate && !OPUS_RATES.includes(rate)) rate = rate > 30000 ? 48000 : 24000;
    if (!rate && !OPUS_RATES.includes(sr)) rate = 48000;
  }
  if (rate) args.push('-ar', String(rate));
  if (opt.channels === 'stereo') args.push('-ac', '2');
  else if (opt.channels === 'mono') args.push('-ac', '1');
  else if (rec.maxCh && ch > rec.maxCh) args.push('-ac', String(rec.maxCh));
  return args;
}

function withDefaults(fmt, options) {
  const out = {};
  for (const o of [...(fmt.options || []), ...options_defaults()]) {
    const raw = options && options[o.id];
    if (o.type === 'toggle') out[o.id] = raw == null ? !!o.default : !!raw;
    else if (o.type === 'select') out[o.id] = raw == null ? String(o.default) : String(raw);
    else out[o.id] = raw == null ? o.default : Number(raw);
  }
  return out;
}
const options_defaults = () => options;

// Builds the ffmpeg passes for one conversion.
function buildPlan(info, inFmt, outFmt, opt, names) {
  const { inName, outName, palName } = names;
  const v = info.video, a = info.audio;
  const sameId = !!inFmt && inFmt.id === outFmt.id;
  const common = ['-hide_banner', '-i', inName];

  if (outFmt.id === 'gif') {
    if (!v) throw new Error('This file has no video track, so it cannot become a GIF.');
    const chain = `fps=${opt.fps},scale='min(${opt.width},iw)':-1:flags=lanczos`;
    return [
      { phase: 'Building GIF palette (pass 1 of 2)', range: [0, 0.5],
        args: [...common, '-map', `0:${v.index}`, '-vf', `${chain},palettegen`, '-update', '1', '-frames:v', '1', '-f', 'image2', palName] },
      { phase: 'Rendering GIF (pass 2 of 2)', range: [0.5, 1],
        args: [...common, '-i', palName, '-filter_complex', `[0:${v.index}]${chain}[x];[x][1:v]paletteuse`, '-an', '-loop', '0', '-f', 'gif', outName] },
    ];
  }

  if (outFmt.group === A) {
    const rec = AUDIO_RECIPES[outFmt.id];
    if (!a) throw new Error('This file has no audio track.');
    const copy = !opt.reencode && !sameId && opt.sampleRate === 'keep' && opt.channels === 'keep' && rec.copy.includes(a.codec_name);
    const args = [...common, '-map', `0:${a.index}`, '-vn', ...(copy ? ['-c:a', 'copy'] : audioEncodeArgs(rec, a, opt)), '-f', rec.muxer, outName];
    return [{ phase: copy ? 'Extracting audio' : 'Encoding audio', range: [0, 1], args }];
  }

  const rec = VIDEO_RECIPES[outFmt.id];
  const wantAudio = !!a && !opt.mute;
  if (!v && !wantAudio) {
    throw new Error(a ? 'This file has no video track and audio was removed — nothing left to convert.' : 'No audio or video track was found in this file.');
  }
  const args = [...common];
  let copyV = false, copyA = false;
  if (v) {
    args.push('-map', `0:${v.index}`);
    copyV = !opt.reencode && !sameId && opt.resolution === 'keep' && opt.fps === 'keep' && rec.copyV.includes(v.codec_name);
    if (copyV) {
      args.push('-c:v', 'copy');
      // Apple players only recognise HEVC in MP4/MOV under the 'hvc1' tag (FFmpeg defaults to 'hev1').
      if (v.codec_name === 'hevc' && ['mp4', 'mov', 'ipod'].includes(rec.muxer)) args.push('-tag:v', 'hvc1');
    } else {
      args.push(...videoEncodeArgs(rec, v, opt, outFmt.id));
    }
  } else {
    args.push('-vn');
  }
  if (wantAudio) {
    args.push('-map', `0:${a.index}`);
    copyA = !opt.reencode && rec.copyA.includes(a.codec_name);
    if (copyA) args.push('-c:a', 'copy');
    else args.push(...audioArgsForVideo(rec, a));
  } else {
    args.push('-an');
  }
  if (rec.extra) args.push(...rec.extra);
  args.push('-max_muxing_queue_size', '4096', '-f', rec.muxer, outName);
  const phase = v && !copyV ? 'Encoding video' : (copyV && (copyA || !wantAudio)) ? 'Copying tracks into the new container' : 'Converting';
  return [{ phase, range: [0, 1], args }];
}

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

function safeExt(name, inFmt) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  return (m ? m[1].toLowerCase() : null) || (inFmt && inFmt.ext[0]) || 'bin';
}

export function convert(req) {
  return withLock(async () => {
    try {
      return await doConvert(req);
    } catch (e) {
      // A wasm-level crash (trap / abort) leaves nothing to recover in the old worker; doConvert has
      // already dropped it. Retry once on a fresh instance before giving up — these crashes are
      // state-dependent and usually do not repeat.
      if (e && e.crashed && !(req.signal && req.signal.aborted)) return doConvert(req);
      throw e;
    }
  });
}

async function doConvert({ file, inputId, outputId, options: userOptions, onProgress, signal }) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const outFmt = byId(outputId);
  const inFmt = byId(inputId);
  if (!outFmt || !outFmt.write) throw new Error(`"${outputId}" is not a format this converter can write.`);
  if (!file) throw new Error('No file was given.');
  if (!file.size) throw new Error('This file is empty.');
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(`This file is ${(file.size / 1073741824).toFixed(1)} GB; in-browser conversion handles files up to about 1.5 GB. Try a shorter or smaller clip.`);
  }
  throwIfAborted(signal);
  const opt = withDefaults(outFmt, userOptions || {});

  loadWatchers.add(report);
  let ff;
  try { ff = await raceAbort(getInstance(), signal); }
  finally { loadWatchers.delete(report); }

  const id = ++jobCounter;
  const names = { inName: `in${id}.${safeExt(file.name, inFmt)}`, outName: `out${id}.${outFmt.ext[0]}`, palName: `pal${id}.png`, probeName: `probe${id}.json` };
  const job = new Job(report);
  const onAbort = () => { job.aborted = true; dropInstance(); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  activeJob = job;
  let wrote = false;
  try {
    report(null, 'Reading file…');
    const data = new Uint8Array(await file.arrayBuffer());
    throwIfAborted(signal);
    await core(ff.writeFile(names.inName, data));
    wrote = true;
    report(null, 'Analysing…');
    const info = await probe(ff, job, names.inName, names.probeName);
    const passes = buildPlan(info, inFmt, outFmt, opt, names);
    for (const pass of passes) {
      job.beginPass(pass.phase, pass.range, info.duration);
      const ret = await core(ff.exec(pass.args));
      if (ret !== 0) throw new Error(explainFailure(job.logs));
    }
    const out = await core(ff.readFile(names.outName));
    if (!(out instanceof Uint8Array) || !out.length) throw new Error('FFmpeg produced an empty file.');
    report(1, 'Done');
    return { blob: new Blob([out], { type: outFmt.mime }) };
  } catch (e) {
    if (job.aborted || (signal && signal.aborted)) throw cancelled();
    if (e && e.crashed) {
      dropInstance();
      const text = errText(e);
      const err = /Cannot enlarge memory|OOM|out of memory|allocation failed|Array buffer allocation/i.test(text)
        ? new Error('Ran out of memory while converting this file. In-browser conversion tops out around 1 GB of input; try a smaller file or a lower resolution.')
        : new Error(`FFmpeg crashed while converting this file (${text.slice(0, 160)}). Please try again or use a smaller file.`);
      err.crashed = true;
      throw err;
    }
    if (e instanceof Error) throw e;
    throw new Error(`FFmpeg could not convert this file: ${errText(e).slice(0, 220)}`);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    activeJob = null;
    if (instance === ff && wrote) {
      for (const n of Object.values(names)) { try { await ff.deleteFile(n); } catch { /* not created */ } }
    }
  }
}

// ---------------------------------------------------------------------------
// Dev helpers (used by file/_dev/av.html; not part of the engine contract)
// ---------------------------------------------------------------------------

export const _internals = {
  load: getInstance,
  drop: dropInstance,
  coreURLs: { js: CORE_JS_URL, wasm: CORE_WASM_URL },
  explain: explainFailure,
  // Run raw ffmpeg args; resolves { ret, logs, stdout }.
  exec: (args) => withLock(async () => {
    const ff = await getInstance();
    const job = new Job(() => {});
    activeJob = job;
    try { const ret = await ff.exec(args); return { ret, logs: job.logs.slice(), stdout: job.stdout.slice() }; }
    finally { activeJob = null; }
  }),
  // Write a blob into MEMFS, ffprobe it, and summarise what FFmpeg sees.
  probeBlob: (blob, name = 'probe.bin') => withLock(async () => {
    const ff = await getInstance();
    const job = new Job(() => {});
    activeJob = job;
    const fname = `verify_${++jobCounter}_${name.replace(/[^a-z0-9._-]/gi, '_')}`;
    try {
      await ff.writeFile(fname, new Uint8Array(await blob.arrayBuffer()));
      const info = await probe(ff, job, fname, fname + '.json');
      const parts = [info.format.format_name];
      for (const s of info.streams) {
        if (s.codec_type === 'video') parts.push(`video ${s.codec_name} ${s.width}x${s.height} ${ratio(s.avg_frame_rate).toFixed(2)}fps ${s.pix_fmt || ''}`.trim());
        else if (s.codec_type === 'audio') parts.push(`audio ${s.codec_name} ${s.sample_rate}Hz ${s.channels}ch${s.bit_rate ? ' ' + Math.round(s.bit_rate / 1000) + 'kbps' : ''}`);
        else parts.push(s.codec_type + ' ' + s.codec_name);
      }
      parts.push(`${info.duration.toFixed(2)}s`);
      return { summary: parts.join(' | '), duration: info.duration, streams: info.streams.map((s) => ({ type: s.codec_type, codec: s.codec_name, tag: s.codec_tag_string, attached_pic: s.disposition && s.disposition.attached_pic, width: s.width, height: s.height, fps: ratio(s.avg_frame_rate), sample_rate: s.sample_rate, channels: s.channels, bit_rate: s.bit_rate })), format: info.format.format_name };
    } catch (e) {
      return { error: errText(e) };
    } finally {
      activeJob = null;
      try { await ff.deleteFile(fname); } catch { /* ignore */ }
    }
  }),
};
