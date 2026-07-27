// Resumable Blockbench-native cosmetic assembly line.
//
// This produces one .bbmodel + texture per shop item. The files are native
// Blockbench projects, so they can be opened/refined there and later exported
// to glTF/GLB without changing the playable build. The state file is written
// after every item; an interrupted run resumes at the next unfinished item.
//
// Usage:
//   npm run assemble:blockbench                 # next batch (5 items)
//   npm run assemble:blockbench -- --all       # finish every item
//   npm run assemble:blockbench -- --reset     # start the queue again
//   npm run assemble:blockbench -- --open-first # open first output in Blockbench

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { Vector3 } from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'public', 'assets', 'cosmetics-assembly.json');
const TOOL_DIR = join(ROOT, 'tools', 'blockbench');
const OUT_DIR = join(TOOL_DIR, 'output');
const MODEL_DIR = join(OUT_DIR, 'bbmodel');
const TEX_DIR = join(OUT_DIR, 'textures');
const STATE_PATH = join(TOOL_DIR, '.assembly-state.json');
const BATCH_SIZE = Number(process.env.BLOCKBENCH_BATCH_SIZE || 5);
const argv = new Set(process.argv.slice(2));

if (!existsSync(MANIFEST)) throw new Error(`Missing manifest: ${MANIFEST}`);
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const items = manifest.items;
if (!Array.isArray(items) || items.length !== 30) throw new Error(`Expected 30 cosmetics, found ${items?.length ?? 0}`);

for (const dir of [TOOL_DIR, OUT_DIR, MODEL_DIR, TEX_DIR]) mkdirSync(dir, { recursive: true });

const initialState = { schema: 1, manifestSchema: manifest.schema, completed: {}, startedAt: new Date().toISOString(), updatedAt: null };
let state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : initialState;
if (argv.has('--reset')) state = initialState;
state.completed ??= {};

function saveState() {
  state.updatedAt = new Date().toISOString();
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, STATE_PATH);
}

function hex(value, fallback = '#9aa0a8') {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return fallback;
  return value.toLowerCase();
}

function shade(value, amount) {
  const color = hex(value, '#8a7a5c');
  const n = Number.parseInt(color.slice(1), 16);
  const channel = (shift) => Math.max(0, Math.min(255, ((n >> shift) & 255) + amount));
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, '0')).join('')}`;
}

function rgba(hexColor, alpha = 1) {
  const n = Number.parseInt(hexColor.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

const ATLAS = new Map([
  ['#d1008f', [0, 0, 16, 16]], ['#e83b9b', [0, 0, 16, 16]], ['#292929', [16, 0, 32, 16]],
  ['#fff6ff', [32, 0, 48, 16]], ['#f23b70', [0, 16, 16, 32]], ['#3bc4ef', [16, 16, 32, 32]],
  ['#f4d35e', [32, 16, 48, 32]], ['#ef6b2f', [48, 16, 64, 32]], ['#69c958', [0, 32, 16, 48]],
  ['#ec72ae', [16, 32, 32, 48]], ['#b8bcc6', [32, 32, 48, 48]], ['#e8c84a', [48, 32, 64, 48]],
  ['#e9d447', [0, 48, 16, 64]], ['#d79b68', [16, 48, 32, 64]], ['#7a4a9e', [32, 48, 48, 64]],
  ['#e8862a', [48, 48, 64, 64]], ['#f2f2f2', [32, 0, 48, 16]], ['#f5f0bd', [32, 0, 48, 16]],
  ['#e8e4d8', [32, 0, 48, 16]], ['#544035', [16, 0, 32, 16]], ['#b8794d', [16, 48, 32, 64]],
  ['#6e4f9b', [32, 48, 48, 64]], ['#e83b3b', [48, 16, 64, 32]],
]);

function atlasUV(color) {
  return ATLAS.get(String(color).toLowerCase()) ?? [0, 0, 16, 16];
}

function uuid(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const s = (n) => ((h = Math.imul(h ^ n, 16777619)) >>> 0).toString(16).padStart(8, '0');
  return `${s(1)}-${s(2).slice(0, 4)}-${s(3).slice(0, 4)}-${s(4).slice(0, 4)}-${s(5)}${s(6).slice(0, 4)}`;
}

function cube(id, name, from, to, color, uv = [0, 0, 16, 16]) {
  const u = uuid(`${id}:${name}`);
  const face = () => ({ uv: atlasUV(color), texture: 0 });
  return {
    name, uuid: u, type: 'cube', from, to, color: 0, material_color: color, autouv: 0, box_uv: true,
    faces: { north: face(), east: face(), south: face(), west: face(), up: face(), down: face() },
  };
}

function meshElement(id, name, vertices, faceIndices, color) {
  const vertexMap = Object.fromEntries(vertices.map((point, index) => [`${name}_v${index}`, point]));
  const faces = {};
  faceIndices.forEach((indices, faceIndex) => {
    const ids = indices.map((index) => `${name}_v${index}`);
    const uv = {};
    ids.forEach((vertexId, index) => { uv[vertexId] = [[0, 0], [16, 0], [16, 16], [0, 16]][index] ?? [0, 0]; });
    faces[`${name}_f${faceIndex}`] = { uv, vertices: ids, texture: 0 };
  });
  return {
    name, uuid: uuid(`${id}:${name}`), type: 'mesh', origin: [0, 0, 0], rotation: [0, 0, 0],
    color: 0, material_color: color, export: true, visibility: true, locked: false,
    render_order: 'default', allow_mirror_modeling: true, vertices: vertexMap, faces,
  };
}

function extrudedPolygonMesh(id, name, outline, depth, color) {
  const front = outline.map(([x, y]) => [x, y, depth / 2]);
  const back = outline.map(([x, y]) => [x, y, -depth / 2]);
  const vertices = [...front, ...back];
  const n = outline.length;
  const faces = [[...Array(n).keys()].reverse(), [...Array(n).keys()].map((i) => n + i)];
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    faces.push([i, next, n + next, n + i]);
  }
  return meshElement(id, name, vertices, faces, color);
}

function prismMesh(id, name, centerY, radiusX, radiusZ, height, color, sides = 8) {
  const vertices = [];
  for (const y of [centerY - height / 2, centerY + height / 2]) {
    for (let i = 0; i < sides; i++) {
      const angle = (Math.PI * 2 * i) / sides + Math.PI / sides;
      vertices.push([Math.cos(angle) * radiusX, y, Math.sin(angle) * radiusZ]);
    }
  }
  const faces = [];
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    faces.push([i, next, sides + next, sides + i]);
  }
  faces.push([...Array(sides).keys()].reverse(), [...Array(sides).keys()].map((i) => sides + i));
  return meshElement(id, name, vertices, faces, color);
}

function frustumMesh(id, name, centerY, bottomX, bottomZ, topX, topZ, height, color, sides = 8) {
  const vertices = [];
  for (const [y, rx, rz] of [[centerY - height / 2, bottomX, bottomZ], [centerY + height / 2, topX, topZ]]) {
    for (let i = 0; i < sides; i++) {
      const angle = (Math.PI * 2 * i) / sides + Math.PI / sides;
      vertices.push([Math.cos(angle) * rx, y, Math.sin(angle) * rz]);
    }
  }
  const faces = [];
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    faces.push([i, next, sides + next, sides + i]);
  }
  faces.push([...Array(sides).keys()].reverse(), [...Array(sides).keys()].map((i) => sides + i));
  return meshElement(id, name, vertices, faces, color);
}

function sphereMesh(id, name, center, radius, color, segments = 10, rings = 5) {
  const [cx, cy, cz] = center;
  const vertices = [];
  for (let ring = 0; ring <= rings; ring++) {
    const phi = (Math.PI * ring) / rings;
    for (let segment = 0; segment < segments; segment++) {
      const theta = (Math.PI * 2 * segment) / segments;
      vertices.push([
        cx + Math.sin(phi) * Math.cos(theta) * radius,
        cy + Math.cos(phi) * radius,
        cz + Math.sin(phi) * Math.sin(theta) * radius,
      ]);
    }
  }
  const faces = [];
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const next = (segment + 1) % segments;
      const a = ring * segments + segment, b = ring * segments + next;
      const c = (ring + 1) * segments + next, d = (ring + 1) * segments + segment;
      faces.push([a, b, c, d]);
    }
  }
  return meshElement(id, name, vertices, faces, color);
}

function beveledBoxMesh(id, name, center, size, bevel, color) {
  const [cx, cy, cz] = center;
  const [w, h, d] = size;
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const points = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    points.push([cx + sx * hx, cy + sy * (hy - bevel), cz + sz * (hz - bevel)]);
    points.push([cx + sx * (hx - bevel), cy + sy * hy, cz + sz * (hz - bevel)]);
    points.push([cx + sx * (hx - bevel), cy + sy * (hy - bevel), cz + sz * hz]);
  }
  const geometry = new ConvexGeometry(points.map((point) => new Vector3(...point)));
  const position = geometry.getAttribute('position');
  const vertices = [];
  for (let index = 0; index < position.count; index++) vertices.push([position.getX(index), position.getY(index), position.getZ(index)]);
  const faces = [];
  for (let index = 0; index < vertices.length; index += 3) faces.push([index, index + 1, index + 2]);
  geometry.dispose();
  return meshElement(id, name, vertices, faces, color);
}

function modelParts(item) {
  const id = item.id;
  const c = hex(item.value, '#8a7a5c');
  const accent = item.slot === 'dangler' ? '#f0d060' : '#24242c';
  const parts = [];
  const add = (name, from, to, color = c) => parts.push(cube(id, name, from, to, color));
  const pixelBox = (name, x, y, z, w, h, d, base, edge = '#24242c', highlight = '#fff6ff') => {
    parts.push(beveledBoxMesh(id, `${name}_shape`, [x, y, z], [w, h, d], Math.min(1, w / 4, h / 4, d / 4), base));
    const x0 = x - w / 2, x1 = x + w / 2, y1 = y + h / 2, z0 = z - d / 2, z1 = z + d / 2;
    add(`${name}_top`, [x0 + 1, y1 - 1.2, z0 + 1], [x1 - 1, y1, z1 - 1], highlight);
    add(`${name}_bottom`, [x0 + 1, y - h / 2, z0 + 1], [x1 - 1, y - h / 2 + 1.2, z1 - 1], edge);
  };
  const pixelBead = (name, y, color, accentColor) => {
    parts.push(beveledBoxMesh(id, `${name}_shape`, [0, y, 0.4], [5.8, 4.2, 5.8], 1, color));
    add(`${name}_top`, [-1.5, y + 1.5, -1.5], [1.5, y + 2.5, 2.5], accentColor);
    add(`${name}_lower`, [-1.5, y - 2.5, -1.5], [1.5, y - 1.5, 2.5], '#24242c');
    add(`${name}_front_glint`, [-1, y - 0.5, 3], [1, y + 0.5, 4], '#fff6ff');
  };
  const pixelDisc = (name, y, color, dark = '#24242c') => {
    const rows = [[-3, 7], [-2, 9], [-1, 11], [0, 11], [1, 9], [2, 7]];
    rows.forEach(([dy, width]) => add(`${name}_row_${dy}`, [-width / 2, y + dy, -3], [width / 2, y + dy + 1, 3], color));
    add(`${name}_edge`, [-4, y - 2, -4], [4, y + 2, -3], dark);
  };
  const quad = (name, x, y, width, height, color, z = 2.1) => parts.push(meshElement(id, name, [
    [x, y, z], [x + width, y, z], [x + width, y + height, z], [x, y + height, z],
  ], [[0, 1, 2, 3]], color));
  const topQuad = (name, x, z, width, height, color, y = 3.1) => parts.push(meshElement(id, name, [
    [x, y, z], [x + width, y, z], [x + width, y, z + height], [x, y, z + height],
  ], [[0, 1, 2, 3]], color));
  const glyphs = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'], D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'], L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'], N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'], P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'], S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'], U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'], Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], 1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  };
  const drawText = (text, color = '#24242c') => {
    const words = String(text).toUpperCase().replace(/[^A-Z0-9 +]/g, '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > 10 && line) { lines.push(line); line = word; } else line = candidate;
    }
    if (line) lines.push(line);
    const maxChars = Math.max(...lines.map((value) => value.length), 1);
    const cell = Math.min(0.72, 22 / (maxChars * 6));
    lines.forEach((value, lineIndex) => {
      const width = value.length * 6 * cell;
      const startX = -width / 2;
      const startZ = -1.0 + lineIndex * 3.2 * cell;
      [...value].forEach((character, charIndex) => {
        const pattern = glyphs[character];
        if (!pattern) return;
        pattern.forEach((row, rowIndex) => [...row].forEach((bit, colIndex) => {
          if (bit === '1') topQuad(`text_${lineIndex}_${charIndex}_${rowIndex}_${colIndex}`, startX + (charIndex * 6 + colIndex) * cell, startZ + rowIndex * cell, cell, cell, color);
        }));
      });
    });
  };

  // Each factory keeps silhouettes recognizable at a small dashboard scale.
  if (item.id === 'dangle_dice') {
    parts.push(beveledBoxMesh(id, 'left_die_shape', [-4, -5, 0], [7, 7, 7], 1, '#d1008f'));
    parts.push(beveledBoxMesh(id, 'right_die_shape', [4, -5, 0], [7, 7, 7], 1, '#d1008f'));
    for (const [name, x, y] of [['left_pip_a', -6, -6], ['left_pip_b', -3, -3], ['right_pip_a', 2, -6], ['right_pip_b', 5, -3]]) add(name, [x, y, 3.5], [x + 1, y + 1, 4.5], '#fff6ff');
    add('left_pip_back', [-6, -6, -4], [-5, -5, -3], '#fff6ff');
    add('right_pip_back', [5, -6, -4], [6, -5, -3], '#fff6ff');
    add('mirror_string', [-0.5, -1, 0], [0.5, 0, 1], '#292929');
  } else if (item.id === 'dangle_beads') {
    for (let i = 0; i < 7; i++) pixelBead(`bead_${i}`, -2 - i * 4, ['#f23b70', '#3bc4ef', '#f4d35e'][i % 3], '#fff6ff');
    add('mirror_string', [-0.5, -1, 0], [0.5, 0, 1], '#292929');
  } else if (item.id === 'dangle_yinyang') {
    parts.push(sphereMesh(id, 'yin_yang_ball', [0, -10, 0], 6.5, '#f2f2f2', 12, 7));
    add('yin_yang_rim', [-5.5, -12, -3.6], [5.5, -8, -3], '#b7b7c4');
    [[-13,2],[-12,4],[-11,5],[-10,5],[-9,4],[-8,3],[-7,2]].forEach(([y,w]) => add(`yin_dark_row_${y}`, [-w, y, 5.2], [0, y + 1, 6.2], '#20202a'));
    add('yin_white_dot', [3, -11, 3], [5, -9, 4], '#fff6ff');
    add('yin_dark_dot', [-4, -8, 3], [-2, -6, 4], '#20202a');
    add('mirror_string', [-0.5, -4, 0], [0.5, 0, 1], '#292929');
  } else if (item.id === 'dangle_fire') {
    parts.push(sphereMesh(id, 'fire_core', [0, -10, 0], 6, '#ef6b2f', 10, 5));
    add('fire_inner', [-3, -13, 3], [3, -8, 5], '#ffe36b');
    add('fire_tip', [-2, -18, -1], [2, -13, 4], '#ffe36b');
    add('fire_tip_red', [-1, -18, -1], [1, -16, 3], '#e83b3b');
    add('mirror_string', [-0.5, -4, 0], [0.5, 0, 1], '#292929');
  } else if (item.id === 'dangle_censored') {
    parts.push(sphereMesh(id, 'pink_novelty_left_ball', [-3.2, -15, 0], 3.5, '#ec72ae', 8, 4));
    parts.push(sphereMesh(id, 'pink_novelty_right_ball', [3.2, -15, 0], 3.5, '#ec72ae', 8, 4));
    pixelBox('pink_novelty_shaft', 0, -10, 0, 5, 10, 5, '#ec72ae', '#9d3f72', '#ffc0df');
    parts.push(sphereMesh(id, 'pink_novelty_head', [0, -4.5, 0], 3.2, '#ec72ae', 8, 4));
    // A single thin, full-depth pixel filter. Because each band spans the
    // entire depth, it reads consistently from the front, side, and rear
    // instead of becoming a floating bar at oblique camera angles.
    [[-17, 1.4, 12], [-13, 1.6, 14], [-9, 1.4, 12], [-5, 1.6, 14], [-1.5, 1.2, 10]].forEach(([y, h, w], index) => {
      add(`censor_filter_band_${index}`, [-w / 2, y, -4.2], [w / 2, y + h, 4.2], '#16161e');
      add(`censor_filter_pixel_${index}`, [-w / 2 + 2, y + 0.35, 4.25], [-w / 2 + 3.2, y + h - 0.35, 4.65], '#6f6f85');
    });
    add('mirror_string', [-0.5, -5, 0], [0.5, 0, 1], '#292929');
  } else if (item.id === 'dangle_testing_coals') {
    pixelBox('coal_left', -4, -6, 0, 7, 7, 7, '#2a2528', '#101016', '#544b51');
    pixelBox('coal_right', 4, -6, 0, 7, 7, 7, '#2a2528', '#101016', '#544b51');
    add('ember_left', [-5, -7, 3.5], [-3, -5, 4.5], '#f06a38');
    add('ember_right', [3, -7, 3.5], [5, -5, 4.5], '#f06a38');
    add('ember_center', [-1, -5, 3.5], [1, -3, 4.5], '#f4d35e');
    add('mirror_string', [-0.5, -3, 0], [0.5, 0, 1], '#292929');
  } else if (item.id === 'dangle_goop') {
    parts.push(sphereMesh(id, 'goop_blob', [0, -6, 0], 6.5, '#69c958', 10, 5));
    add('goop_shadow', [-5, -9, -3.5], [5, -7, -2.5], '#347b3e');
    add('goop_lobe_left', [-6, -10, -1], [-1, -6, 3], '#4da94e');
    add('goop_lobe_right', [1, -10, -1], [6, -6, 3], '#4da94e');
    add('goop_drip_left', [-5, -15, 0], [-3, -9, 3], '#69c958');
    add('goop_drip_center', [-1, -18, 0], [2, -9, 3], '#69c958');
    add('goop_drip_right', [4, -14, 0], [6, -9, 3], '#69c958');
    add('mirror_string', [-0.5, -3, 0], [0.5, 0, 1], '#292929');
  } else if (item.slot === 'roof') {
    pixelBox('taxi_base', 0, 0, 0, 20, 4, 10, '#e9d447', '#a26d22', '#fff0a1');
    pixelBox('taxi_sign', 0, 6, 0, 14, 6, 6, '#f5f0bd', '#a26d22', '#ffffff');
    add('taxi_trim_front', [-7, 8, 2], [7, 9, 3], '#e83b3b');
    add('taxi_trim_back', [-7, 8, -3], [7, 9, -2], '#e83b3b');
    add('taxi_letter_panel', [-4, 4, 3], [4, 7, 4.5], '#e83b3b');
  } else if (item.id === 'horn_sad') {
    // A stepped, extruded pixel silhouette gives the body the unmistakable
    // double-bout violin shape instead of a generic cylinder or cone.
    const violinOutline = [[-2.5,-4],[-4.7,-3],[-5.8,-1],[-5.4,1],[-3.4,2.5],[-3.2,4],[-4.7,5.5],[-4.2,7],[-2.4,8], [0,8.6], [2.4,8], [4.2,7], [4.7,5.5], [3.2,4], [3.4,2.5], [5.4,1], [5.8,-1], [4.7,-3], [2.5,-4], [0,-4.7]];
    parts.push(extrudedPolygonMesh(id, 'violin_body', violinOutline, 6, '#9b5947'));
    quad('violin_body_highlight', -2.8, -2.8, 3.6, 8.6, '#b87355', 3.08);
    quad('violin_body_shadow', 0.8, -3.8, 2.0, 6.3, '#6f352f', 3.09);
    add('violin_tailpiece', [-1.6, -3.2, 2.8], [1.6, -1.2, 3.8], '#24242c');
    add('violin_neck', [-1.2, 7.5, -1.4], [1.2, 17, 1.4], '#5a352b');
    add('violin_fretboard', [-0.8, 9, 1.3], [0.8, 16, 2.2], '#24242c');
    add('violin_bridge', [-2.8, 3.1, 2.5], [2.8, 4.2, 3.3], '#e8c78a');
    quad('violin_f_hole_left', -3.5, 0.3, 1.2, 3, '#24242c', 4.3);
    quad('violin_f_hole_right', 2.3, 0.3, 1.2, 3, '#24242c', 4.3);
    add('violin_string_a', [-0.65, 4, 3.35], [-0.35, 18, 3.75], '#f5f0bd');
    add('violin_string_b', [0.35, 4, 3.35], [0.65, 18, 3.75], '#f5f0bd');
    add('violin_scroll', [-2, 17, 0], [2, 19, 2], '#8a4b3d');
    add('violin_peg_left', [-3.4, 15, 0], [-1.1, 16, 1.4], '#24242c');
    add('violin_peg_right', [1.1, 15, 0], [3.4, 16, 1.4], '#24242c');
  } else if (item.id === 'horn_air') {
    pixelBox('airhorn_body', 0, 0, 0, 12, 5, 6, '#b8bcc6', '#5a5e68', '#f2f4ff');
    add('airhorn_handle', [-2, -5, -2], [2, 1, 2], '#5a5e68');
    parts.push(frustumMesh(id, 'airhorn_bell', 5, 5.5, 5, 2.5, 2.5, 8, '#e9d447', 8));
    add('airhorn_lip', [-6, 8, -5], [6, 10, 5], '#f2f4ff');
    add('airhorn_valve_left', [-4, 2, 3], [-2.5, 5, 4], '#e9d447');
    add('airhorn_valve_right', [2.5, 2, 3], [4, 5, 4], '#e9d447');
  } else if (item.slot === 'goop') {
    pixelBox('goop_surface', 0, 0, 0, 18, 4, 10, c, '#347b3e', '#b0f38c');
    add('goop_lobe_left', [-8, -5, -3], [-1, -1, 3], c);
    add('goop_lobe_right', [1, -5, -3], [8, -1, 3], c);
    add('goop_drip_left', [-7, -10, -2], [-4, -4, 2], c);
    add('goop_drip_center', [-2, -13, -2], [2, -4, 2], c);
    add('goop_drip_right', [4, -9, -2], [7, -4, 2], c);
  } else if (item.slot === 'decal') {
    pixelBox('decal_plate', 0, 0, 0, 28, 6, 2.5, '#e8e4d8', '#24242c', '#ffffff');
    add('decal_shadow', [-12, -3, -1.5], [12, -2, -0.5], '#24242c');
    drawText(item.value, item.id === 'decal_ment' ? '#e83b3b' : '#24242c');
  } else if (item.slot === 'sky') {
    const skyStyles = {
      sky_sunset: ['#b85d5d', '#f7bd6a', '#5d3d73'], sky_vapor: ['#352766', '#ef70d1', '#32d1c5'],
      sky_storm: ['#3c465e', '#a7bdd3', '#1d2638'], sky_noir: ['#302a30', '#d8c398', '#111118'],
      sky_toxic: ['#466d3b', '#d7f05b', '#22452e'], sky_mint: ['#5aa9a9', '#e6f5cf', '#2b777c'],
    };
    const [base, top, low] = skyStyles[item.id] ?? ['#5479a8', '#a6d6ff', '#f5f0bd'];
    pixelBox('sky_panel', 0, 0, 0, 28, 4, 16, base, '#24242c', top);
    add('sky_accent_top', [-10, -4, 7], [10, -2, 8], top);
    add('sky_accent_low', [-7, 1, 7], [7, 2, 8], low);
    add('sky_horizon', [-12, -1, 6.5], [12, 0, 8], low);
    if (item.id === 'sky_vapor' || item.id === 'sky_toxic') {
      add('sky_neon_left', [-11, -3, 7.5], [-9, 1, 8.5], top);
      add('sky_neon_right', [9, -3, 7.5], [11, 1, 8.5], top);
    }
  } else if (item.id === 'orn_napkin') {
    pixelBox('napkin_stack', 0, 1, 0, 12, 2, 8, '#e8e4d8', '#9a9aa5', '#ffffff');
    parts.push(meshElement(id, 'napkin_fold', [[-6, 2, 4], [6, 2, 4], [0, 8, 4], [-6, 5, 4], [6, 5, 4], [0, 8, 4]], [[0, 1, 2], [3, 4, 5]], '#f5f0bd'));
    add('napkin_corner', [-2, 3, 4], [2, 5, 5], '#ffffff');
    topQuad('napkin_pattern_left', -5, -2.5, 4, 5, '#f3a7c6', 2.1);
    topQuad('napkin_pattern_right', 1, -2.5, 4, 5, '#9bc7e8', 2.1);
    topQuad('napkin_fold_line', -0.5, -2.5, 1, 5, '#ffffff', 2.15);
  } else if (item.id === 'orn_cone') {
    pixelBox('cone_base', 0, -1, 0, 14, 3, 11, '#e8862a', '#8e3f19', '#ffc35a');
    parts.push(frustumMesh(id, 'cone_body', 5, 5.5, 4.5, 1.5, 1.5, 12, '#e8862a', 8));
    parts.push(frustumMesh(id, 'cone_band', 5, 4.5, 3.8, 3.2, 2.8, 2.2, '#f4e5c2', 8));
    add('cone_tip', [-1, 10.5, -1], [1, 12, 1], '#e8862a');
    add('cone_reflector_left', [-4.4, 3.4, 3], [-2.2, 4.1, 4], '#fff0a1');
    add('cone_reflector_right', [2.2, 3.4, 3], [4.4, 4.1, 4], '#fff0a1');
  } else if (item.id === 'orn_monk') {
    pixelBox('monk_body', 0, 5, 0, 10, 12, 6, '#e8c84a', '#8b631c', '#fff0a1');
    pixelBox('monk_head', 0, 12, 0, 8, 7, 6, '#d79b68', '#75452e', '#ffd4a3');
    add('monk_hood', [-5, 14, -4], [5, 17, 4], '#6e4f9b');
    add('monk_hood_trim', [-4, 13, 3], [4, 14, 4], '#b58ada');
    quad('monk_eye_left', -3, 12, 1.5, 0.8, '#24242c', 3.1);
    quad('monk_eye_right', 1.5, 12, 1.5, 0.8, '#24242c', 3.1);
    quad('monk_beard', -2.5, 9.5, 5, 1.6, '#75452e', 3.1);
    add('monk_eye_left_back', [-3, 12, -3.2], [-1.5, 13, -2.2], '#24242c');
    add('monk_eye_right_back', [1.5, 12, -3.2], [3, 13, -2.2], '#24242c');
    add('monk_beard_back', [-2.5, 9.5, -3.2], [2.5, 11, -2.2], '#75452e');
    add('monk_sash', [-5, 4, 3], [5, 5, 4], '#b58ada');
    pixelBox('monk_arm_left', -6, 5, 0, 3, 7, 4, '#e8c84a', '#8b631c', '#fff0a1');
    pixelBox('monk_arm_right', 6, 5, 0, 3, 7, 4, '#e8c84a', '#8b631c', '#fff0a1');
    add('monk_bead', [-1, 6, 3], [1, 8, 4], '#6e4f9b');
  } else if (item.id === 'orn_cowboy') {
    pixelBox('cowboy_body', 0, 5, 0, 10, 12, 6, '#7a4a9e', '#432854', '#b987d3');
    pixelBox('cowboy_head', 0, 12, 0, 8, 7, 6, '#b8794d', '#633b2c', '#e5a66e');
    add('cowboy_hat', [-8, 15, -5], [8, 18, 5], '#544035');
    add('cowboy_hat_crown', [-4, 18, -3], [4, 23, 3], '#544035');
    add('cowboy_hat_band', [-4, 17, -4], [4, 18, 4], '#e9d447');
    quad('cowboy_eye_left', -3, 12.5, 1.5, 0.8, '#16161e', 3.1);
    quad('cowboy_eye_right', 1.5, 12.5, 1.5, 0.8, '#16161e', 3.1);
    quad('cowboy_nose', -1, 10.8, 2, 1, '#8d5037', 3.1);
    quad('cowboy_mustache', -2.5, 9.7, 5, 1, '#3c2520', 3.1);
    add('cowboy_eye_left_back', [-3, 12.5, -3.2], [-1.5, 13.5, -2.2], '#16161e');
    add('cowboy_eye_right_back', [1.5, 12.5, -3.2], [3, 13.5, -2.2], '#16161e');
    add('cowboy_nose_back', [-1, 10.8, -3.2], [1, 11.8, -2.2], '#8d5037');
    add('cowboy_mustache_back', [-2.5, 9.7, -3.2], [2.5, 10.7, -2.2], '#3c2520');
    pixelBox('cowboy_arm_left', -6.5, 5, 0, 3, 7, 4, '#7a4a9e', '#432854', '#b987d3');
    pixelBox('cowboy_arm_right', 6.5, 5, 0, 3, 7, 4, '#7a4a9e', '#432854', '#b987d3');
    add('cowboy_ear_left', [-5, 11, -1], [-4, 13, 2], '#b8794d');
    add('cowboy_ear_right', [4, 11, -1], [5, 13, 2], '#b8794d');
    add('cowboy_boot_left', [-3.5, -2, 0], [-0.5, 1, 4], '#544035');
    add('cowboy_boot_right', [0.5, -2, 0], [3.5, 1, 4], '#544035');
    add('cowboy_belt', [-4.5, 2.8, 2.5], [4.5, 4.2, 3.5], '#3c2520');
    add('cowboy_hairline', [-3.5, 14.5, 2.5], [3.5, 16, 3.5], '#3c2520');
    add('cowboy_bandana', [-3.5, 8.5, 2.5], [3.5, 10, 3.5], '#e9d447');
    add('cowboy_buckle', [-1.5, 4, 3], [1.5, 6, 4], '#e9d447');
  } else {
    pixelBox('ornament_body', 0, 5, 0, 12, 12, 8, c, '#24242c', '#fff6ff');
    add('ornament_cap', [-4, 11, -3], [4, 16, 3], accent);
    add('ornament_cap_highlight', [-2, 10, 1], [2, 11, 2], '#fff6ff');
  }
  return parts;
}

function visualColor(item) {
  const named = {
    dangle_dice: '#d1008f', dangle_beads: '#3bc4ef', dangle_yinyang: '#e8e4d8',
    dangle_fire: '#ef6b2f', dangle_censored: '#ec72ae', dangle_testing_coals: '#2a2528',
    dangle_goop: '#69c958', roof_taxi: '#e9d447', horn_sad: '#b8bcc6', horn_air: '#b8bcc6',
  };
  return named[item.id] ?? hex(item.value, '#8a7a5c');
}

async function writeTexture(item) {
  const colors = [...new Set(modelParts(item).map((part) => part.material_color))];
  const textures = [];
  for (let index = 0; index < colors.length; index++) {
    const color = colors[index];
    const light = shade(color, 34);
    const mid = shade(color, 12);
    const dark = shade(color, -34);
    const deep = shade(color, -60);
    // Every material gets a tiny hand-pixelled tile: a lit upper-left edge,
    // stepped shadow, and irregular two-pixel flecks. This keeps the library
    // cohesive with the supplied pixel-art reference instead of flat swatches.
    const flecks = [[4,4],[8,4],[11,7],[5,10],[9,12],[2,7]].map(([x,y], i) =>
      `<rect x="${x}" y="${y}" width="${i % 2 ? 1 : 2}" height="1" fill="${i % 3 ? dark : light}"/>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" shape-rendering="crispEdges"><rect width="16" height="16" fill="${color}"/><rect width="16" height="2" fill="${light}"/><rect y="2" width="2" height="12" fill="${mid}"/><rect x="2" y="2" width="12" height="1" fill="${mid}"/><rect y="14" width="16" height="2" fill="${deep}"/><rect x="14" y="2" width="2" height="12" fill="${dark}"/><rect x="2" y="12" width="12" height="2" fill="${dark}"/>${flecks}<rect x="3" y="3" width="1" height="1" fill="${light}"/></svg>`;
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
    const filename = `${item.id}-${index}.png`;
    await sharp(buffer).toFile(join(TEX_DIR, filename));
    textures.push({
      path: resolve(TEX_DIR, filename), relative_path: `../textures/${filename}`,
      name: filename, folder: '', namespace: '', id: `${item.id}_${index}`,
      width: 16, height: 16, uv_width: 16, uv_height: 16, particle: index === 0,
      source: `data:image/png;base64,${buffer.toString('base64')}`,
    });
  }
  return textures;
}

async function writeModel(item) {
  const parts = modelParts(item);
  if (!parts.length) throw new Error(`${item.id}: no geometry generated`);
  for (const part of parts) {
    if (part.type === 'cube' && (part.from.some(Number.isNaN) || part.to.some(Number.isNaN) || part.to.some((n, i) => n <= part.from[i]))) throw new Error(`${item.id}: invalid cube geometry in ${part.name}`);
    if (part.type === 'mesh' && (!part.vertices || !Object.keys(part.vertices).length || !part.faces || !Object.keys(part.faces).length)) throw new Error(`${item.id}: invalid mesh geometry in ${part.name}`);
  }
  const textures = await writeTexture(item);
  const colorIndex = new Map(modelParts(item).map((part) => part.material_color).filter((color, index, list) => list.indexOf(color) === index).map((color, index) => [color, index]));
  for (const part of parts) {
    for (const face of Object.values(part.faces)) {
      if (part.type === 'cube') face.uv = [0, 0, 16, 16];
      face.texture = colorIndex.get(part.material_color) ?? 0;
    }
  }
  const model = {
    meta: { format_version: '4.10', model_format: 'free', box_uv: true },
    name: item.name,
    model_identifier: item.id,
    resolution: { width: 64, height: 64 },
    textures,
    elements: parts,
    outliner: parts.map((p) => p.uuid),
    display: {},
    animations: [],
    groups: [],
  };
  writeFileSync(join(MODEL_DIR, `${item.id}.bbmodel`), JSON.stringify(model, null, 2) + '\n');
  return { id: item.id, name: item.name, elements: parts.length, model: `bbmodel/${item.id}.bbmodel`, texture: `textures/${item.id}.png` };
}

function launchFirst(file) {
  const exe = join(TOOL_DIR, 'Blockbench_5.1.5_portable.exe');
  if (!existsSync(exe)) return console.warn(`Blockbench executable not found at ${exe}; outputs were still generated.`);
  spawn(exe, [file], { detached: true, stdio: 'ignore' }).unref();
}

const pending = items.filter((item) => !state.completed[item.id]);
const selected = argv.has('--all') ? pending : pending.slice(0, Math.max(1, BATCH_SIZE));
if (!selected.length) {
  console.log(`Blockbench assembly already complete: ${items.length}/${items.length}`);
  process.exit(0);
}

const results = [];
for (const item of selected) {
  try {
    const result = await writeModel(item);
    state.completed[item.id] = { completedAt: new Date().toISOString(), ...result };
    results.push(result);
    saveState();
    console.log(`OK ${item.id}: ${result.elements} elements`);
  } catch (error) {
    state.completed[item.id] = { failedAt: new Date().toISOString(), error: String(error) };
    saveState();
    console.error(`FAILED ${item.id}: ${error}`);
  }
}

const completed = Object.values(state.completed).filter((x) => x.model).length;
const failed = Object.values(state.completed).filter((x) => x.error).length;
writeFileSync(join(OUT_DIR, 'validation.json'), JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), total: items.length, completed, failed, remaining: items.length - completed - failed, results }, null, 2) + '\n');
console.log(`CHECKPOINT ${completed}/${items.length} complete; rerun with --all to finish.`);
if (argv.has('--open-first') && results[0]) launchFirst(join(MODEL_DIR, `${results[0].id}.bbmodel`));
