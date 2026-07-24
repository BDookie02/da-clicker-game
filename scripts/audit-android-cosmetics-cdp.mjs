import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  connectAndroidWebView,
  numericOption,
  option,
  readCosmeticsFromConfig,
  requireVisualAuditHandles,
  writeContactSheet,
  writeJson,
  writeLabeledPng,
} from './lib/android-visual-qa.mjs';

const root = resolve(import.meta.dirname, '..');
const port = numericOption('--port', 9222);
const output = resolve(root, option('--out', join('devlog', 'android-cosmetics-cdp')));
const serial = option('--serial', 'emulator-5554');
const sdkRoot = process.env.ANDROID_SDK_ROOT
  || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : '');
const adbDefault = sdkRoot
  ? join(sdkRoot, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
  : 'adb';
const adb = option('--adb', adbDefault);
const requestedIds = new Set(option('--ids', '').split(',').map((value) => value.trim()).filter(Boolean));
const cosmetics = readCosmeticsFromConfig(join(root, 'src', 'config.ts'))
  .filter((item) => !requestedIds.size || requestedIds.has(item.id));
if (requestedIds.size && cosmetics.length !== requestedIds.size) {
  const found = new Set(cosmetics.map((item) => item.id));
  const missing = [...requestedIds].filter((id) => !found.has(id));
  throw new Error(`Unknown cosmetic id(s): ${missing.join(', ')}`);
}
const auditCases = cosmetics.flatMap((item) => item.slot === 'ornament'
  ? Array.from({ length: 6 }, (_, qaSlotIndex) => ({ ...item, qaSlotIndex }))
  : [{ ...item, qaSlotIndex: null }]);
const modelSlots = new Set(['ornament', 'dangler', 'horn', 'roof']);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
mkdirSync(output, { recursive: true });

if (adb !== 'adb' && !existsSync(adb))
  throw new Error(`Android adb executable was not found at ${adb}`);
const captureFramebuffer = () => {
  const png = execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    throw new Error(`Android framebuffer capture from ${serial} was not a PNG`);
  return png;
};

const reports = [];
const captures = [];
const failures = [];
let cdp = null;
let snapshotCreated = false;
let webview = null;

const contextFor = (slot) => {
  if (slot === 'ornament' || slot === 'horn') return 'garage-first-person-dashboard';
  if (slot === 'dangler') return 'garage-first-person-mirror';
  if (slot === 'sky') return 'tap-sky';
  if (slot === 'goop') return 'tap-exterior-goop';
  return 'garage-exterior';
};
const sheetGroupFor = (slot) => {
  if (slot === 'ornament' || slot === 'dangler' || slot === 'horn')
    return 'garage-first-person';
  if (slot === 'sky') return 'tap-sky';
  return 'exterior';
};

const mountedExpression = (slot) => ({
  ornament: 'Boolean(window.__scene.garageOrn?.children?.length)',
  dangler: 'Boolean(window.__scene.garageDangler?.children?.length)',
  horn: 'Boolean(window.__scene.garageHornVisual)',
  roof: 'Boolean(window.__scene.garageRoofSign)',
  decal: 'Boolean(window.__scene.garageDecal)',
  goop: 'Boolean(window.__scene.goopGroup?.children?.length >= 44)',
  sky: 'Boolean(window.__scene.skyMesh?.material?.uniforms?.top?.value)',
})[slot];

try {
  cdp = await connectAndroidWebView(port);
  webview = await requireVisualAuditHandles(cdp, [
    'scene.cosmeticSource',
    'scene.enterGarage',
    'scene.exitGarage',
    'scene.setGarageCosmetics',
    'scene.setDashboardItems',
    'scene.setDangler',
    'scene.setHornVisual',
    'scene.setDecal',
    'scene.setSky',
    'scene.goop',
    'scene.resetTapLook',
    'game.dashboardItems',
    'game.equipped',
  ]);

  await cdp.evaluate(`(() => {
    if (window.__disciplineCosmeticQaSnapshot)
      throw new Error('A cosmetic visual-audit snapshot already exists');
    const scene = window.__scene;
    const ui = window.__ui;
    const game = window.__game;
    const account = ui.account || null;
    window.__disciplineCosmeticQaSnapshot = {
      storage: Object.entries(localStorage),
      game: JSON.parse(JSON.stringify(game.s)),
      bodyClass: document.body.className,
      bodyTextTier: document.body.dataset.textTier ?? null,
      account,
      cloudReadyAccountId: account?.cloudReadyAccountId ?? null,
      scene: {
        inGarage: Boolean(scene.inGarage),
        garageFP: Boolean(scene.garageFP),
        garageYaw: scene.garageYaw,
        garagePitch: scene.garagePitch,
        garageTargetYaw: scene.garageTargetYaw,
        garageTargetPitch: scene.garageTargetPitch,
        garageDist: scene.garageDist,
        fpYaw: scene.fpYaw,
        fpPitch: scene.fpPitch,
        fpTargetYaw: scene.fpTargetYaw,
        fpTargetPitch: scene.fpTargetPitch,
        fpZoom: scene.fpZoom,
        freeLook: scene.freeLook,
        lookYaw: scene.lookYaw,
        lookPitch: scene.lookPitch,
        lookTargetYaw: scene.lookTargetYaw,
        lookTargetPitch: scene.lookTargetPitch,
        goopChildren: [...(scene.goopGroup?.children || [])],
        skyTop: scene.skyMesh.material.uniforms.top.value.getHex(),
        skyBottom: scene.skyMesh.material.uniforms.bottom.value.getHex(),
        fog: scene.scene.fog.color.getHex(),
        hemi: scene.hemi.color.getHex(),
        sun: scene.sun.intensity,
        noir: document.body.classList.contains('film-noir'),
      },
      consoleError: console.error,
    };
    if (account) account.cloudReadyAccountId = '';
    const style = document.createElement('style');
    style.id = 'discipline-cosmetic-qa-style';
    style.textContent = '.title-screen,.tutorial-layer,.ad-overlay,.panel,.garage-exit-fixed,.garage-arrow,.toasts{display:none!important}';
    document.head.appendChild(style);
    window.__disciplineCosmeticQaErrors = [];
    console.error = (...args) => {
      window.__disciplineCosmeticQaErrors.push(args.map(value =>
        value instanceof Error ? value.message : String(value)).join(' '));
      window.__disciplineCosmeticQaSnapshot.consoleError(...args);
    };
    return true;
  })()`);
  snapshotCreated = true;

  // Resolve every model through the exact installed asset loader before any
  // screenshot. Procedural readability replacements pass through this same
  // method; missing GLBs reject here instead of silently producing blank PNGs.
  for (const cosmetic of cosmetics.filter((item) => modelSlots.has(item.slot))) {
    try {
      const asset = await cdp.evaluate(`(async () => {
        const source = await window.__scene.cosmeticSource(${JSON.stringify(cosmetic.id)});
        let renderableNodes = 0;
        source.traverse((node) => {
          if (node.geometry?.attributes?.position?.count > 0) renderableNodes++;
        });
        return { renderableNodes };
      })()`, 30_000);
      if (!asset?.renderableNodes)
        throw new Error('asset contains no renderable geometry');
    } catch (error) {
      failures.push({
        id: cosmetic.id,
        stage: 'asset-preflight',
        error: error.message,
      });
    }
  }

  for (const [index, cosmetic] of auditCases.entries()) {
    const context = contextFor(cosmetic.slot);
    const preflightFailure = failures.find((failure) =>
      failure.id === cosmetic.id && failure.stage === 'asset-preflight');
    if (preflightFailure) {
      reports.push({ ...cosmetic, context, ok: false, error: preflightFailure.error });
      continue;
    }

    try {
      await cdp.evaluate(`(() => {
        const item = ${JSON.stringify(cosmetic)};
        const scene = window.__scene;
        const clearGoop = () => {
          scene.goopGroup?.clear?.();
          for (const splat of scene.splats || []) splat.m?.parent?.remove?.(splat.m);
          scene.splats = [];
        };
        scene.setDashboardItems([]);
        scene.setDangler(undefined);
        scene.setHornVisual(undefined);
        scene.setDecal(undefined);
        clearGoop();

        if (item.slot === 'ornament' || item.slot === 'dangler' || item.slot === 'horn') {
          scene.enterGarage();
          document.body.classList.add('in-garage');
          scene.garageFP = true;
          scene.fpZoom = 1;
          if (item.slot === 'ornament') {
            scene.fpYaw = scene.fpTargetYaw = -0.26;
            scene.fpPitch = scene.fpTargetPitch = -0.18;
            scene.setGarageCosmetics(undefined,
              Array.from({ length: 6 }, (_, slotIndex) =>
                slotIndex === item.qaSlotIndex ? item.value : null),
              undefined, undefined, undefined, undefined);
          } else if (item.slot === 'dangler') {
            scene.fpYaw = scene.fpTargetYaw = -0.48;
            scene.fpPitch = scene.fpTargetPitch = 0.08;
            scene.setGarageCosmetics(undefined, [],
              undefined, item.value, undefined, undefined);
          } else {
            scene.fpYaw = scene.fpTargetYaw = -0.72;
            scene.fpPitch = scene.fpTargetPitch = -0.18;
            scene.setGarageCosmetics(undefined, [],
              undefined, undefined, undefined, item.value);
          }
        } else if (item.slot === 'sky') {
          scene.exitGarage();
          document.body.classList.remove('in-garage');
          scene.resetTapLook();
          scene.setSky(item.value);
        } else if (item.slot === 'goop') {
          scene.exitGarage();
          document.body.classList.remove('in-garage');
          scene.resetTapLook();
          scene.setSky('day');
          scene.goop(item.value);
        } else {
          scene.enterGarage();
          document.body.classList.add('in-garage');
          scene.garageFP = false;
          scene.garageYaw = scene.garageTargetYaw =
            item.slot === 'roof' ? 0.42 : 0.08;
          scene.garagePitch = scene.garageTargetPitch =
            item.slot === 'roof' ? 0.34 : 0.24;
          scene.garageDist = item.slot === 'roof' ? 5.0 : 4.4;
          scene.setGarageCosmetics(
            item.slot === 'decal' ? item.value : undefined,
            [],
            undefined,
            undefined,
            item.slot === 'roof' ? item.value : undefined,
            item.slot === 'horn' ? item.value : undefined,
          );
        }
        return true;
      })()`);

      await cdp.waitFor(mountedExpression(cosmetic.slot), {
        timeoutMs: 12_000,
        intervalMs: 100,
        description: `${cosmetic.id} to mount in ${context}`,
      });
      await wait(cosmetic.slot === 'goop' ? 180 : 650);

      const placement = await cdp.evaluate(`(() => {
        const item = ${JSON.stringify(cosmetic)};
        const scene = window.__scene;
        const pack = (value) => value
          ? { x: value.x, y: value.y, z: value.z } : null;
        const bounds = (object, relativeTo = scene.garageCar, include = () => true) => {
          if (!object) return null;
          object.updateWorldMatrix?.(true, true);
          relativeTo?.updateWorldMatrix?.(true, false);
          const min = object.position.clone().set(Infinity, Infinity, Infinity);
          const max = object.position.clone().set(-Infinity, -Infinity, -Infinity);
          let points = 0;
          object.traverse?.((node) => {
            if (node.visible === false
              || !node.geometry?.attributes?.position?.count
              || !include(node)) return;
            node.geometry.computeBoundingBox?.();
            const box = node.geometry.boundingBox;
            if (!box) return;
            for (const x of [box.min.x, box.max.x])
              for (const y of [box.min.y, box.max.y])
                for (const z of [box.min.z, box.max.z]) {
                  const point = node.position.clone().set(x, y, z);
                  node.localToWorld(point);
                  relativeTo?.worldToLocal?.(point);
                  min.min(point);
                  max.max(point);
                  points++;
                }
          });
          if (!points) return null;
          return {
            min: pack(min),
            max: pack(max),
            size: pack(max.clone().sub(min)),
            center: pack(min.clone().add(max).multiplyScalar(0.5)),
          };
        };
        const inspect = (object) => {
          let renderableNodes = 0;
          let finiteTransforms = true;
          object?.traverse?.((node) => {
            if (node.geometry?.attributes?.position?.count > 0) renderableNodes++;
            for (const value of [
              node.position?.x, node.position?.y, node.position?.z,
              node.scale?.x, node.scale?.y, node.scale?.z,
            ]) if (value !== undefined && !Number.isFinite(value)) finiteTransforms = false;
          });
          return {
            renderableNodes,
            finiteTransforms,
            position: object?.position?.toArray?.() ?? null,
            rotation: object?.rotation
              ? [object.rotation.x, object.rotation.y, object.rotation.z] : null,
          };
        };
        let object = null;
        const checks = {};
        let measuredBounds = null;
        let visibleBodyBounds = null;
        let anchorPoint = null;
        const car = scene.garageCar;
        const dashboardObject = car?.getObjectByName?.('dashboard-surface') || null;
        const dashboardBounds = bounds(dashboardObject, car);
        if (item.slot === 'ornament') {
          object = scene.garageOrn?.children?.[0] || null;
          measuredBounds = bounds(object, car);
          const cellWidth = dashboardBounds
            ? (dashboardBounds.max.x - dashboardBounds.min.x) / 6 : 0;
          const expectedX = dashboardBounds
            ? dashboardBounds.max.x - cellWidth * (item.qaSlotIndex + 0.5) : NaN;
          checks.singleDashboardItem = scene.garageOrn?.children?.length === 1;
          checks.logicalSixSlotCenter = Boolean(object
            && Number.isInteger(item.qaSlotIndex)
            && item.qaSlotIndex >= 0
            && item.qaSlotIndex < 6
            && Math.abs(object.position.x - expectedX) < 0.002);
          checks.surfaceFlush = Boolean(measuredBounds && dashboardBounds
            && Math.abs(measuredBounds.min.y - dashboardBounds.max.y) < 0.002);
          checks.insideCell = Boolean(measuredBounds && dashboardBounds
            && measuredBounds.min.x >= expectedX - cellWidth / 2 - 0.002
            && measuredBounds.max.x <= expectedX + cellWidth / 2 + 0.002);
        } else if (item.slot === 'dangler') {
          object = scene.garageDangler;
          measuredBounds = bounds(object, car);
          const mirror = scene.garageMirror;
          const anchor = mirror?.getObjectByName?.('dangler-anchor') || null;
          const content = object?.userData?.cosmeticContent || null;
          const contentBounds = bounds(content, object);
          const mountBounds = bounds(object, object);
          visibleBodyBounds = bounds(object, car, (node) =>
            !/cord|hanger|knot|pixel-censor-filter/i.test(node.name || ''));
          const shell = mirror?.getObjectByName?.('mirror-shell') || null;
          const shellBounds = bounds(shell, mirror);
          anchorPoint = anchor?.getWorldPosition?.(anchor.position.clone());
          if (anchorPoint) car?.worldToLocal?.(anchorPoint);
          checks.centeredOnMirror = Boolean(object
            && anchor
            && shellBounds
            && object.parent === anchor
            && anchor.parent === mirror
            && Math.abs(anchor.position.x) < 0.002
            && Math.abs(anchor.position.y - shellBounds.min.y) < 0.003);
          checks.driverFacingSide = Boolean(anchor && mirror
            && Math.abs(anchor.position.z - 0.06 * mirror.userData.facing) < 0.002);
          // Bounds are measured relative to the mount itself, so its fitted
          // top remains zero even when the whole mount is inset into the shell.
          checks.topNormalized = Boolean(mountBounds
            && Math.abs(mountBounds.max.y) < 0.003);
          checks.clearsDashboard = Boolean(measuredBounds && dashboardBounds
            && measuredBounds.min.y > dashboardBounds.max.y + 0.02);
          const expectedBodyGap = item.id === 'dangle_beads' ? -0.024
            : item.id === 'dangle_testing_coals' ? -0.034 : -0.014;
          checks.visibleBodyAttached = Boolean(visibleBodyBounds && anchorPoint
            && Math.abs((anchorPoint.y - visibleBodyBounds.max.y) - expectedBodyGap) < 0.008);
          checks.hasCensor = item.id !== 'dangle_censored'
            || Boolean(object?.getObjectByName?.('pixel-censor-filter'));
        } else if (item.slot === 'horn') {
          object = scene.garageHornVisual;
          measuredBounds = bounds(object, car);
          const cellWidth = dashboardBounds
            ? (dashboardBounds.max.x - dashboardBounds.min.x) / 6 : 0;
          const passengerX = dashboardBounds
            ? dashboardBounds.min.x + cellWidth / 2 : NaN;
          checks.passengerTray = Boolean(object && dashboardBounds
            && object.position.x < dashboardBounds.center.x
            && object.position.x >= passengerX - cellWidth / 2 - 0.002);
          checks.surfaceFlush = Boolean(measuredBounds && dashboardBounds
            && Math.abs(measuredBounds.min.y - dashboardBounds.max.y) < 0.002);
          checks.footprintInsideDashboard = Boolean(measuredBounds && dashboardBounds
            && measuredBounds.min.x >= dashboardBounds.min.x - 0.002
            && measuredBounds.max.x <= dashboardBounds.max.x + 0.002
            && measuredBounds.min.z >= dashboardBounds.min.z - 0.002
            && measuredBounds.max.z <= dashboardBounds.max.z + 0.002);
          checks.playerFacingRotation = Boolean(object
            && Math.abs(object.rotation.y - Math.PI) < 0.002);
        } else if (item.slot === 'roof') {
          object = scene.garageRoofSign;
          measuredBounds = bounds(object, car);
          const roofBounds = bounds(car?.getObjectByName?.('roof-surface'), car);
          checks.roofSurfaceFlush = Boolean(measuredBounds && roofBounds
            && Math.abs(measuredBounds.min.y - roofBounds.max.y) < 0.002);
          checks.footprintInsideRoof = Boolean(measuredBounds && roofBounds
            && measuredBounds.min.x >= roofBounds.min.x - 0.002
            && measuredBounds.max.x <= roofBounds.max.x + 0.002
            && measuredBounds.min.z >= roofBounds.min.z - 0.002
            && measuredBounds.max.z <= roofBounds.max.z + 0.002);
        } else if (item.slot === 'decal') {
          object = scene.garageDecal;
          checks.windshieldMounted = Boolean(object
            && Math.abs(object.position.y - 1.16) < 0.002
            && Math.abs(object.position.z - 0.755) < 0.002);
        } else if (item.slot === 'goop') {
          object = scene.goopGroup;
          checks.realExplosionSplat = (object?.children?.length || 0) >= 44;
        } else if (item.slot === 'sky') {
          object = scene.skyMesh;
          checks.skyShaderActive = Boolean(
            scene.skyMesh?.material?.uniforms?.top?.value
            && scene.skyMesh?.material?.uniforms?.bottom?.value);
          checks.skyValue = item.value;
          checks.topHex = scene.skyMesh.material.uniforms.top.value.getHexString();
          checks.bottomHex = scene.skyMesh.material.uniforms.bottom.value.getHexString();
        }
        const inspected = inspect(object);
        const consoleErrors = [...window.__disciplineCosmeticQaErrors];
        window.__disciplineCosmeticQaErrors.length = 0;
        return {
          ...inspected,
          checks,
          bounds: measuredBounds,
          visibleBodyBounds,
          anchorPoint: pack(anchorPoint),
          dashboardBounds,
          consoleErrors,
          garageMode: Boolean(scene.inGarage),
          garageFirstPerson: Boolean(scene.garageFP),
          canvas: {
            width: document.querySelector('#game-canvas')?.width || 0,
            height: document.querySelector('#game-canvas')?.height || 0,
          },
        };
      })()`);

      const failedChecks = Object.entries(placement.checks)
        .filter(([, value]) => value === false)
        .map(([name]) => name);
      if (!placement.renderableNodes || !placement.finiteTransforms)
        failedChecks.push('renderableFiniteGeometry');
      if (!placement.canvas.width || !placement.canvas.height) failedChecks.push('liveCanvas');
      if (placement.consoleErrors.length) failedChecks.push('consoleErrors');
      const validationError = failedChecks.length
        ? `context validation failed: ${failedChecks.join(', ')}${placement.consoleErrors.length ? ` (${placement.consoleErrors.join(' | ')})` : ''}`
        : null;

      // Chrome DevTools screenshots can omit the hardware-accelerated WebGL
      // surface even while Android visibly renders it. Capture Android's real
      // framebuffer so every model is judged from the same pixels the player
      // sees in the emulator window. Capture failed placements too: the image
      // and measured bounds are required evidence for correcting them.
      const raw = captureFramebuffer();
      const slotSuffix = cosmetic.slot === 'ornament'
        ? `-slot-${cosmetic.qaSlotIndex + 1}` : '';
      const filename = `${String(index + 1).padStart(2, '0')}-${slug(cosmetic.slot)}-${slug(cosmetic.id)}${slotSuffix}.png`;
      const file = join(output, filename);
      const image = await writeLabeledPng(raw, file,
        `${cosmetic.name} [${cosmetic.id}]`,
        `${context} · ${cosmetic.slot} · ${cosmetic.cost} M`);
      const report = {
        ...cosmetic,
        context,
        ok: !validationError,
        file: basename(file),
        placement,
        image,
        ...(validationError ? { error: validationError } : {}),
      };
      reports.push(report);
      captures.push({
        id: cosmetic.slot === 'ornament'
          ? `${cosmetic.id} slot ${cosmetic.qaSlotIndex + 1}`
          : cosmetic.id,
        slot: cosmetic.slot,
        group: sheetGroupFor(cosmetic.slot),
        file,
      });
      if (validationError) {
        failures.push({
          id: cosmetic.id,
          stage: 'context-validation',
          error: validationError,
          placement,
        });
      }
    } catch (error) {
      failures.push({ id: cosmetic.id, stage: 'render-capture', error: error.message });
      reports.push({ ...cosmetic, context, ok: false, error: error.message });
    }
  }

  // Prove the actual launch catalog as one loadout. Individual slot checks
  // cannot detect an accessory collision caused only when the four dashboard
  // items and passenger-side horn are mounted simultaneously.
  try {
    await cdp.evaluate(`(() => {
      const scene = window.__scene;
      scene.enterGarage();
      document.body.classList.add('in-garage');
      scene.garageFP = true;
      scene.fpZoom = 1;
      scene.fpYaw = scene.fpTargetYaw = -0.34;
      scene.fpPitch = scene.fpTargetPitch = -0.18;
      scene.setGarageCosmetics(
        undefined,
        ['#e8e4d8', '#7a4a9e', '#e8862a', '#e8c84a', null, null],
        undefined,
        undefined,
        undefined,
        'airhorn',
      );
      return true;
    })()`);
    await cdp.waitFor(
      'window.__scene.garageOrn?.children?.length === 4 && Boolean(window.__scene.garageHornVisual)',
      {
        timeoutMs: 12_000,
        intervalMs: 100,
        description: 'combined four-ornament and airhorn loadout to mount',
      },
    );
    await wait(650);
    const placement = await cdp.evaluate(`(() => {
      const scene = window.__scene;
      const car = scene.garageCar;
      const bounds = (object) => {
        if (!object) return null;
        object.updateWorldMatrix?.(true, true);
        car.updateWorldMatrix?.(true, false);
        const min = object.position.clone().set(Infinity, Infinity, Infinity);
        const max = object.position.clone().set(-Infinity, -Infinity, -Infinity);
        let points = 0;
        object.traverse?.((node) => {
          if (node.visible === false || !node.geometry?.attributes?.position?.count) return;
          node.geometry.computeBoundingBox?.();
          const box = node.geometry.boundingBox;
          if (!box) return;
          for (const x of [box.min.x, box.max.x])
            for (const y of [box.min.y, box.max.y])
              for (const z of [box.min.z, box.max.z]) {
                const point = node.position.clone().set(x, y, z);
                node.localToWorld(point);
                car.worldToLocal(point);
                min.min(point);
                max.max(point);
                points++;
              }
        });
        return points ? { min, max } : null;
      };
      const dashboard = bounds(car?.getObjectByName?.('dashboard-surface'));
      const objects = [
        ...(scene.garageOrn?.children || []),
        scene.garageHornVisual,
      ].filter(Boolean);
      const boxes = objects.map(bounds);
      const collisions = [];
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          const first = boxes[a];
          const second = boxes[b];
          const overlap = {
            x: Math.min(first.max.x, second.max.x) - Math.max(first.min.x, second.min.x),
            y: Math.min(first.max.y, second.max.y) - Math.max(first.min.y, second.min.y),
            z: Math.min(first.max.z, second.max.z) - Math.max(first.min.z, second.min.z),
          };
          if (overlap.x > 0.002 && overlap.y > 0.002 && overlap.z > 0.002)
            collisions.push({ a, b, overlap });
        }
      }
      const withinDashboard = boxes.every((box) => dashboard
        && box.min.x >= dashboard.min.x - 0.002
        && box.max.x <= dashboard.max.x + 0.002
        && box.min.z >= dashboard.min.z - 0.002
        && box.max.z <= dashboard.max.z + 0.002
        && Math.abs(box.min.y - dashboard.max.y) < 0.002);
      const pack = (box) => box ? {
        min: { x: box.min.x, y: box.min.y, z: box.min.z },
        max: { x: box.max.x, y: box.max.y, z: box.max.z },
      } : null;
      return {
        checks: {
          fourDashboardItemsMounted: scene.garageOrn?.children?.length === 4,
          passengerAirhornMounted: Boolean(scene.garageHornVisual),
          noAccessoryCollisions: collisions.length === 0,
          allAccessoriesFlushAndContained: withinDashboard,
        },
        collisions,
        boxes: boxes.map(pack),
        dashboard: pack(dashboard),
      };
    })()`);
    const failedChecks = Object.entries(placement.checks)
      .filter(([, value]) => value === false)
      .map(([name]) => name);
    const validationError = failedChecks.length
      ? `combined loadout validation failed: ${failedChecks.join(', ')}` : null;
    const raw = captureFramebuffer();
    const file = join(output,
      `${String(auditCases.length + 1).padStart(2, '0')}-combined-current-loadout.png`);
    const image = await writeLabeledPng(
      raw,
      file,
      'Current catalog: four dashboard items + Freight Airhorn',
      'garage-first-person-dashboard · simultaneous collision proof',
    );
    reports.push({
      id: 'combined-current-loadout',
      name: 'Current cosmetic loadout',
      slot: 'combined',
      context: 'garage-first-person-dashboard',
      ok: !validationError,
      file: basename(file),
      placement,
      image,
      ...(validationError ? { error: validationError } : {}),
    });
    captures.push({
      id: 'combined current loadout',
      slot: 'combined',
      group: 'garage-first-person',
      file,
    });
    if (validationError) {
      failures.push({
        id: 'combined-current-loadout',
        stage: 'context-validation',
        error: validationError,
        placement,
      });
    }
  } catch (error) {
    failures.push({
      id: 'combined-current-loadout',
      stage: 'render-capture',
      error: error.message,
    });
  }
} catch (error) {
  failures.push({ id: null, stage: 'fatal', error: error.message });
} finally {
  if (cdp && snapshotCreated) {
    try {
      await cdp.evaluate(`(() => {
        const snapshot = window.__disciplineCosmeticQaSnapshot;
        if (!snapshot) return false;
        const scene = window.__scene;
        const game = window.__game;
        localStorage.clear();
        for (const [key, value] of snapshot.storage) localStorage.setItem(key, value);
        for (const key of Object.keys(game.s)) delete game.s[key];
        Object.assign(game.s, snapshot.game);
        if (snapshot.account)
          snapshot.account.cloudReadyAccountId = snapshot.cloudReadyAccountId ?? '';
        console.error = snapshot.consoleError;
        document.getElementById('discipline-cosmetic-qa-style')?.remove();
        scene.setDashboardItems(game.dashboardItems());
        scene.setDangler(game.equipped('dangler'));
        scene.setHornVisual(game.equipped('horn'));
        scene.setDecal(game.equipped('decal'));
        scene.setGarageCosmetics(
          game.equipped('decal'),
          game.dashboardItems(),
          game.equipped('goop'),
          game.equipped('dangler'),
          game.equipped('roof'),
          game.equipped('horn'),
        );
        scene.goopGroup?.clear?.();
        for (const child of snapshot.scene.goopChildren) scene.goopGroup?.add?.(child);
        scene.skyMesh.material.uniforms.top.value.setHex(snapshot.scene.skyTop);
        scene.skyMesh.material.uniforms.bottom.value.setHex(snapshot.scene.skyBottom);
        scene.scene.fog.color.setHex(snapshot.scene.fog);
        scene.hemi.color.setHex(snapshot.scene.hemi);
        scene.sun.intensity = snapshot.scene.sun;
        document.body.classList.toggle('film-noir', snapshot.scene.noir);
        if (snapshot.scene.inGarage) scene.enterGarage();
        else scene.exitGarage();
        for (const key of [
          'garageFP','garageYaw','garagePitch','garageTargetYaw','garageTargetPitch',
          'garageDist','fpYaw','fpPitch','fpTargetYaw','fpTargetPitch','fpZoom',
          'freeLook','lookYaw','lookPitch','lookTargetYaw','lookTargetPitch',
        ]) scene[key] = snapshot.scene[key];
        document.body.className = snapshot.bodyClass;
        if (snapshot.bodyTextTier === null) delete document.body.dataset.textTier;
        else document.body.dataset.textTier = snapshot.bodyTextTier;
        delete window.__disciplineCosmeticQaErrors;
        delete window.__disciplineCosmeticQaSnapshot;
        return true;
      })()`);
    } catch (error) {
      failures.push({ id: null, stage: 'restore', error: error.message });
    }
  }
  cdp?.close();
}

const expected = new Set(cosmetics.map((item) => item.id));
const captured = new Set(reports.filter((item) => item.ok).map((item) => item.id));
for (const id of expected) {
  if (!captured.has(id) && !failures.some((failure) => failure.id === id))
    failures.push({ id, stage: 'coverage', error: 'No successful capture or explicit failure was recorded' });
}

for (const group of ['garage-first-person', 'exterior', 'tap-sky']) {
  const items = captures.filter((capture) => capture.group === group);
  if (items.length) {
    await writeContactSheet(items, join(output, `contact-sheet-${group}.png`), {
      columns: 4,
      tileWidth: 270,
      tileHeight: 480,
    });
  }
}
if (captures.length) {
  await writeContactSheet(captures, join(output, 'contact-sheet-all.png'), {
    columns: 4,
    tileWidth: 270,
    tileHeight: 480,
  });
}

const audit = {
  generatedAt: new Date().toISOString(),
  tool: 'scripts/audit-android-cosmetics-cdp.mjs',
  invocation: `node scripts/audit-android-cosmetics-cdp.mjs --port ${port}`,
  output,
  webview,
  framebuffer: { serial, adb },
  expectedCount: auditCases.length + 1,
  capturedCount: captures.length,
  restored: !failures.some((failure) => failure.stage === 'restore'),
  items: reports,
  failures,
};
writeJson(join(output, 'audit.json'), audit);
writeJson(join(output, 'failures.json'), failures);

console.log(JSON.stringify({
  expected: auditCases.length + 1,
  captured: captures.length,
  failures: failures.length,
  output,
}));
if (failures.length) process.exitCode = 1;
