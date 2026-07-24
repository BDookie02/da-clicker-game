import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  connectAndroidWebView,
  numericOption,
  option,
  requireVisualAuditHandles,
  writeContactSheet,
  writeJson,
  writeLabeledPng,
} from './lib/android-visual-qa.mjs';

const root = resolve(import.meta.dirname, '..');
const port = numericOption('--port', 9222);
const output = resolve(root, option('--out', join('devlog', 'android-touch-look')));
const serial = option('--serial', 'emulator-5554');
const packageName = option('--package', 'com.nosiah.discipline');
const sdkRoot = process.env.ANDROID_SDK_ROOT
  || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : '');
const adbDefault = sdkRoot
  ? join(sdkRoot, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
  : 'adb';
const adb = option('--adb', adbDefault);
const duration = Number(option('--duration', '260'));
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

if (!Number.isInteger(duration) || duration < 80 || duration > 2000)
  throw new Error('--duration must be an integer from 80 through 2000 milliseconds');
if (adb !== 'adb' && !existsSync(adb))
  throw new Error(`Android adb executable was not found at ${adb}`);
mkdirSync(output, { recursive: true });

const adbBuffer = (args, options = {}) => execFileSync(adb, ['-s', serial, ...args], {
  maxBuffer: 32 * 1024 * 1024,
  windowsHide: true,
  ...options,
});
const adbText = (args) => String(adbBuffer(args, { encoding: 'utf8' })).trim();
const apiLevel = Number(adbText(['shell', 'getprop', 'ro.build.version.sdk']));
if (apiLevel !== 31)
  throw new Error(`This audit requires the Android 12 / API 31 test device; ${serial} reports API ${apiLevel}`);

const pid = adbText(['shell', 'pidof', packageName]).split(/\s+/).filter(Boolean)[0];
if (!pid)
  throw new Error(`${packageName} is not running on ${serial}; launch the exact test APK first`);
execFileSync(adb, [
  '-s', serial, 'forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`,
], { windowsHide: true });

const captureFramebuffer = () => {
  const png = adbBuffer(['exec-out', 'screencap', '-p']);
  if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    throw new Error(`Android framebuffer capture from ${serial} was not a PNG`);
  return png;
};
const devicePoint = (cssPoint, viewport, frame) => ({
  x: Math.round(frame.x + (cssPoint.x / viewport.width) * frame.width),
  y: Math.round(frame.y + (cssPoint.y / viewport.height) * frame.height),
});
const swipe = (startCss, endCss, viewport, frame) => {
  const start = devicePoint(startCss, viewport, frame);
  const end = devicePoint(endCss, viewport, frame);
  adbBuffer([
    'shell', 'input', 'touchscreen', 'swipe',
    String(start.x), String(start.y), String(end.x), String(end.y), String(duration),
  ]);
  return { start, end };
};
const motionEvent = (action, cssPoint, viewport, frame) => {
  const point = devicePoint(cssPoint, viewport, frame);
  adbBuffer([
    'shell', 'input', 'touchscreen', 'motionevent',
    action, String(point.x), String(point.y),
  ]);
  return point;
};

const checks = [];
const captures = [];
let cdp = null;
let fatal = null;
let snapshotCreated = false;
const check = (id, pass, evidence) => {
  checks.push({ id, pass: Boolean(pass), evidence });
  return Boolean(pass);
};
const eventDelta = (before, after, type) =>
  Number(after?.counts?.[type] || 0) - Number(before?.counts?.[type] || 0);

try {
  cdp = await connectAndroidWebView(port);
  const handles = await requireVisualAuditHandles(cdp, [
    'scene.enterGarage',
    'scene.exitGarage',
    'scene.beginGarageSwipe',
    'scene.garageSwipe',
    'scene.setViewSettings',
    'scene.resetTapLook',
  ]);
  const viewport = await cdp.evaluate(`(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
    screenX,
    screenY,
  }))()`);
  let pageDescription = {};
  try {
    pageDescription = JSON.parse(cdp.page.description || '{}');
  } catch {
    pageDescription = {};
  }
  const frame = {
    x: Number.isFinite(pageDescription.screenX)
      ? pageDescription.screenX : Math.round(viewport.screenX * viewport.dpr),
    y: Number.isFinite(pageDescription.screenY)
      ? pageDescription.screenY : Math.round(viewport.screenY * viewport.dpr),
    width: Number.isFinite(pageDescription.width) && pageDescription.width > 0
      ? pageDescription.width : Math.round(viewport.width * viewport.dpr),
    height: Number.isFinite(pageDescription.height) && pageDescription.height > 0
      ? pageDescription.height : Math.round(viewport.height * viewport.dpr),
  };
  const scaleX = frame.width / viewport.width;
  const scaleY = frame.height / viewport.height;
  check(
    'webview-frame-maps-css-to-android',
    frame.width > 0 && frame.height > 0 && Math.abs(scaleX - scaleY) < 0.08,
    { apiLevel, serial, pid, handles, viewport, frame, scaleX, scaleY, pageDescription },
  );

  await cdp.evaluate(`(() => {
    if (window.__disciplineTouchQaSnapshot)
      throw new Error('A touch-look audit snapshot already exists');
    const scene = window.__scene;
    const ui = window.__ui;
    window.__disciplineTouchQaSnapshot = {
      lookSensitivity: scene.lookSensitivity,
      fovScale: scene.fovScale,
      reducedMotion: scene.reducedMotion,
      inGarage: Boolean(scene.inGarage),
      garageFP: Boolean(scene.garageFP),
      openTab: ui.openTab || null,
    };
    const style = document.createElement('style');
    style.id = 'discipline-touch-qa-style';
    style.textContent = [
      '.title-screen,.tutorial-layer,.ad-overlay,.fade{',
      'visibility:hidden!important;pointer-events:none!important;',
      '}',
    ].join('');
    document.head.appendChild(style);
    const counts = { pointerdown: 0, pointermove: 0, pointerup: 0, pointercancel: 0 };
    const last = {};
    const history = [];
    const handlers = {};
    for (const type of Object.keys(counts)) {
      const handler = event => {
        counts[type] += 1;
        const target = event.target;
        last[type] = {
          time: performance.now(),
          x: event.clientX,
          y: event.clientY,
          pointerType: event.pointerType,
          target: target && target.nodeType === 1
            ? [target.tagName.toLowerCase(), target.id ? '#' + target.id : '',
              target.className && typeof target.className === 'string'
                ? '.' + target.className.trim().replace(/\\s+/g, '.') : ''].join('')
            : String(target),
        };
        history.push({ type, ...last[type] });
        if (history.length > 2000) history.splice(0, history.length - 2000);
      };
      handlers[type] = handler;
      window.addEventListener(type, handler, true);
    }
    window.__disciplineTouchQaEvents = { counts, last, history };
    window.__disciplineTouchQaHandlers = handlers;
    ui.close();
    scene.exitGarage();
    scene.resetTapLook();
    return true;
  })()`);
  snapshotCreated = true;
  await wait(400);

  const readEvents = () => cdp.evaluate(`(() => {
    const source = window.__disciplineTouchQaEvents;
    return JSON.parse(JSON.stringify(source));
  })()`);
  const mainCancelPoint = { x: viewport.width * 0.50, y: viewport.height * 0.50 };
  const mainBefore = await cdp.evaluate(`(() => ({
    events: JSON.parse(JSON.stringify(window.__disciplineTouchQaEvents)),
    totalTaps: window.__game.s.totalTaps,
    freeLook: window.__scene.freeLook,
  }))()`);
  const mainDown = motionEvent('DOWN', mainCancelPoint, viewport, frame);
  await wait(80);
  const mainCancel = motionEvent('CANCEL', mainCancelPoint, viewport, frame);
  await wait(250);
  const mainAfter = await cdp.evaluate(`(() => ({
    events: JSON.parse(JSON.stringify(window.__disciplineTouchQaEvents)),
    totalTaps: window.__game.s.totalTaps,
    freeLook: window.__scene.freeLook,
  }))()`);
  check(
    'pointercancel-never-awards-main-tap',
    eventDelta(mainBefore.events, mainAfter.events, 'pointerdown') >= 1
      && eventDelta(mainBefore.events, mainAfter.events, 'pointercancel') >= 1
      && mainAfter.totalTaps === mainBefore.totalTaps,
    { cssPoint: mainCancelPoint, mainDown, mainCancel, before: mainBefore, after: mainAfter },
  );

  const capture = async (name, title, subtitle) => {
    const file = join(output, `${name}.png`);
    const metadata = await writeLabeledPng(
      captureFramebuffer(),
      file,
      title,
      subtitle,
    );
    captures.push({ name, file, ...metadata });
  };
  const resetView = async (mode, sensitivity) => {
    await cdp.evaluate(`(() => {
      const scene = window.__scene;
      const snapshot = window.__disciplineTouchQaSnapshot;
      scene.setViewSettings(snapshot.fovScale * 100, ${JSON.stringify(sensitivity)}, true);
      if (${JSON.stringify(mode)} === 'tap-main-fpv') {
        window.__ui.close();
        scene.exitGarage();
        const world = scene.opponentAnchor.position.clone();
        world.set(
          scene.opponentAnchor.position.x - 0.45,
          scene.spritePos.y + 0.05,
          scene.opponentAnchor.position.z - scene.spritePos.z
        );
        const delta = world.clone().sub(scene.camera.position);
        const length = Math.max(0.0001, delta.length());
        const yaw = Math.atan2(delta.x, -delta.z);
        const pitch = Math.asin(Math.max(-1, Math.min(1, delta.y / length)));
        scene.freeLook = true;
        scene.lookYaw = scene.lookTargetYaw = scene.lookDragYaw = yaw;
        scene.lookPitch = scene.lookTargetPitch = scene.lookDragPitch = pitch;
      } else {
        if (!scene.inGarage) scene.enterGarage();
        scene.garageFP = true;
        scene.fpYaw = 0;
        scene.fpTargetYaw = 0;
        scene.fpDragYaw = 0;
        scene.fpPitch = -0.08;
        scene.fpTargetPitch = -0.08;
        scene.fpDragPitch = -0.08;
      }
      return true;
    })()`);
    await wait(350);
  };
  const projectLandmark = (mode) => cdp.evaluate(`(() => {
    const scene = window.__scene;
    let name;
    let world;
    let camera;
    if (${JSON.stringify(mode)} === 'tap-main-fpv') {
      name = 'opponent-driver-face-anchor';
      world = scene.opponentAnchor.position.clone();
      world.set(
        scene.opponentAnchor.position.x - 0.45,
        scene.spritePos.y + 0.05,
        scene.opponentAnchor.position.z - scene.spritePos.z
      );
      camera = scene.camera;
      scene.opponentAnchor.updateMatrixWorld(true);
    } else {
      const landmark = scene.garageCar && scene.garageCar.getObjectByName('steering-wheel');
      if (!landmark) throw new Error('Fixed steering-wheel landmark is missing');
      name = landmark.name;
      scene.garageCar.updateMatrixWorld(true);
      world = landmark.position.clone();
      landmark.getWorldPosition(world);
      camera = scene.garageCam;
    }
    camera.updateMatrixWorld(true);
    const ndc = world.clone().project(camera);
    return {
      mode: ${JSON.stringify(mode)},
      name,
      fixedWorld: [world.x, world.y, world.z],
      x: (ndc.x * 0.5 + 0.5) * innerWidth,
      y: (-ndc.y * 0.5 + 0.5) * innerHeight,
      ndc: [ndc.x, ndc.y, ndc.z],
      visible: ndc.z >= -1 && ndc.z <= 1
        && ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1,
      camera: ${JSON.stringify(mode)} === 'tap-main-fpv' ? {
        yaw: scene.lookYaw,
        pitch: scene.lookPitch,
        targetYaw: scene.lookTargetYaw,
        targetPitch: scene.lookTargetPitch,
      } : {
        yaw: scene.fpYaw,
        pitch: scene.fpPitch,
        targetYaw: scene.fpTargetYaw,
        targetPitch: scene.fpTargetPitch,
      },
    };
  })()`);
  const startMotionSampling = (mode, axis) => cdp.evaluate(`(() => {
    const scene = window.__scene;
    const audit = {
      mode: ${JSON.stringify(mode)},
      axis: ${JSON.stringify(axis)},
      startedAt: performance.now(),
      done: false,
      samples: [],
    };
    window.__disciplineTouchQaMotion = audit;
    const project = () => {
      let world;
      let camera;
      if (audit.mode === 'tap-main-fpv') {
        world = scene.opponentAnchor.position.clone();
        world.set(
          scene.opponentAnchor.position.x - 0.45,
          scene.spritePos.y + 0.05,
          scene.opponentAnchor.position.z - scene.spritePos.z
        );
        camera = scene.camera;
      } else {
        const landmark = scene.garageCar && scene.garageCar.getObjectByName('steering-wheel');
        if (!landmark) throw new Error('Fixed steering-wheel landmark is missing');
        scene.garageCar.updateMatrixWorld(true);
        world = landmark.position.clone();
        landmark.getWorldPosition(world);
        camera = scene.garageCam;
      }
      camera.updateMatrixWorld(true);
      const ndc = world.clone().project(camera);
      return {
        x: (ndc.x * 0.5 + 0.5) * innerWidth,
        y: (-ndc.y * 0.5 + 0.5) * innerHeight,
        yaw: audit.mode === 'tap-main-fpv' ? scene.lookYaw : scene.fpYaw,
        pitch: audit.mode === 'tap-main-fpv' ? scene.lookPitch : scene.fpPitch,
        targetYaw: audit.mode === 'tap-main-fpv' ? scene.lookTargetYaw : scene.fpTargetYaw,
        targetPitch: audit.mode === 'tap-main-fpv' ? scene.lookTargetPitch : scene.fpTargetPitch,
      };
    };
    // ADB process startup can take over a second before Android emits the
    // first pointer event. Keep sampling well beyond that transport delay so
    // post-release settling is measured instead of accidentally clipped.
    const deadline = audit.startedAt + ${JSON.stringify(duration + 3500)};
    const sample = time => {
      audit.samples.push({ time, ...project() });
      if (time < deadline) requestAnimationFrame(sample);
      else audit.done = true;
    };
    requestAnimationFrame(sample);
    return true;
  })()`);
  const percentile = (values, fraction) => {
    if (!values.length) return null;
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
  };
  const analyzeMotion = (motion, eventsBefore, eventsAfter, axis, requested) => {
    const history = (eventsAfter.history || []).slice((eventsBefore.history || []).length);
    const down = history.find((event) => event.type === 'pointerdown') || null;
    const up = history.find((event) => event.type === 'pointerup') || null;
    const samples = motion.samples || [];
    const startTime = down?.time ?? motion.startedAt;
    const stopTime = (up?.time ?? startTime + duration) + 400;
    const relevant = samples.filter((sample) =>
      sample.time >= startTime - 20 && sample.time <= stopTime);
    const frameIntervals = relevant.slice(1).map((sample, index) =>
      sample.time - relevant[index].time);
    const key = axis === 'x' ? 'x' : 'y';
    const expectedSign = Math.sign(requested);
    let reversals = 0;
    let forwardDistance = 0;
    let reverseDistance = 0;
    for (let index = 1; index < relevant.length; index += 1) {
      const delta = relevant[index][key] - relevant[index - 1][key];
      if (Math.abs(delta) < 0.35) continue;
      if (Math.sign(delta) === expectedSign) forwardDistance += Math.abs(delta);
      else {
        reversals += 1;
        reverseDistance += Math.abs(delta);
      }
    }
    const finalPosition = relevant.length ? relevant[relevant.length - 1][key] : null;
    let settleMs = null;
    if (up && finalPosition !== null) {
      for (let index = 0; index <= relevant.length - 4; index += 1) {
        if (relevant[index].time < up.time) continue;
        const stable = relevant.slice(index, index + 4)
          .every((sample) => Math.abs(sample[key] - finalPosition) <= 1.25);
        if (stable) {
          settleMs = Math.max(0, relevant[index].time - up.time);
          break;
        }
      }
    }
    const frameP95Ms = percentile(frameIntervals, 0.95);
    const frameMaxMs = frameIntervals.length ? Math.max(...frameIntervals) : null;
    return {
      sampleCount: relevant.length,
      pointerTimeline: { down, up },
      frameIntervals: {
        count: frameIntervals.length,
        p95Ms: frameP95Ms,
        maxMs: frameMaxMs,
      },
      expectedSign,
      reversals,
      forwardDistance,
      reverseDistance,
      monotonicFraction: forwardDistance / Math.max(0.001, forwardDistance + reverseDistance),
      settleMs,
      smoothAndMonotonic:
        relevant.length >= 12
        && reversals === 0
        && frameP95Ms !== null && frameP95Ms <= 34
        && frameMaxMs !== null && frameMaxMs <= 67
        && settleMs !== null && settleMs <= 300,
    };
  };
  const runSingleSwipeCase = async ({
    id,
    mode,
    axis,
    sensitivity,
    start,
    end,
    captureProof = true,
  }) => {
    await resetView(mode, sensitivity);
    const before = await projectLandmark(mode);
    const eventsBefore = await readEvents();
    if (captureProof)
      await capture(`${id}-before`, `${id}: BEFORE`, `${mode} · ${before.name}`);
    await startMotionSampling(mode, axis);
    await wait(50);
    const physical = swipe(start, end, viewport, frame);
    await cdp.waitFor(
      `Boolean(window.__disciplineTouchQaMotion && window.__disciplineTouchQaMotion.done)`,
      { timeoutMs: duration + 5_000, description: `${id} frame-by-frame motion sampling` },
    );
    const motion = await cdp.evaluate(
      `JSON.parse(JSON.stringify(window.__disciplineTouchQaMotion))`,
    );
    const after = await projectLandmark(mode);
    const eventsAfter = await readEvents();
    if (captureProof)
      await capture(`${id}-after`, `${id}: AFTER`, `${mode} · ${after.name}`);
    const fingerDelta = { x: end.x - start.x, y: end.y - start.y };
    const landmarkDelta = { x: after.x - before.x, y: after.y - before.y };
    const requested = axis === 'x' ? fingerDelta.x : fingerDelta.y;
    const rendered = axis === 'x' ? landmarkDelta.x : landmarkDelta.y;
    const motionQuality = analyzeMotion(motion, eventsBefore, eventsAfter, axis, requested);
    return {
      id,
      mode,
      axis,
      sensitivity,
      start,
      end,
      physical,
      before,
      after,
      fingerDelta,
      landmarkDelta,
      requested,
      rendered,
      followsFinger: Math.sign(rendered) === Math.sign(requested) && Math.abs(rendered) >= 4,
      physicalTouchObserved:
        eventDelta(eventsBefore, eventsAfter, 'pointerdown') >= 1
        && eventDelta(eventsBefore, eventsAfter, 'pointermove') >= 1
        && eventDelta(eventsBefore, eventsAfter, 'pointerup') >= 1,
      eventDelta: {
        pointerdown: eventDelta(eventsBefore, eventsAfter, 'pointerdown'),
        pointermove: eventDelta(eventsBefore, eventsAfter, 'pointermove'),
        pointerup: eventDelta(eventsBefore, eventsAfter, 'pointerup'),
        pointercancel: eventDelta(eventsBefore, eventsAfter, 'pointercancel'),
      },
      lastEvents: eventsAfter.last,
      motionQuality,
    };
  };
  const runSwipeCase = async (options) => {
    const attempts = [];
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      const attempt = await runSingleSwipeCase({
        ...options,
        id: attemptNumber === 1
          ? options.id
          : `${options.id}-retry-${attemptNumber}`,
      });
      attempts.push(attempt);
      const validPhysicalGesture = attempt.followsFinger
        && attempt.physicalTouchObserved
        && attempt.before.visible
        && attempt.after.visible;
      if (validPhysicalGesture && attempt.motionQuality.smoothAndMonotonic) {
        return {
          ...attempt,
          id: options.id,
          attemptNumber,
          attempts: attempts.map((entry) => ({
            id: entry.id,
            followsFinger: entry.followsFinger,
            physicalTouchObserved: entry.physicalTouchObserved,
            eventDelta: entry.eventDelta,
            motionQuality: entry.motionQuality,
          })),
        };
      }
      // Android's `input swipe` occasionally emits only DOWN/UP or pauses the
      // emulator compositor for exactly the requested swipe duration. Retry
      // those transport failures instead of mistaking them for game behavior.
      await wait(350);
    }
    const best = [...attempts].sort((left, right) => {
      const score = (entry) =>
        Number(entry.followsFinger) * 4
        + Number(entry.physicalTouchObserved) * 4
        + Number(entry.motionQuality.smoothAndMonotonic) * 2
        + Number(entry.before.visible && entry.after.visible);
      return score(right) - score(left);
    })[0];
    return {
      ...best,
      id: options.id,
      attemptNumber: attempts.indexOf(best) + 1,
      attempts: attempts.map((entry) => ({
        id: entry.id,
        followsFinger: entry.followsFinger,
        physicalTouchObserved: entry.physicalTouchObserved,
        eventDelta: entry.eventDelta,
        motionQuality: entry.motionQuality,
      })),
    };
  };

  const tapHorizontal = await runSwipeCase({
    id: 'tap-main-fpv-horizontal-follow',
    mode: 'tap-main-fpv',
    axis: 'x',
    sensitivity: 1,
    start: { x: viewport.width * 0.42, y: viewport.height * 0.50 },
    end: { x: viewport.width * 0.48, y: viewport.height * 0.50 },
  });
  check(
    'tap-main-fpv-horizontal-rendered-content-follows-finger',
    tapHorizontal.followsFinger && tapHorizontal.physicalTouchObserved
      && tapHorizontal.before.visible && tapHorizontal.after.visible,
    tapHorizontal,
  );
  const tapVertical = await runSwipeCase({
    id: 'tap-main-fpv-vertical-follow',
    mode: 'tap-main-fpv',
    axis: 'y',
    sensitivity: 1,
    start: { x: viewport.width * 0.50, y: viewport.height * 0.47 },
    end: { x: viewport.width * 0.50, y: viewport.height * 0.53 },
  });
  check(
    'tap-main-fpv-vertical-rendered-content-follows-finger',
    tapVertical.followsFinger && tapVertical.physicalTouchObserved
      && tapVertical.before.visible && tapVertical.after.visible,
    tapVertical,
  );
  check(
    'tap-main-fpv-motion-is-smooth-monotonic-and-settles',
    tapHorizontal.motionQuality.smoothAndMonotonic
      && tapVertical.motionQuality.smoothAndMonotonic,
    {
      horizontal: tapHorizontal.motionQuality,
      vertical: tapVertical.motionQuality,
    },
  );

  await cdp.evaluate(`(() => {
    const ui = window.__ui;
    const scene = window.__scene;
    ui.close();
    scene.exitGarage();
    const button = document.querySelector('[data-tab="garage"]');
    if (!button) throw new Error('GARAGE tab button is missing');
    button.click();
    return true;
  })()`);
  await cdp.waitFor(
    `Boolean(window.__scene.inGarage && document.querySelector('.panel-garage.collapsed'))`,
    { timeoutMs: 5_000, description: 'collapsed garage and its rendered car' },
  );
  await wait(500);

  const formerAreaY = viewport.height * 0.60;
  const formerAreaPoint = { x: viewport.width * 0.50, y: formerAreaY };
  const formerArea = await cdp.evaluate(`(() => {
    const x = innerWidth * 0.50;
    const y = innerHeight * 0.60;
    const panel = document.querySelector('.panel-garage.collapsed');
    const bar = panel && panel.querySelector('.garage-bar');
    const target = document.elementFromPoint(x, y);
    const describe = element => element ? {
      tag: element.tagName,
      id: element.id,
      className: typeof element.className === 'string' ? element.className : '',
      rect: (() => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      })(),
    } : null;
    return {
      point: { x, y },
      historicalTop: innerHeight * 0.42,
      panel: describe(panel),
      bar: describe(bar),
      target: describe(target),
      insideHistoricalCollapsedArea: y > innerHeight * 0.42
        && (!bar || y < bar.getBoundingClientRect().top - 4),
      targetIsButton: Boolean(target && target.closest('button')),
    };
  })()`);
  check(
    'gesture-point-is-inside-former-collapsed-panel-area',
    formerArea.insideHistoricalCollapsedArea && !formerArea.targetIsButton,
    formerArea,
  );

  await cdp.evaluate(`(() => {
    const scene = window.__scene;
    scene.garageFP = false;
    scene.garageYaw = scene.garageTargetYaw = scene.garageDragYaw = 0.8;
    scene.garagePitch = scene.garageTargetPitch = scene.garageDragPitch = 0.3;
    return true;
  })()`);
  const garageCancelBefore = await cdp.evaluate(`(() => ({
    events: JSON.parse(JSON.stringify(window.__disciplineTouchQaEvents)),
    garageFP: window.__scene.garageFP,
  }))()`);
  const garageDown = motionEvent('DOWN', formerAreaPoint, viewport, frame);
  await wait(80);
  const garageCancel = motionEvent('CANCEL', formerAreaPoint, viewport, frame);
  await wait(250);
  const garageCancelAfter = await cdp.evaluate(`(() => ({
    events: JSON.parse(JSON.stringify(window.__disciplineTouchQaEvents)),
    garageFP: window.__scene.garageFP,
  }))()`);
  check(
    'pointercancel-never-toggles-garage-camera',
    eventDelta(garageCancelBefore.events, garageCancelAfter.events, 'pointerdown') >= 1
      && eventDelta(garageCancelBefore.events, garageCancelAfter.events, 'pointercancel') >= 1
      && garageCancelAfter.garageFP === garageCancelBefore.garageFP,
    {
      cssPoint: formerAreaPoint,
      garageDown,
      garageCancel,
      before: garageCancelBefore,
      after: garageCancelAfter,
    },
  );

  const garageHorizontal = await runSwipeCase({
    id: 'garage-fpv-horizontal-follow',
    mode: 'garage-fpv',
    axis: 'x',
    sensitivity: 1,
    start: { x: viewport.width * 0.42, y: formerAreaY },
    end: { x: viewport.width * 0.48, y: formerAreaY },
  });
  check(
    'garage-fpv-horizontal-rendered-content-follows-finger',
    garageHorizontal.followsFinger && garageHorizontal.physicalTouchObserved
      && garageHorizontal.before.visible && garageHorizontal.after.visible,
    garageHorizontal,
  );
  check(
    'collapsed-garage-area-does-not-block-physical-gesture',
    formerArea.insideHistoricalCollapsedArea
      && garageHorizontal.followsFinger && Math.abs(garageHorizontal.rendered) >= 4,
    { formerArea, horizontal: garageHorizontal },
  );

  const garageVertical = await runSwipeCase({
    id: 'garage-fpv-vertical-follow',
    mode: 'garage-fpv',
    axis: 'y',
    sensitivity: 1,
    start: { x: viewport.width * 0.50, y: viewport.height * 0.56 },
    end: { x: viewport.width * 0.50, y: viewport.height * 0.62 },
  });
  check(
    'garage-fpv-vertical-rendered-content-follows-finger',
    garageVertical.followsFinger && garageVertical.physicalTouchObserved
      && garageVertical.before.visible && garageVertical.after.visible,
    garageVertical,
  );
  check(
    'garage-fpv-motion-is-smooth-monotonic-and-settles',
    garageHorizontal.motionQuality.smoothAndMonotonic
      && garageVertical.motionQuality.smoothAndMonotonic,
    {
      horizontal: garageHorizontal.motionQuality,
      vertical: garageVertical.motionQuality,
    },
  );

  const sensitivityStart = { x: viewport.width * 0.45, y: formerAreaY };
  const sensitivityEnd = { x: viewport.width * 0.485, y: formerAreaY };
  const lowSensitivity = await runSwipeCase({
    id: 'sensitivity-0-5x',
    mode: 'garage-fpv',
    axis: 'x',
    sensitivity: 0.5,
    start: sensitivityStart,
    end: sensitivityEnd,
  });
  const highSensitivity = await runSwipeCase({
    id: 'sensitivity-2-0x',
    mode: 'garage-fpv',
    axis: 'x',
    sensitivity: 2,
    start: sensitivityStart,
    end: sensitivityEnd,
  });
  const sensitivityRatio = Math.abs(highSensitivity.rendered)
    / Math.max(0.001, Math.abs(lowSensitivity.rendered));
  check(
    'sensitivity-setting-scales-rendered-movement',
    lowSensitivity.followsFinger && highSensitivity.followsFinger
      && lowSensitivity.physicalTouchObserved && highSensitivity.physicalTouchObserved
      && sensitivityRatio >= 2.25,
    { sensitivityRatio, lowSensitivity, highSensitivity },
  );
} catch (error) {
  fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  check('audit-completed-without-fatal-error', false, { fatal });
} finally {
  if (cdp && snapshotCreated) {
    try {
      await cdp.evaluate(`(() => {
        const snapshot = window.__disciplineTouchQaSnapshot;
        const handlers = window.__disciplineTouchQaHandlers || {};
        for (const type of Object.keys(handlers))
          window.removeEventListener(type, handlers[type], true);
        document.querySelector('#discipline-touch-qa-style')?.remove();
        const scene = window.__scene;
        const ui = window.__ui;
        ui.close();
        scene.exitGarage();
        scene.setViewSettings(
          snapshot.fovScale * 100,
          snapshot.lookSensitivity,
          snapshot.reducedMotion
        );
        scene.resetTapLook();
        delete window.__disciplineTouchQaEvents;
        delete window.__disciplineTouchQaHandlers;
        delete window.__disciplineTouchQaSnapshot;
        return true;
      })()`);
      await wait(350);
    } catch (error) {
      check('audit-cleanup-completed', false, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  cdp?.close();
}

if (captures.length) {
  await writeContactSheet(
    captures,
    join(output, 'contact-sheet-touch-look.png'),
    { columns: 4, tileWidth: 270, tileHeight: 480 },
  );
}
const failures = checks.filter((entry) => !entry.pass);
const report = {
  generatedAt: new Date().toISOString(),
  apiLevel,
  serial,
  packageName,
  adb,
  duration,
  cases: checks.length,
  failures: failures.length,
  fatal,
  checks,
  captures,
};
writeJson(join(output, 'audit.json'), report);
writeJson(join(output, 'failures.json'), failures);
console.log(JSON.stringify({
  cases: checks.length,
  failures: failures.length,
  output,
  contactSheet: captures.length ? join(output, 'contact-sheet-touch-look.png') : null,
}));
if (failures.length) process.exitCode = 1;
