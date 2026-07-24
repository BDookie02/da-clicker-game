import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  numericOption,
  option,
  readCosmeticsFromConfig,
} from '../scripts/lib/android-visual-qa.mjs';

const root = resolve(import.meta.dirname, '..');
const cosmeticsScript = readFileSync(
  join(root, 'scripts', 'audit-android-cosmetics-cdp.mjs'),
  'utf8',
);
const ugcScript = readFileSync(
  join(root, 'scripts', 'audit-android-ugc-responsive-cdp.mjs'),
  'utf8',
);
const touchScript = readFileSync(
  join(root, 'scripts', 'audit-android-touch-look.mjs'),
  'utf8',
);
const tapCosmeticsScript = readFileSync(
  join(root, 'scripts', 'audit-android-tap-cosmetics-cdp.mjs'),
  'utf8',
);
const responsiveScript = readFileSync(
  join(root, 'scripts', 'audit-responsive-ui.mjs'),
  'utf8',
);
const tutorialFlowScript = readFileSync(
  join(root, 'scripts', 'audit-android-tutorial-flow.mjs'),
  'utf8',
);
const sceneSource = readFileSync(join(root, 'src', 'scene.ts'), 'utf8');

test('visual-QA options reject missing and invalid values', () => {
  assert.equal(option('--out', 'fallback', []), 'fallback');
  assert.equal(option('--out', 'fallback', ['--out', 'captures']), 'captures');
  assert.throws(() => option('--out', null, ['--out']), /requires a value/);
  assert.equal(numericOption('--port', 9222, []), 9222);
  assert.equal(numericOption('--port', 9222, ['--port', '9333']), 9333);
  assert.throws(
    () => numericOption('--port', 9222, ['--port', 'not-a-port']),
    /valid TCP port/,
  );
});

test('cosmetics parser discovers every current market visual and supported context', () => {
  const cosmetics = readCosmeticsFromConfig(join(root, 'src', 'config.ts'));
  assert.equal(
    cosmetics.length,
    29,
    'COSMETICS changed; review and update the exact-emulator audit contract',
  );
  assert.equal(new Set(cosmetics.map(({ id }) => id)).size, cosmetics.length);
  assert.deepEqual(
    Object.fromEntries(
      [...new Set(cosmetics.map(({ slot }) => slot))]
        .sort()
        .map((slot) => [slot, cosmetics.filter((item) => item.slot === slot).length]),
    ),
    {
      dangler: 7,
      decal: 4,
      goop: 5,
      horn: 2,
      ornament: 4,
      roof: 1,
      sky: 6,
    },
  );
  for (const cosmetic of cosmetics) {
    assert.equal(typeof cosmetic.name, 'string');
    assert.equal(typeof cosmetic.desc, 'string');
    assert.equal(typeof cosmetic.value, 'string');
    assert.equal(typeof cosmetic.cost, 'number');
  }
});

test('cosmetic audit is fail-closed and captures every parsed item in its real context', () => {
  assert.match(cosmeticsScript, /numericOption\('--port', 9222\)/);
  assert.match(cosmeticsScript, /readCosmeticsFromConfig\(join\(root, 'src', 'config\.ts'\)\)/);
  assert.match(cosmeticsScript, /for \(const \[index, cosmetic\] of auditCases\.entries\(\)\)/);
  assert.match(cosmeticsScript, /scene\.cosmeticSource/);
  assert.match(cosmeticsScript, /scene\.resetTapLook/);
  assert.match(cosmeticsScript, /goopGroup\?\.children\?\.length >= 44/);
  assert.match(cosmeticsScript, /garage-first-person-dashboard/);
  assert.match(cosmeticsScript, /garage-first-person-mirror/);
  assert.match(cosmeticsScript, /tap-exterior-goop/);
  assert.match(cosmeticsScript, /garage-exterior/);
  assert.match(cosmeticsScript, /tap-sky/);
  assert.match(cosmeticsScript, /exec-out', 'screencap', '-p'/);
  assert.match(cosmeticsScript, /Android's real[\s\S]*framebuffer/);
  assert.doesNotMatch(cosmeticsScript, /const raw = await cdp\.capture\(\)/);
  assert.match(cosmeticsScript, /contact-sheet-all\.png/);
  assert.match(cosmeticsScript, /audit\.json/);
  assert.match(cosmeticsScript, /failures\.json/);
  assert.match(cosmeticsScript, /process\.exitCode = 1/);
  assert.match(cosmeticsScript, /dashboardBounds/);
  assert.match(cosmeticsScript, /const auditCases = cosmetics\.flatMap/);
  assert.match(cosmeticsScript, /Array\.from\(\{ length: 6 \}/);
  assert.match(cosmeticsScript, /logicalSixSlotCenter/);
  assert.match(cosmeticsScript, /combined-current-loadout/);
  assert.match(cosmeticsScript, /noAccessoryCollisions/);
  assert.match(cosmeticsScript, /roofSurfaceFlush/);
  assert.match(cosmeticsScript, /topNormalized/);
  assert.match(cosmeticsScript, /driverFacingSide/);
  assert.match(cosmeticsScript, /footprintInsideDashboard/);
});

test('cosmetic placement aligns visible bodies behind shared geometry anchors', () => {
  assert.match(sceneSource, /mount\.userData\.cosmeticContent = content/);
  assert.match(sceneSource, /mount\.add\(content\)/);
  assert.match(sceneSource, /dashboard\.name = 'dashboard-surface'/);
  assert.match(sceneSource, /roof\.name = 'roof-surface'/);
  assert.match(sceneSource, /danglerAnchor\.name = 'dangler-anchor'/);
  assert.match(sceneSource, /this\.mountDangler\(mirror, item, style\)/);
  assert.match(sceneSource, /id === 'dangle_testing_coals'/);
  assert.match(sceneSource, /private danglingBodyBounds/);
  assert.match(sceneSource, /this\.compactDanglerToMirror\(item\)/);
  assert.match(sceneSource, /cord\.name = 'Short Mirror Cord'/);
  assert.match(sceneSource, /style !== 'beads'/);
  assert.match(sceneSource, /style === 'testing_coals' \? 0\.060/);
  assert.match(sceneSource, /vertexColors: Boolean\(node\.geometry\.getAttribute\('color'\)\)/);
  assert.match(sceneSource, /color: 0xd07aa0/);
  assert.match(sceneSource, /content\.rotation\.set\(-Math\.PI \/ 2, driverFacingYaw, 0, 'YXZ'\)/);
  assert.match(sceneSource, /-1\.42244334/);
  assert.match(sceneSource, /1\.92914931/);
  assert.match(cosmeticsScript, /visibleBodyAttached/);
  assert.match(cosmeticsScript, /requestedIds/);
  assert.doesNotMatch(
    sceneSource,
    /item\.position\.set\(0,\s*0,\s*0\)[\s\S]{0,180}this\.dangler/,
  );
});

test('responsive UGC audit covers every tier, target viewport, and moderation surface', () => {
  assert.match(ugcScript, /numericOption\('--port', 9222\)/);
  assert.match(ugcScript, /for \(let tier = 0; tier < 4; tier\+\+\)/);
  for (const dimensions of [
    '280, height: 480',
    '320, height: 568',
    '360, height: 640',
    '412, height: 915',
    '480, height: 280',
    '640, height: 360',
    '768, height: 1024',
  ]) {
    assert.ok(ugcScript.includes(dimensions), `missing viewport ${dimensions}`);
  }
  for (const control of ['FLAG', 'HIDE', 'UNHIDE', 'CANCEL', 'SEND REPORT']) {
    assert.ok(ugcScript.includes(`'${control}'`), `missing ${control} moderation control`);
  }
  assert.match(ugcScript, /Emulation\.setDeviceMetricsOverride/);
  assert.match(ugcScript, /const overlaps = \[\]/);
  assert.match(ugcScript, /wrappedButtons/);
  assert.match(ugcScript, /multiRowGroups/);
  assert.match(ugcScript, /multiRowLeaderboardRows/);
  assert.match(ugcScript, /clipped/);
  assert.match(ugcScript, /occluded/);
  assert.match(ugcScript, /report-modal-bottom/);
  assert.match(ugcScript, /const visibleRect = \(element\)/);
  assert.doesNotMatch(ugcScript, /\.at\(-1\)/);
  assert.match(ugcScript, /expectedCases = viewports\.length \* 4 \* scenarios\.length/);
  assert.match(ugcScript, /contact-sheet-\$\{scenario\.id\}\.png/);
  assert.match(ugcScript, /audit\.json/);
  assert.match(ugcScript, /failures\.json/);
  assert.match(ugcScript, /process\.exitCode = 1/);
});

test('Android 12 touch-look audit proves physical direct manipulation and cancellation', () => {
  assert.match(touchScript, /apiLevel !== 31/);
  assert.match(touchScript, /webview_devtools_remote_\$\{pid\}/);
  assert.match(touchScript, /JSON\.parse\(cdp\.page\.description \|\| '\{\}'\)/);
  assert.match(touchScript, /'shell', 'input', 'touchscreen', 'swipe'/);
  assert.match(touchScript, /'motionevent'/);
  assert.match(touchScript, /motionEvent\('DOWN'/);
  assert.match(touchScript, /motionEvent\('CANCEL'/);
  assert.match(touchScript, /totalTaps/);
  assert.match(touchScript, /garageFP/);
  assert.match(touchScript, /getObjectByName\('steering-wheel'\)/);
  assert.match(touchScript, /camera = scene\.camera/);
  assert.match(touchScript, /camera = scene\.garageCam/);
  assert.match(touchScript, /\.project\(camera\)/);
  assert.match(touchScript, /tap-main-fpv-horizontal-rendered-content-follows-finger/);
  assert.match(touchScript, /tap-main-fpv-vertical-rendered-content-follows-finger/);
  assert.match(touchScript, /garage-fpv-horizontal-rendered-content-follows-finger/);
  assert.match(touchScript, /garage-fpv-vertical-rendered-content-follows-finger/);
  assert.match(touchScript, /collapsed-garage-area-does-not-block-physical-gesture/);
  assert.match(touchScript, /sensitivity-setting-scales-rendered-movement/);
  assert.match(touchScript, /sensitivityRatio >= 2\.25/);
  assert.match(touchScript, /requestAnimationFrame\(sample\)/);
  assert.match(touchScript, /reversals === 0/);
  assert.match(touchScript, /frameP95Ms <= 34/);
  assert.match(touchScript, /frameMaxMs <= 67/);
  assert.match(touchScript, /settleMs <= 300/);
  assert.match(touchScript, /tap-main-fpv-motion-is-smooth-monotonic-and-settles/);
  assert.match(touchScript, /garage-fpv-motion-is-smooth-monotonic-and-settles/);
  assert.match(touchScript, /exec-out', 'screencap', '-p'/);
  assert.match(touchScript, /contact-sheet-touch-look\.png/);
  assert.match(touchScript, /audit\.json/);
  assert.match(touchScript, /failures\.json/);
  assert.match(touchScript, /process\.exitCode = 1/);
  assert.doesNotMatch(touchScript, /\.at\(-1\)/);
});

test('responsive audit restores state and proves persistent controls at scroll bottom', () => {
  const snapshotAt = responsiveScript.indexOf('window.__disciplineResponsiveQaSnapshot =');
  const tutorialEndAt = responsiveScript.indexOf('window.__tutorial.end()');
  assert.ok(snapshotAt >= 0 && snapshotAt < tutorialEndAt,
    'state must be captured before tutorial.end() mutates and saves');
  assert.match(responsiveScript, /storage: Object\.entries\(localStorage\)/);
  assert.match(responsiveScript, /game: game \? JSON\.parse\(JSON\.stringify\(game\.s\)\)/);
  assert.match(responsiveScript, /if \(game\) game\.save = \(\) => \{\}/);
  assert.match(responsiveScript, /account\.cloudReadyAccountId = ''/);
  assert.match(responsiveScript, /localStorage\.clear\(\)/);
  assert.match(responsiveScript, /for\(const key of Object\.keys\(game\.s\)\)delete game\.s\[key\]/);
  assert.match(responsiveScript, /Object\.assign\(game\.s,snapshot\.game\)/);
  assert.match(responsiveScript, /:scope > \.garage-head \.g-collapse/);
  assert.match(responsiveScript, /\.ad-box\.mshop/);
  assert.match(responsiveScript, /scroller\.scrollTop=scroller\.scrollHeight/);
  assert.match(responsiveScript, /bottomReached/);
  assert.match(responsiveScript, /stationary/);
  assert.match(responsiveScript, /hitTestVisible/);
  assert.match(responsiveScript, /hideCaption/);
  assert.match(responsiveScript, /sheet-\$\{screen\}-bottom\.png/);
});

test('tutorial flow uses physical Android taps and validates gating, skip, and every advance', () => {
  assert.match(tutorialFlowScript, /webview_devtools_remote_\$\{pid\}/);
  assert.match(tutorialFlowScript, /'shell', 'input', 'tap'/);
  assert.match(tutorialFlowScript, /exec-out', 'screencap', '-p'/);
  assert.match(tutorialFlowScript, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(tutorialFlowScript, /External network disabled by tutorial visual QA/);
  assert.match(tutorialFlowScript, /scenario: 'skip-path'/);
  assert.match(tutorialFlowScript, /wrongControlLocked/);
  assert.match(tutorialFlowScript, /stepIndexMatches/);
  assert.match(tutorialFlowScript, /actionPhysical/);
  assert.match(tutorialFlowScript, /instructionLock/);
  assert.match(tutorialFlowScript, /successfulGameplay/);
  assert.match(tutorialFlowScript, /advanced/);
  assert.match(tutorialFlowScript, /expectedCases = 15/);
  assert.match(tutorialFlowScript, /storage:Object\.entries\(localStorage\)/);
  assert.match(tutorialFlowScript, /localStorage\.clear\(\)/);
  assert.match(tutorialFlowScript, /Object\.assign\(window\.__game\.s,original\.game\)/);
  assert.doesNotMatch(tutorialFlowScript, /dispatchEvent\(new PointerEvent/);
});

test('Tap FPV cosmetic audit independently proves every shared cockpit placement', () => {
  assert.match(tapCosmeticsScript, /readCosmeticsFromConfig/);
  assert.match(tapCosmeticsScript, /\['ornament', 'dangler', 'horn'\]/);
  assert.match(tapCosmeticsScript, /Array\.from\(\{ length: 6 \}/);
  assert.match(tapCosmeticsScript, /scene\.cosmeticSource/);
  assert.match(tapCosmeticsScript, /scene\.setDashboardItems/);
  assert.match(tapCosmeticsScript, /scene\.setDangler/);
  assert.match(tapCosmeticsScript, /scene\.setHornVisual/);
  assert.match(tapCosmeticsScript, /targetWorld = cockpit\.localToWorld/);
  assert.match(tapCosmeticsScript, /Math\.atan2\(delta\.x, -delta\.z\)/);
  assert.match(tapCosmeticsScript, /Math\.asin/);
  assert.match(tapCosmeticsScript, /exactSixSlotCenter/);
  assert.match(tapCosmeticsScript, /surfaceFlush/);
  assert.match(tapCosmeticsScript, /containedInAssignedCell/);
  assert.match(tapCosmeticsScript, /centeredUnderMirror/);
  assert.match(tapCosmeticsScript, /topTouchesMirrorBottom/);
  assert.match(tapCosmeticsScript, /driverFacingSide/);
  assert.match(tapCosmeticsScript, /clearsDashboard/);
  assert.match(tapCosmeticsScript, /censorCoversEntireNovelty/);
  assert.match(tapCosmeticsScript, /passengerSideFootprint/);
  assert.match(tapCosmeticsScript, /footprintInsideDashboard/);
  assert.match(tapCosmeticsScript, /expectedOrientation/);
  assert.match(tapCosmeticsScript, /exec-out', 'screencap', '-p'/);
  assert.doesNotMatch(tapCosmeticsScript, /cdp\.capture/);
  assert.match(tapCosmeticsScript, /contact-sheet-tap-fpv-all\.png/);
  assert.match(tapCosmeticsScript, /audit\.json/);
  assert.match(tapCosmeticsScript, /failures\.json/);
  assert.match(tapCosmeticsScript, /process\.exitCode = 1/);
  assert.doesNotMatch(tapCosmeticsScript, /\.at\(-1\)/);
});
