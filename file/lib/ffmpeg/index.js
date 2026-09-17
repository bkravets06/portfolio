// Vendored from @ffmpeg/ffmpeg@0.12.15 (dist/esm/*, MIT, (c) Jerome Wu) so the
// wrapper's Web Worker (worker.js) is same-origin. Only change: const.js points
// CORE_URL at the pinned jsDelivr ESM build of @ffmpeg/core@0.12.10 (the
// engine passes explicit coreURL/wasmURL anyway). The 32 MB core itself is
// never vendored; see file/engines/av.js.
export * from "./classes.js";
export * from "./types.js";
