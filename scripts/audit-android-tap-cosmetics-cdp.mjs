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
const output = resolve(root, option(
  '--out',
  join('devlog', 'android-tap-cosmetics-cdp'),
));
const serial = option('--serial', 'emulator-5554');
const sdkRoot = process.env.ANDROID_SDK_ROOT
  || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : '');
const adbDefault = sdkRoot
  ? join(sdkRoot, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
  : 'adb';
const adb = option('--adb', adbDefault);
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const slug = (value) => String(value).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const applicable = readCosmeticsFromConfig(join(root, 'src', 'config.ts'))
  .filter((item) => ['ornament', 'dangler', 'horn'].includes(item.slot));
const cases = applicable.flatMap((item) =>
  item.slot === 'ornament'
    ? Array.from({ length: 6 }, (_, slotIndex) => ({
      key: `${item.id}:slot-${slotIndex + 1}`,
      item,
      slotIndex,
    }))
    : [{ key: item.id, item, slotIndex: null }]);

if (adb !== 'adb' && !existsSync(adb))
  throw new Error(`Android adb executable was not found at ${adb}`);
mkdirSync(output, { recursive: true });

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
const preflight = new Map();
let cdp = null;
let webview = null;
let snapshotCreated = false;

try {
  cdp = await connectAndroidWebView(port);
  webview = await requireVisualAuditHandles(cdp, [
    'scene.cosmeticSource',
    'scene.exitGarage',
    'scene.setDashboardItems',
    'scene.setDangler',
    'scene.setHornVisual',
    'scene.setViewSettings',
    'game.dashboardItems',
    'game.equipped',
  ]);

  await cdp.evaluate(`(() => {
    if (window.__disciplineTapCosmeticQaSnapshot)
      throw new Error('A Tap cosmetic audit snapshot already exists');
    const scene = window.__scene;
    const game = window.__game;
    window.__disciplineTapCosmeticQaSnapshot = {
      storage: Object.entries(localStorage),
      game: JSON.parse(JSON.stringify(game.s)),
      bodyClass: document.body.className,
      bodyTextTier: document.body.dataset.textTier ?? null,
      dashboardItems: game.dashboardItems(),
      dangler: game.equipped('dangler'),
      horn: game.equipped('horn'),
      scene: {
        inGarage: Boolean(scene.inGarage),
        freeLook: scene.freeLook,
        lookYaw: scene.lookYaw,
        lookPitch: scene.lookPitch,
        lookTargetYaw: scene.lookTargetYaw,
        lookTargetPitch: scene.lookTargetPitch,
        lookDragYaw: scene.lookDragYaw,
        lookDragPitch: scene.lookDragPitch,
        fovScale: scene.fovScale,
        lookSensitivity: scene.lookSensitivity,
        reducedMotion: scene.reducedMotion,
        cameraQuaternion: scene.camera.quaternion.toArray(),
      },
      consoleError: console.error,
    };
    const style = document.createElement('style');
    style.id = 'discipline-tap-cosmetic-qa-style';
    style.textContent = [
      '.title-screen,.tutorial-layer,.ad-overlay,.panel,.menu-row,.hud-top,',
      '.garage-exit-fixed,.garage-arrow,.toasts,.fade{display:none!important}',
    ].join('');
    document.head.appendChild(style);
    window.__disciplineTapCosmeticQaErrors = [];
    console.error = (...args) => {
      window.__disciplineTapCosmeticQaErrors.push(args.map(value =>
        value instanceof Error ? value.message : String(value)).join(' '));
      window.__disciplineTapCosmeticQaSnapshot.consoleError(...args);
    };
    scene.exitGarage();
    document.body.classList.remove('in-garage');
    scene.setViewSettings(
      window.__disciplineTapCosmeticQaSnapshot.scene.fovScale * 100,
      window.__disciplineTapCosmeticQaSnapshot.scene.lookSensitivity,
      true
    );
    scene.setDashboardItems([]);
    scene.setDangler(undefined);
    scene.setHornVisual(undefined);
    return true;
  })()`);
  snapshotCreated = true;

  // Every case must resolve through the exact installed runtime loader.
  // Procedural readability replacements and GLBs therefore follow the same
  // source path used by the actual Tap cockpit.
  for (const item of applicable) {
    try {
      const result = await cdp.evaluate(`(async () => {
        const source = await window.__scene.cosmeticSource(${JSON.stringify(item.id)});
        let renderableNodes = 0;
        let vertices = 0;
        source.traverse(node => {
          const count = node.geometry?.attributes?.position?.count || 0;
          if (count > 0) {
            renderableNodes++;
            vertices += count;
          }
        });
        return { renderableNodes, vertices };
      })()`, 30_000);
      if (!result?.renderableNodes)
        throw new Error('asset contains no renderable geometry');
      preflight.set(item.id, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      preflight.set(item.id, { error: message });
      failures.push({ id: item.id, stage: 'asset-preflight', error: message });
    }
  }

  for (const [caseIndex, auditCase] of cases.entries()) {
    const { item, slotIndex } = auditCase;
    const asset = preflight.get(item.id);
    if (!asset || asset.error) {
      reports.push({
        key: auditCase.key,
        ...item,
        slotIndex,
        ok: false,
        error: asset?.error || 'asset preflight was not recorded',
      });
      continue;
    }

    try {
      await cdp.evaluate(`(() => {
        const scene = window.__scene;
        const item = ${JSON.stringify(item)};
        const slotIndex = ${JSON.stringify(slotIndex)};
        window.__disciplineTapCosmeticQaErrors.length = 0;
        scene.exitGarage();
        document.body.classList.remove('in-garage');
        scene.setDashboardItems([]);
        scene.setDangler(undefined);
        scene.setHornVisual(undefined);
        if (item.slot === 'ornament') {
          const values = [null, null, null, null, null, null];
          values[slotIndex] = item.value;
          scene.setDashboardItems(values);
        } else if (item.slot === 'dangler') {
          scene.setDangler(item.value);
        } else {
          scene.setHornVisual(item.value);
        }
        return true;
      })()`);
      const mounted = item.slot === 'ornament'
        ? `window.__scene.ornament?.children?.length === 1
          && window.__scene.ornament.children[0].userData.cosmeticId === ${JSON.stringify(item.id)}`
        : item.slot === 'dangler'
          ? `window.__scene.dangler?.userData?.cosmeticId === ${JSON.stringify(item.id)}`
          : `window.__scene.hornVisual?.userData?.cosmeticId === ${JSON.stringify(item.id)}`;
      await cdp.waitFor(mounted, {
        timeoutMs: 12_000,
        intervalMs: 100,
        description: `${auditCase.key} to mount through the Tap runtime loader`,
      });
      await wait(200);

      const placement = await cdp.evaluate(`(() => {
        const auditCase = ${JSON.stringify(auditCase)};
        const item = auditCase.item;
        const slotIndex = auditCase.slotIndex;
        const scene = window.__scene;
        const cockpit = scene.cockpit;
        const pack = value => value
          ? { x: value.x, y: value.y, z: value.z } : null;
        const bounds = (object, relativeTo = cockpit, include = () => true) => {
          if (!object || !relativeTo) return null;
          object.updateWorldMatrix?.(true, true);
          relativeTo.updateWorldMatrix?.(true, false);
          const min = object.position.clone().set(Infinity, Infinity, Infinity);
          const max = object.position.clone().set(-Infinity, -Infinity, -Infinity);
          let points = 0;
          object.traverse?.(node => {
            if (node.visible === false || !include(node)
                || !node.geometry?.attributes?.position?.count) return;
            node.geometry.computeBoundingBox?.();
            const box = node.geometry.boundingBox;
            if (!box) return;
            for (const x of [box.min.x, box.max.x])
              for (const y of [box.min.y, box.max.y])
                for (const z of [box.min.z, box.max.z]) {
                  const point = node.position.clone().set(x, y, z);
                  node.localToWorld(point);
                  relativeTo.worldToLocal(point);
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
            points,
          };
        };
        const inspect = object => {
          let renderableNodes = 0;
          let finiteTransforms = true;
          object?.traverse?.(node => {
            if (node.geometry?.attributes?.position?.count > 0) renderableNodes++;
            for (const value of [
              node.position?.x, node.position?.y, node.position?.z,
              node.rotation?.x, node.rotation?.y, node.rotation?.z,
              node.scale?.x, node.scale?.y, node.scale?.z,
            ]) if (value !== undefined && !Number.isFinite(value))
              finiteTransforms = false;
          });
          return { renderableNodes, finiteTransforms };
        };
        const dashboardObject = cockpit?.getObjectByName?.('dashboard-surface') || null;
        const dashboardBounds = bounds(dashboardObject, cockpit);
        let object = null;
        let objectBounds = null;
        const checks = {};
        const evidence = {};

        if (item.slot === 'ornament') {
          object = scene.ornament?.children?.[0] || null;
          objectBounds = bounds(object, cockpit);
          const cellWidth = dashboardBounds
            ? (dashboardBounds.max.x - dashboardBounds.min.x) / 6 : 0;
          const cellMin = dashboardBounds
            ? dashboardBounds.min.x + cellWidth * slotIndex : NaN;
          const cellMax = cellMin + cellWidth;
          const expectedX = cellMin + cellWidth / 2;
          evidence.slot = {
            index: slotIndex,
            number: slotIndex + 1,
            cellMin,
            cellMax,
            expectedX,
            cellWidth,
          };
          checks.singleMountedItem = scene.ornament?.children?.length === 1;
          checks.exactSixSlotCenter = Boolean(object
            && Math.abs(object.position.x - expectedX) < 0.002);
          checks.surfaceFlush = Boolean(objectBounds && dashboardBounds
            && Math.abs(objectBounds.min.y - dashboardBounds.max.y) < 0.002);
          checks.containedInAssignedCell = Boolean(objectBounds && dashboardBounds
            && objectBounds.min.x >= cellMin - 0.002
            && objectBounds.max.x <= cellMax + 0.002);
          checks.footprintInsideDashboard = Boolean(objectBounds && dashboardBounds
            && objectBounds.min.z >= dashboardBounds.min.z - 0.002
            && objectBounds.max.z <= dashboardBounds.max.z + 0.002);
        } else if (item.slot === 'dangler') {
          object = scene.dangler;
          const mirror = scene.cockpitMirror;
          const anchor = mirror?.getObjectByName?.('dangler-anchor') || null;
          const shell = mirror?.getObjectByName?.('mirror-shell') || null;
          const content = object?.userData?.cosmeticContent || null;
          objectBounds = bounds(object, cockpit,
            node => node.name !== 'pixel-censor-filter');
          const mountBounds = bounds(object, object,
            node => node.name !== 'pixel-censor-filter');
          const contentBounds = bounds(content, object);
          const shellBoundsInMirror = bounds(shell, mirror);
          const shellBoundsInCockpit = bounds(shell, cockpit);
          const filter = object?.getObjectByName?.('pixel-censor-filter') || null;
          const noveltyBodyBounds = item.id === 'dangle_censored'
            ? bounds(object, object, node => {
              if (node.name === 'pixel-censor-filter') return false;
              const names = [
                node.name,
                ...(Array.isArray(node.material) ? node.material : [node.material])
                  .filter(Boolean).map(material => material.name || ''),
              ].join(' ');
              return !/cord|hanger|loop|ring|filter.skin|censor filter/i.test(names);
            })
            : null;
          const noveltyMax = noveltyBodyBounds
            ? Math.max(
              noveltyBodyBounds.size.x,
              noveltyBodyBounds.size.y,
              noveltyBodyBounds.size.z,
            ) : 0;
          const filterMaterial = filter?.material || null;
          evidence.mirror = {
            facing: mirror?.userData?.facing ?? null,
            anchorPosition: anchor?.position?.toArray?.() || null,
            shellBoundsInMirror,
            shellBoundsInCockpit,
            contentBounds,
          };
          evidence.censor = {
            present: Boolean(filter),
            isSprite: Boolean(filter?.isSprite),
            position: filter?.position?.toArray?.() || null,
            scale: filter?.scale?.toArray?.() || null,
            opacity: filterMaterial?.opacity ?? null,
            noveltyBodyBounds,
            noveltyMax,
          };
          checks.parentedToMirrorAnchor = Boolean(object && anchor
            && object.parent === anchor && anchor.parent === mirror);
          // Validate the actual hanging point, not the silhouette bounds. Some
          // intentionally asymmetric ornaments (notably Testing Coals and its
          // loose loop) have an off-center bounding box while still hanging
          // exactly from the mirror's center.
          checks.centeredUnderMirror = Boolean(anchor && object && shellBoundsInCockpit
            && Math.abs(anchor.position.x) < 0.002
            && Math.abs(object.position.x) < 0.002);
          // Compare the mount and mirror in their shared local coordinate
          // system. World-Y is not a valid attachment test once the mirror is
          // pitched toward the driver: its Z offset also changes world-Y.
          checks.topTouchesMirrorBottom = Boolean(anchor && mountBounds
            && shellBoundsInMirror
            && Math.abs(anchor.position.y - shellBoundsInMirror.min.y) < 0.003
            && Math.abs(mountBounds.max.y) < 0.002);
          checks.topNormalized = Boolean(mountBounds
            && Math.abs(mountBounds.max.y) < 0.002);
          checks.driverFacingSide = Boolean(anchor && mirror
            && Math.abs(anchor.position.z - 0.06 * mirror.userData.facing) < 0.002);
          checks.clearsDashboard = Boolean(objectBounds && dashboardBounds
            && objectBounds.min.y > dashboardBounds.max.y + 0.02);
          checks.censorCoversEntireNovelty = item.id !== 'dangle_censored'
            || Boolean(filter?.isSprite && noveltyBodyBounds
              && filter.scale.x >= noveltyMax * 1.05
              && filter.scale.x <= noveltyMax * 1.12
              && Math.abs(filter.scale.x - filter.scale.y) < 0.002
              && Math.abs(filter.position.x - noveltyBodyBounds.center.x) < 0.006
              && Math.abs(filter.position.y - noveltyBodyBounds.center.y) < 0.006
              && filterMaterial.opacity > 0.2 && filterMaterial.opacity < 0.8
              && filterMaterial.depthTest === false);
        } else {
          object = scene.hornVisual;
          objectBounds = bounds(object, cockpit);
          const cameraInCockpit = scene.camera.position.clone();
          cockpit.worldToLocal(cameraInCockpit);
          const dashboardCenterX = dashboardBounds?.center?.x ?? 0;
          const passengerSign = cameraInCockpit.x < dashboardCenterX ? 1 : -1;
          evidence.passenger = {
            driverEyeX: cameraInCockpit.x,
            dashboardCenterX,
            passengerSign,
          };
          checks.passengerSideFootprint = Boolean(objectBounds && (
            passengerSign > 0
              ? objectBounds.min.x >= dashboardCenterX - 0.002
              : objectBounds.max.x <= dashboardCenterX + 0.002
          ));
          checks.surfaceFlush = Boolean(objectBounds && dashboardBounds
            && Math.abs(objectBounds.min.y - dashboardBounds.max.y) < 0.002);
          checks.footprintInsideDashboard = Boolean(objectBounds && dashboardBounds
            && objectBounds.min.x >= dashboardBounds.min.x - 0.002
            && objectBounds.max.x <= dashboardBounds.max.x + 0.002
            && objectBounds.min.z >= dashboardBounds.min.z - 0.002
            && objectBounds.max.z <= dashboardBounds.max.z + 0.002);
          const expectedRotation = item.id === 'horn_air' ? Math.PI : 0;
          const rotationDelta = object
            ? Math.atan2(
              Math.sin(object.rotation.y - expectedRotation),
              Math.cos(object.rotation.y - expectedRotation),
            ) : Infinity;
          evidence.orientation = {
            expectedRotation,
            actualRotation: object?.rotation?.y ?? null,
            rotationDelta,
          };
          checks.expectedOrientation = Math.abs(rotationDelta) < 0.002;
        }

        const inspected = inspect(object);
        if (!object || !objectBounds)
          throw new Error('Mounted Tap cosmetic or its measured bounds are missing');
        const targetLocal = cockpit.position.clone().set(
          objectBounds.center.x,
          objectBounds.center.y,
          objectBounds.center.z,
        );
        const targetWorld = cockpit.localToWorld(targetLocal);
        const delta = targetWorld.clone().sub(scene.camera.position);
        const length = Math.max(0.0001, delta.length());
        const yaw = Math.atan2(delta.x, -delta.z);
        const pitch = Math.asin(Math.max(-1, Math.min(1, delta.y / length)));
        scene.freeLook = true;
        scene.lookYaw = scene.lookTargetYaw = scene.lookDragYaw = yaw;
        scene.lookPitch = scene.lookTargetPitch = scene.lookDragPitch = pitch;
        window.__disciplineTapCosmeticQaAimWorld = targetWorld.clone();
        const consoleErrors = [...window.__disciplineTapCosmeticQaErrors];
        window.__disciplineTapCosmeticQaErrors.length = 0;
        return {
          ...inspected,
          checks,
          evidence,
          objectBounds,
          dashboardBounds,
          targetWorld: targetWorld.toArray(),
          derivedAim: { yaw, pitch, distance: length },
          consoleErrors,
          tapMode: !scene.inGarage,
          freeLook: scene.freeLook,
          canvas: {
            width: document.querySelector('#game-canvas')?.width || 0,
            height: document.querySelector('#game-canvas')?.height || 0,
          },
        };
      })()`);

      await cdp.waitFor(`(() => {
        const scene = window.__scene;
        const target = window.__disciplineTapCosmeticQaAimWorld;
        if (!target) return false;
        const actual = scene.camera.position.clone();
        scene.camera.getWorldDirection(actual);
        const desired = target.clone().sub(scene.camera.position).normalize();
        return actual.dot(desired) > 0.999;
      })()`, {
        timeoutMs: 4_000,
        intervalMs: 50,
        description: `${auditCase.key} camera to settle on its derived world-space target`,
      });
      await wait(180);

      const failedChecks = Object.entries(placement.checks)
        .filter(([, value]) => value === false)
        .map(([name]) => name);
      if (!placement.renderableNodes || !placement.finiteTransforms)
        failedChecks.push('renderableFiniteGeometry');
      if (!placement.tapMode || !placement.freeLook) failedChecks.push('realTapFirstPersonContext');
      if (!placement.canvas.width || !placement.canvas.height) failedChecks.push('liveCanvas');
      if (placement.consoleErrors.length) failedChecks.push('consoleErrors');
      const validationError = failedChecks.length
        ? `Tap context validation failed: ${failedChecks.join(', ')}${
          placement.consoleErrors.length
            ? ` (${placement.consoleErrors.join(' | ')})` : ''}`
        : null;

      // This is intentionally Android's framebuffer, not Page.captureScreenshot:
      // WebView CDP can omit the hardware-accelerated WebGL surface.
      const raw = captureFramebuffer();
      const slotSuffix = slotIndex === null ? '' : `-slot-${slotIndex + 1}`;
      const filename = `${String(caseIndex + 1).padStart(2, '0')}-${slug(item.slot)}-${slug(item.id)}${slotSuffix}.png`;
      const file = join(output, filename);
      const subtitle = slotIndex === null
        ? `Tap FPV · ${item.slot} · aim derived from mounted world bounds`
        : `Tap FPV · dashboard slot ${slotIndex + 1}/6 · derived aim`;
      const image = await writeLabeledPng(
        raw,
        file,
        `${item.name} [${item.id}]`,
        subtitle,
      );
      const report = {
        key: auditCase.key,
        ...item,
        slotIndex,
        ok: !validationError,
        sourceLoader: asset,
        file: basename(file),
        placement,
        image,
        ...(validationError ? { error: validationError } : {}),
      };
      reports.push(report);
      captures.push({ key: auditCase.key, slot: item.slot, file });
      if (validationError) {
        failures.push({
          id: item.id,
          key: auditCase.key,
          stage: 'tap-context-validation',
          error: validationError,
          placement,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({
        id: item.id,
        key: auditCase.key,
        stage: 'render-capture',
        error: message,
      });
      reports.push({
        key: auditCase.key,
        ...item,
        slotIndex,
        ok: false,
        error: message,
      });
    }
  }
} catch (error) {
  failures.push({
    id: null,
    stage: 'fatal',
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  if (cdp && snapshotCreated) {
    try {
      await cdp.evaluate(`(() => {
        const snapshot = window.__disciplineTapCosmeticQaSnapshot;
        if (!snapshot) return false;
        const scene = window.__scene;
        const game = window.__game;
        localStorage.clear();
        for (const [key, value] of snapshot.storage) localStorage.setItem(key, value);
        for (const key of Object.keys(game.s)) delete game.s[key];
        Object.assign(game.s, snapshot.game);
        console.error = snapshot.consoleError;
        document.getElementById('discipline-tap-cosmetic-qa-style')?.remove();
        scene.setDashboardItems(snapshot.dashboardItems);
        scene.setDangler(snapshot.dangler);
        scene.setHornVisual(snapshot.horn);
        scene.setViewSettings(
          snapshot.scene.fovScale * 100,
          snapshot.scene.lookSensitivity,
          snapshot.scene.reducedMotion
        );
        if (snapshot.scene.inGarage) scene.enterGarage();
        else scene.exitGarage();
        for (const key of [
          'freeLook', 'lookYaw', 'lookPitch', 'lookTargetYaw',
          'lookTargetPitch', 'lookDragYaw', 'lookDragPitch',
        ]) scene[key] = snapshot.scene[key];
        scene.camera.quaternion.fromArray(snapshot.scene.cameraQuaternion);
        document.body.className = snapshot.bodyClass;
        if (snapshot.bodyTextTier === null) delete document.body.dataset.textTier;
        else document.body.dataset.textTier = snapshot.bodyTextTier;
        delete window.__disciplineTapCosmeticQaAimWorld;
        delete window.__disciplineTapCosmeticQaErrors;
        delete window.__disciplineTapCosmeticQaSnapshot;
        return true;
      })()`);
      await wait(900);
    } catch (error) {
      failures.push({
        id: null,
        stage: 'restore',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  cdp?.close();
}

const expectedKeys = new Set(cases.map((auditCase) => auditCase.key));
const reportedKeys = new Set(reports.map((report) => report.key));
for (const key of expectedKeys) {
  if (!reportedKeys.has(key))
    failures.push({ id: null, key, stage: 'coverage', error: 'Tap case was not reported' });
}
for (const group of ['ornament', 'dangler', 'horn']) {
  const groupCaptures = captures.filter((capture) => capture.slot === group);
  if (groupCaptures.length) {
    await writeContactSheet(
      groupCaptures,
      join(output, `contact-sheet-tap-${group}.png`),
      { columns: 4, tileWidth: 270, tileHeight: 480 },
    );
  }
}
if (captures.length) {
  await writeContactSheet(
    captures,
    join(output, 'contact-sheet-tap-fpv-all.png'),
    { columns: 4, tileWidth: 270, tileHeight: 480 },
  );
}

const audit = {
  generatedAt: new Date().toISOString(),
  tool: 'scripts/audit-android-tap-cosmetics-cdp.mjs',
  invocation: `node scripts/audit-android-tap-cosmetics-cdp.mjs --port ${port}`,
  output,
  webview,
  framebuffer: { serial, adb },
  expectedCosmetics: applicable.length,
  expectedCases: cases.length,
  capturedCases: captures.length,
  restored: !failures.some((failure) => failure.stage === 'restore'),
  cosmetics: applicable,
  items: reports,
  failures,
};
writeJson(join(output, 'audit.json'), audit);
writeJson(join(output, 'failures.json'), failures);
console.log(JSON.stringify({
  cosmetics: applicable.length,
  expectedCases: cases.length,
  captured: captures.length,
  failures: failures.length,
  output,
}));
if (failures.length) process.exitCode = 1;
