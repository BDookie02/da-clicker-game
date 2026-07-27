// Deterministic cosmetic assembly line.
//
// This step validates every shop item against the authored runtime factories
// and emits the manifest consumed by the Blender assembly and release QA.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const config = readFileSync('src/config.ts', 'utf8');
const scene = readFileSync('src/scene.ts', 'utf8');
const items = [...config.matchAll(/\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)',\s*desc:\s*'([^']+)',\s*cost:\s*(\d+),\s*slot:\s*'([^']+)',\s*value:\s*'([^']+)'\s*\}/g)]
  .map(([, id, name, desc, cost, slot, value]) => ({ id, name, desc, cost: Number(cost), slot, value }));

if (items.length === 0) throw new Error('No cosmetic definitions found in src/config.ts');
if (new Set(items.map((x) => x.id)).size !== items.length) throw new Error('Duplicate cosmetic id found');
const requiredFactories = [
  'makeFuzzyDice', 'makeDashboardItem', 'makeDangler', 'addRearViewMirror',
  'setDashboardItems', 'setGarageCosmetics',
];
const missing = requiredFactories.filter((name) => !scene.includes(name));
if (missing.length) throw new Error(`Missing runtime factories: ${missing.join(', ')}`);
if (items.filter((x) => x.slot === 'dash').length > 6) throw new Error('Dashboard exceeds six fixed slots');
const danglerStyles = new Set(['dice', 'beads', 'yinyang', 'fire', 'censored', 'testing_coals', 'goop']);
for (const item of items.filter((x) => x.slot === 'dangler')) {
  if (!danglerStyles.has(item.value)) throw new Error(`No dangler factory style for ${item.id}: ${item.value}`);
}
const supportedSlots = new Set(['ornament', 'decal', 'goop', 'sky', 'horn', 'dash', 'dangler', 'roof']);
for (const item of items) {
  if (!supportedSlots.has(item.slot)) throw new Error(`Unsupported cosmetic slot for ${item.id}: ${item.slot}`);
}

mkdirSync('public/assets', { recursive: true });
const manifest = {
  schema: 2,
  generatedAt: new Date().toISOString(),
  source: 'blender-cosmetic-assembly-line',
  placement: {
    dashboardSlots: 6,
    dashboardSurface: 'shared tap-FPV and garage mount coordinates',
    mirror: 'centered on windshield roof anchor',
    danglers: 'child of rear-view mirror, shared scale in tap-FPV and garage',
  },
  items,
};
writeFileSync('public/assets/cosmetics-assembly.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`assembled ${items.length} cosmetics -> public/assets/cosmetics-assembly.json`);
