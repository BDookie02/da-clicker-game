import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(root, 'tools', 'blockbench', 'output', 'bbmodel', 'dangle_dice.bbmodel');
const outputDir = join(root, 'tools', 'blockbench', 'output', 'prototype');
const outputPath = join(outputDir, 'fuzzy_dice_prototype.bbmodel');
mkdirSync(outputDir, { recursive: true });

const model = JSON.parse(readFileSync(sourcePath, 'utf8'));
model.name = 'Fuzzy Dice — Magenta Prototype';
model.model_identifier = 'fuzzy_dice_prototype';

let serial = 0;
function uuid(name) {
  serial += 1;
  const seed = `${name}:${serial}`;
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const part = (n) => ((h = Math.imul(h ^ n, 16777619)) >>> 0).toString(16).padStart(8, '0');
  return `${part(1)}-${part(2).slice(0, 4)}-${part(3).slice(0, 4)}-${part(4).slice(0, 4)}-${part(5)}${part(6).slice(0, 4)}`;
}

function cube(name, from, to, texture = 0) {
  const face = () => ({ uv: [0, 0, 16, 16], texture });
  return {
    name,
    uuid: uuid(name),
    type: 'cube',
    from,
    to,
    color: 0,
    material_color: texture === 1 ? '#fff6ff' : texture === 2 ? '#292929' : '#d1008f',
    autouv: 0,
    box_uv: true,
    faces: { north: face(), east: face(), south: face(), west: face(), up: face(), down: face() },
  };
}

const additions = [];
// Replace the single blocky cord with a visibly split, centered hanger and knot.
additions.push(cube('prototype_center_knot', [-1.2, -0.8, -0.7], [1.2, 0.4, 0.7], 0));
additions.push(cube('prototype_left_cord', [-3.8, -2.2, -0.35], [-3.2, -0.8, 0.35], 2));
additions.push(cube('prototype_right_cord', [3.2, -2.2, -0.35], [3.8, -0.8, 0.35], 2));

// Three raised top pips make the dice read correctly from the garage and FPV angles.
for (const cx of [-4, 4]) {
  for (const [x, z] of [[cx - 1.7, -1.7], [cx, 0], [cx + 1.7, 1.7]]) {
    additions.push(cube(`prototype_top_pip_${cx}_${x}_${z}`, [x - 0.65, -1.5, z - 0.65], [x + 0.65, -0.45, z + 0.65], 1));
  }
}

// Small alternating edge tufts suggest plush fuzz without turning the silhouette into spikes.
for (const cx of [-4, 4]) {
  const tufts = [
    [-2.8, -1.2, -3.7], [0, -1.2, -3.7], [2.8, -1.2, -3.7],
    [-2.8, -8.8, -3.7], [0, -8.8, -3.7], [2.8, -8.8, -3.7],
    [-3.8, -1.8, 3.7], [-3.8, -5.2, 3.7], [-3.8, -8.2, 3.7],
  ];
  for (const [dx, y, z] of tufts) {
    additions.push(cube(`prototype_fuzz_${cx}_${dx}_${y}_${z}`, [cx + dx - 0.45, y, z - 0.35], [cx + dx + 0.45, y + 0.8, z + 0.35], 0));
  }
}

model.elements.push(...additions);
model.outliner.push(...additions.map((part) => part.uuid));
writeFileSync(outputPath, JSON.stringify(model, null, 2) + '\n');
console.log(outputPath);
