// Convert the validated Blockbench-native cube projects into import-ready GLB
// files for the Three.js/Capacitor runtime. This is intentionally separate from
// the Android build: GLBs land in tools/blockbench/output/glb until reviewed.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((result) => { this.result = result; this.onloadend?.(); }); }
};

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const modelDir = join(root, 'tools', 'blockbench', 'output', 'bbmodel');
const outDir = join(root, 'tools', 'blockbench', 'output', 'glb');
mkdirSync(outDir, { recursive: true });
if (!existsSync(modelDir)) throw new Error(`Missing Blockbench output directory: ${modelDir}`);

function colorOf(part) {
  const value = part.material_color;
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#b0b0b8';
}

function meshGeometry(part) {
  const geometry = new THREE.BufferGeometry();
  const positions = [];
  const uvs = [];
  for (const face of Object.values(part.faces ?? {})) {
    const ids = face.vertices ?? [];
    for (let i = 1; i < ids.length - 1; i++) {
      for (const id of [ids[0], ids[i], ids[i + 1]]) {
        const point = part.vertices[id];
        if (!point) continue;
        positions.push(point[0] / 16, point[1] / 16, point[2] / 16);
        const uv = face.uv?.[id] ?? [0, 0];
        uvs.push(uv[0] / 16, 1 - uv[1] / 16);
      }
    }
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

function exportOne(file) {
  const source = JSON.parse(readFileSync(join(modelDir, file), 'utf8'));
  const scene = new THREE.Scene();
  scene.name = source.name || file.replace(/\.bbmodel$/, '');
  for (const part of source.elements ?? []) {
    const geometry = part.type === 'mesh'
      ? meshGeometry(part)
      : new THREE.BoxGeometry(...part.to.map((v, i) => (v - part.from[i]) / 16));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: colorOf(part), roughness: 0.78, metalness: 0.05, flatShading: true }));
    mesh.name = part.name;
    if (part.type === 'cube') mesh.position.set(...part.from.map((v, i) => ((v + part.to[i]) / 2) / 16));
    scene.add(mesh);
  }
  const exporter = new GLTFExporter();
  return new Promise((resolveExport, reject) => exporter.parse(scene, (result) => {
    const bytes = Buffer.from(result);
    const out = join(outDir, file.replace(/\.bbmodel$/, '.glb'));
    writeFileSync(out, bytes);
    resolveExport({ file: out, bytes: bytes.length, elements: source.elements?.length ?? 0 });
  }, reject, { binary: true, trs: false, onlyVisible: true }));
}

const files = readdirSync(modelDir).filter((file) => file.endsWith('.bbmodel')).sort();
const results = [];
for (const file of files) results.push(await exportOne(file));
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), count: results.length, files: results }, null, 2) + '\n');
console.log(`exported ${results.length} GLB files -> ${outDir}`);
