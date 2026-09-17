// Export glTF / GLB / USDZ samples with Three's own exporters (Node).
// Run from a scratch folder (NOT inside the repo) after:
//   npm init -y && npm install three@0.186.0
//   cp <repo>/file/_dev/gen_samples_three.mjs . && node gen_samples_three.mjs
// Reads cube.obj / torus.obj from file/_dev/samples (run gen_samples.py first).
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';

globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(r => { this.result = r; this.onloadend?.(); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then(r => { this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + Buffer.from(r).toString('base64'); this.onloadend?.(); }); }
};
const OUT = '/Users/benjaminkravets/Desktop/Claude:Codex/Portfolio/file/_dev/samples';
for (const name of ['cube', 'torus']) {
  const group = new OBJLoader().parse(fs.readFileSync(path.join(OUT, name + '.obj'), 'utf8'));
  const scene = new THREE.Scene();
  group.traverse(o => { if (o.isMesh) { o.material = new THREE.MeshStandardMaterial({ color: 0xcccccc }); if (!o.geometry.hasAttribute('normal')) o.geometry.computeVertexNormals(); } });
  scene.add(group);
  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(scene, { binary: true });
  fs.writeFileSync(path.join(OUT, name + '.glb'), Buffer.from(glb));
  const gltf = await exporter.parseAsync(scene, { binary: false });
  fs.writeFileSync(path.join(OUT, name + '.gltf'), JSON.stringify(gltf));
  const usdz = await new USDZExporter().parseAsync(scene);
  fs.writeFileSync(path.join(OUT, name + '.usdz'), Buffer.from(usdz));
  for (const ext of ['glb', 'gltf', 'usdz']) console.log(name + '.' + ext, fs.statSync(path.join(OUT, name + '.' + ext)).size, 'bytes');
}
