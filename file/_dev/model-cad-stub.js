// Test stand-in for file/engines/model-cad.js (same interface, no OpenCascade).
// readCad returns a 10 mm cube MeshSet, writeCad echoes a fake blob describing
// what it received, convertCad echoes the input bytes.  Inject with
//   model._setCadModule(await import('./model-cad-stub.js'))

export const cadFormats = [
  { id: 'step', name: 'STEP', ext: ['step', 'stp'], mime: 'model/step', read: true, write: true, group: 'CAD' },
  { id: 'iges', name: 'IGES', ext: ['iges', 'igs'], mime: 'model/iges', read: true, write: true, group: 'CAD' },
  { id: 'brep', name: 'BREP', ext: ['brep'], mime: 'application/octet-stream', read: true, write: true, group: 'CAD' },
];

export const loadNote = '[stub] Downloads ~50 MB of OpenCascade on first use; cached afterwards.';

export const calls = [];
export let warmups = 0;

export async function warmup() { warmups++; }

export async function readCad(file, inputId, options = {}) {
  calls.push({ fn: 'readCad', inputId, deflection: options.deflection, name: file.name });
  const h = 5;
  const v = [[-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]];
  const f = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
  return {
    units: 'mm',
    meshes: [{ name: 'StubCube', positions: new Float32Array(v.flat()), indices: new Uint32Array(f.flat()) }],
  };
}

export async function writeCad(meshSet, outputId, options = {}) {
  const tris = meshSet.meshes.reduce((n, m) => n + (m.indices ? m.indices.length : m.positions.length / 3) / 3, 0);
  calls.push({ fn: 'writeCad', outputId, bodies: meshSet.meshes.length, triangles: tris, deflection: options.deflection });
  const text = `STUB ${outputId} bodies=${meshSet.meshes.length} triangles=${tris} names=${meshSet.meshes.map((m) => m.name).join('|')}`;
  return { blob: new Blob([text], { type: 'text/plain' }) };
}

export async function convertCad(file, inputId, outputId, options = {}) {
  calls.push({ fn: 'convertCad', inputId, outputId, deflection: options.deflection });
  return { blob: new Blob(['STUB convertCad ' + inputId + '->' + outputId + ' bytes=' + file.size], { type: 'text/plain' }) };
}
