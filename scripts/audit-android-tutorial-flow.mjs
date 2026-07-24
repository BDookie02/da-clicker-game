import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeContactSheet } from './lib/android-visual-qa.mjs';

const root = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (index === argv.length - 1 || argv[index + 1].startsWith('--'))
    throw new Error(`${name} requires a value`);
  return argv[index + 1];
};
const positionalPort = argv[0] && !argv[0].startsWith('--') ? argv[0] : '9222';
const port = Number(option('--port', positionalPort));
const captureEnabled = !argv.includes('--no-captures') && argv[1] !== 'no-captures';
const output = resolve(root, option('--out', join('devlog', 'android-tutorial-flow')));
const serial = option('--serial', 'emulator-5554');
const packageName = option('--package', 'com.nosiah.discipline');
const sdkRoot = process.env.ANDROID_SDK_ROOT
  || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : '');
const adbDefault = sdkRoot
  ? join(sdkRoot, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
  : 'adb';
const adb = option('--adb', adbDefault);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('--port must be a valid TCP port');
if (adb !== 'adb' && !existsSync(adb))
  throw new Error(`Android adb executable was not found at ${adb}`);
mkdirSync(output, { recursive: true });

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
const adbBuffer = (args, options = {}) => execFileSync(adb, ['-s', serial, ...args], {
  maxBuffer: 32 * 1024 * 1024,
  windowsHide: true,
  ...options,
});
const adbText = args => String(adbBuffer(args, { encoding: 'utf8' })).trim();
const pid = adbText(['shell', 'pidof', packageName]).split(/\s+/).filter(Boolean)[0];
if (!pid) throw new Error(`${packageName} is not running on ${serial}; launch the exact test APK first`);
execFileSync(adb, [
  '-s', serial, 'forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`,
], { windowsHide: true });
const captureFramebuffer = () => {
  const png = adbBuffer(['exec-out', 'screencap', '-p']);
  if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    throw new Error(`Android framebuffer capture from ${serial} was not a PNG`);
  return png;
};

const pages = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
const page = pages.find(candidate => candidate.type === 'page'
  && candidate.webSocketDebuggerUrl
  && /discipline|localhost|127\.0\.0\.1|capacitor/i.test(
    `${candidate.title || ''} ${candidate.url || ''}`,
  )) ?? pages.find(candidate => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
if (!page) throw new Error('No Android WebView page found');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => {
  ws.onopen = resolveOpen;
  ws.onerror = rejectOpen;
});
let sequence = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(String(data));
  if (!pending.has(message.id)) return;
  const handlers = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(handlers.timer);
  message.error
    ? handlers.reject(new Error(JSON.stringify(message.error)))
    : handlers.resolve(message.result);
};
const call = (method, params = {}, timeoutMs = 20_000) =>
  new Promise((resolveCall, rejectCall) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCall(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async expression => {
  const reply = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (reply.exceptionDetails)
    throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result.value;
};
const waitFor = async (expression, description, timeoutMs = 12_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (last) return last;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(last)}`);
};

await call('Runtime.enable');
await call('Page.enable');
await call('Emulation.clearDeviceMetricsOverride').catch(() => undefined);

const reports = [];
const captures = [];
let originalSnapshot = null;
let newDocumentScriptId = null;
let runError = null;
let restoreError = null;

const eventDelta = (before, after, type) =>
  Number(after?.counts?.[type] || 0) - Number(before?.counts?.[type] || 0);
const readEvents = () => evaluate(`(() => {
  const source=window.__disciplineTutorialFlowEvents;
  return source?JSON.parse(JSON.stringify(source)):null;
})()`);
const capture = (file) => {
  if (!captureEnabled) return;
  const path = join(output, file);
  writeFileSync(path, captureFramebuffer());
  captures.push({ file: path });
};

try {
  originalSnapshot = await evaluate(`(() => {
    if(!window.__tutorial||!window.__ui||!window.__game)
      throw new Error('Visual-audit handles are absent. Install an npm run build:test APK.');
    const account=window.__ui.account||null;
    if(account)account.cloudReadyAccountId='';
    return {
      storage:Object.entries(localStorage),
      game:JSON.parse(JSON.stringify(window.__game.s)),
    };
  })()`);

  // During the synthetic first-launch reload, external account calls are
  // forced offline. Capacitor's own local origin remains available. This keeps
  // the audit from uploading its temporary taps or tutorial flag. Seed the
  // temporary save in the new document, before Game is constructed: writing it
  // in the old document is unsafe because its beforeunload save would overwrite
  // the synthetic first-launch state during Page.reload.
  const reloadMarker = `tutorial-flow-${Date.now()}-${Math.random()}`;
  const addScript = await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      if(window!==window.top)return;
      window.__disciplineTutorialReloadMarker=${JSON.stringify(reloadMarker)};
      const save=${JSON.stringify(originalSnapshot.game)};
      save.textSizeTier=3;
      save.tutorialComplete=false;
      save.username=save.username||'VISUALQA';
      save.prestiges=0;
      save.respect=0;
      save.mentality=0;
      save.totalTaps=0;
      save.opponentIndex=0;
      save.opponentProgress=0;
      save.upgradeLevels={};
      save.crewCounts={};
      save.labOwned=[];
      save.boostMult=1;
      save.boostEndsAt=0;
      save.infiniteCurrency=false;
      save.lastSeen=Date.now();
      localStorage.setItem('discipline-clicker-save-v1',JSON.stringify(save));
      const nativeFetch=window.fetch.bind(window);
      window.fetch=(input,init)=>{
        const raw=typeof input==='string'?input:input?.url;
        try{
          const url=new URL(raw,location.href);
          if(/^https?:$/.test(url.protocol)&&url.origin!==location.origin)
            return Promise.reject(new TypeError('External network disabled by tutorial visual QA'));
        }catch{}
        return nativeFetch(input,init);
      };
    })();`,
  });
  newDocumentScriptId = addScript.identifier;

  await call('Page.reload', { ignoreCache: true });
  await waitFor(
    `Boolean(window.__disciplineTutorialReloadMarker===${JSON.stringify(reloadMarker)}
      &&document.querySelector('.title-screen')&&window.__tutorial&&window.__ui&&window.__game)`,
    'the fresh title screen and visual-audit handles',
  );
  await evaluate(`(() => {
    const account=window.__ui.account;
    if(account){
      account.cloudReadyAccountId='';
      account.save=async()=>false;
      account.sync=async()=>null;
    }
    const counts={pointerdown:0,pointerup:0,click:0};
    const history=[];
    const handlers={};
    for(const type of Object.keys(counts)){
      const handler=event=>{
        counts[type]+=1;
        history.push({
          type,
          time:performance.now(),
          x:event.clientX,
          y:event.clientY,
          pointerType:event.pointerType||'',
          target:event.target instanceof Element
            ? event.target.tagName.toLowerCase()
              +(event.target.id?'#'+event.target.id:'')
              +(typeof event.target.className==='string'&&event.target.className
                ?'.'+event.target.className.trim().replace(/\\s+/g,'.'):'')
            :String(event.target),
        });
        if(history.length>1000)history.splice(0,history.length-1000);
      };
      handlers[type]=handler;
      window.addEventListener(type,handler,true);
    }
    window.__disciplineTutorialFlowEvents={counts,history};
    window.__disciplineTutorialFlowHandlers=handlers;
    return true;
  })()`);

  const viewport = await evaluate(`(() => ({
    width:innerWidth,
    height:innerHeight,
    dpr:devicePixelRatio,
    screenX,
    screenY,
  }))()`);
  let pageDescription = {};
  try {
    pageDescription = JSON.parse(page.description || '{}');
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
  if (!(frame.width > 0 && frame.height > 0 && Math.abs(scaleX - scaleY) < 0.08))
    throw new Error(`WebView-to-Android coordinate mapping is invalid: ${JSON.stringify({
      viewport, frame, scaleX, scaleY, pageDescription,
    })}`);
  const devicePoint = cssPoint => ({
    x: Math.round(frame.x + (cssPoint.x / viewport.width) * frame.width),
    y: Math.round(frame.y + (cssPoint.y / viewport.height) * frame.height),
  });
  const pointFor = async (selector, description) => {
    const point = await evaluate(`(() => {
      const element=document.querySelector(${JSON.stringify(selector)});
      if(!element)return null;
      const style=getComputedStyle(element),box=element.getBoundingClientRect();
      if(style.display==='none'||style.visibility==='hidden'||box.width<2||box.height<2)
        return null;
      return {
        x:box.left+box.width/2,
        y:box.top+box.height/2,
        box:box.toJSON?.()||null,
      };
    })()`);
    if (!point) throw new Error(`${description} (${selector}) is not physically tappable`);
    return point;
  };
  const physicalTap = async (selector, description, settleMs = 240) => {
    const css = await pointFor(selector, description);
    const device = devicePoint(css);
    const before = await readEvents();
    adbBuffer(['shell', 'input', 'tap', String(device.x), String(device.y)]);
    await wait(settleMs);
    const after = await readEvents();
    return {
      selector,
      description,
      css,
      device,
      eventDelta: {
        pointerdown: eventDelta(before, after, 'pointerdown'),
        pointerup: eventDelta(before, after, 'pointerup'),
        click: eventDelta(before, after, 'click'),
      },
      physicalTouchObserved: eventDelta(before, after, 'pointerdown') >= 1
        && eventDelta(before, after, 'pointerup') >= 1,
    };
  };

  const titleTap = await physicalTap('.title-screen', 'title-screen engage');
  await waitFor(`Boolean(document.querySelector('.tutorial-layer'))`,
    'the automatic first-launch tutorial', 15_000);

  capture('skip-before.png');
  const skipBefore = await evaluate(`(() => ({
    index:window.__tutorial.index,
    active:window.__tutorial.active,
    tutorialComplete:window.__game.s.tutorialComplete,
  }))()`);
  const skipTap = await physicalTap('.tutorial-skip', 'SKIP TUTORIAL');
  await waitFor(`!document.querySelector('.tutorial-layer')`, 'tutorial skip completion');
  const skipAfter = await evaluate(`(() => ({
    index:window.__tutorial.index,
    active:window.__tutorial.active,
    tutorialComplete:window.__game.s.tutorialComplete,
    panelOpen:window.__ui.isPanelOpen,
  }))()`);
  capture('skip-after.png');
  reports.push({
    scenario: 'skip-path',
    titleTap,
    before: skipBefore,
    tap: skipTap,
    after: skipAfter,
    ok: titleTap.physicalTouchObserved
      && skipTap.physicalTouchObserved
      && skipBefore.index === 0
      && skipBefore.active === true
      && skipAfter.active === false
      && skipAfter.tutorialComplete === true
      && skipAfter.panelOpen === false,
    viewport,
    frame,
  });

  await evaluate(`(() => {
    window.__game.s.tutorialComplete=false;
    window.__game.save();
    window.__ui.close();
    window.__tutorial.start();
    return true;
  })()`);
  await waitFor(`Boolean(document.querySelector('.tutorial-layer')
    &&window.__tutorial.active&&window.__tutorial.index===0)`,
  'the restarted full tutorial');

  const actions = [
    { selector: '.tutorial-focus', description: 'driver eye-contact focus', taps: 3 },
    { selector: '[data-tab="upgrades"]', description: 'UPGRADES target', taps: 1 },
    { selector: '.tutorial-next', description: 'GOT IT', taps: 1 },
    { selector: '[data-tab="crew"]', description: 'CREW target', taps: 1 },
    { selector: '.tutorial-next', description: 'NEXT after CREW', taps: 1 },
    { selector: '[data-tab="garage"]', description: 'GARAGE target', taps: 1 },
    { selector: '.tutorial-next', description: 'NEXT after GARAGE', taps: 1 },
    { selector: '[data-tab="boosters"]', description: 'BOOSTERS target', taps: 1 },
    { selector: '.tutorial-next', description: 'NEXT after BOOSTERS', taps: 1 },
    { selector: '[data-tab="ranks"]', description: 'RANKS target', taps: 1 },
    { selector: '.tutorial-next', description: 'NEXT after RANKS', taps: 1 },
    { selector: '#btn-settings', description: 'SETTINGS target', taps: 1 },
    { selector: '.tutorial-next', description: 'FINISH', taps: 1 },
  ];

  for (let index = 0; index < actions.length; index += 1) {
    await waitFor(`Boolean(window.__tutorial.active
      &&window.__tutorial.index===${index}
      &&document.querySelector('.tutorial-layer'))`,
    `tutorial step ${index + 1}`);
    if (index === 0) {
      await waitFor(`Boolean(window.__scene.isMakingEyeContact())`,
        'the automatic first-launch eye-contact framing');
    }
    await wait(260);
    const layout = await evaluate(`(() => {
      const tutorial=window.__tutorial;
      const bubble=document.querySelector('.tutorial-bubble');
      const focus=document.querySelector('.tutorial-focus');
      const skip=document.querySelector('.tutorial-skip');
      const next=document.querySelector('.tutorial-next');
      if(!bubble||!focus||!skip)return {missing:true};
      const rect=element=>element.getBoundingClientRect();
      const intersects=(first,second)=>
        Math.min(first.right,second.right)-Math.max(first.left,second.left)>2
        &&Math.min(first.bottom,second.bottom)-Math.max(first.top,second.top)>2;
      const visible=element=>{
        const style=getComputedStyle(element),box=rect(element);
        return style.display!=='none'&&style.visibility!=='hidden'
          &&box.width>1&&box.height>1;
      };
      const outside=element=>{
        const box=rect(element);
        return box.left<0||box.top<0||box.right>innerWidth||box.bottom>innerHeight;
      };
      const bubbleBox=rect(bubble),focusBox=rect(focus),skipBox=rect(skip);
      const selector=tutorial.steps[tutorial.index].target||null;
      const target=selector&&selector!=='#game-canvas'?document.querySelector(selector):null;
      const controls=[...document.querySelectorAll(
        '.menu-row button,.hud-top button,.panel button,.garage-exit-fixed',
      )].filter(visible);
      const blockedTarget=selector!=='#game-canvas'&&target&&visible(target)&&(()=>{
        const box=rect(target);
        const top=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);
        return !(top===target||target.contains(top));
      })();
      return {
        missing:false,
        actualIndex:tutorial.index,
        step:(document.querySelector('.tutorial-step')?.textContent||''),
        expectedStep:'QUICK START '+(tutorial.index+1)+'/'+tutorial.steps.length,
        outside:[bubble,skip,...bubble.querySelectorAll('*')]
          .filter(visible).filter(outside).map(element=>element.className||element.tagName),
        focusOverlap:visible(focus)
          &&(intersects(bubbleBox,focusBox)||intersects(skipBox,focusBox)),
        skipBubbleOverlap:intersects(bubbleBox,skipBox),
        controlOverlap:controls.filter(element=>
          !bubble.contains(element)&&intersects(bubbleBox,rect(element)))
          .map(element=>element.id||element.textContent.trim()),
        clipped:[bubble,skip,...bubble.querySelectorAll('*')]
          .filter(visible)
          .filter(element=>element.scrollWidth>element.clientWidth+2
            ||element.scrollHeight>element.clientHeight+2)
          .map(element=>element.className||element.tagName),
        blockedTarget:Boolean(blockedTarget),
        panelOpen:Boolean(document.querySelector('.panel')),
        hasNext:visible(next),
        viewport:[innerWidth,innerHeight],
      };
    })()`);

    const wrong = await evaluate(`(() => {
      const tutorial=window.__tutorial;
      const allowed=tutorial.steps[tutorial.index].target||null;
      const visible=element=>{
        const style=getComputedStyle(element),box=element.getBoundingClientRect();
        return style.display!=='none'&&style.visibility!=='hidden'
          &&box.width>2&&box.height>2;
      };
      const candidate=[...document.querySelectorAll('.menu-row button')]
        .find(button=>visible(button)&&(!allowed||!button.matches(allowed)));
      if(!candidate)return null;
      return '[data-tab="'+candidate.dataset.tab+'"]';
    })()`);
    if (!wrong) throw new Error(`No visible wrong-control candidate on tutorial step ${index + 1}`);
    const wrongBefore = await evaluate(`(() => ({
      index:window.__tutorial.index,
      openTab:window.__ui.openTab||null,
      totalTaps:window.__game.s.totalTaps,
      tutorialActive:window.__tutorial.active,
    }))()`);
    const wrongTap = await physicalTap(wrong, `blocked wrong control on step ${index + 1}`);
    const wrongAfter = await evaluate(`(() => ({
      index:window.__tutorial.index,
      openTab:window.__ui.openTab||null,
      totalTaps:window.__game.s.totalTaps,
      tutorialActive:window.__tutorial.active,
    }))()`);
    const wrongControlLocked = wrongTap.physicalTouchObserved
      && wrongAfter.index === wrongBefore.index
      && wrongAfter.openTab === wrongBefore.openTab
      && wrongAfter.totalTaps === wrongBefore.totalTaps
      && wrongAfter.tutorialActive === true;

    let instructionLock = null;
    if (index === 0) {
      const before = await evaluate(`(() => ({
        index:window.__tutorial.index,
        totalTaps:window.__game.s.totalTaps,
        respect:window.__game.s.respect,
      }))()`);
      const tap = await physicalTap('.tutorial-copy', 'tutorial copy must not count as gameplay');
      const after = await evaluate(`(() => ({
        index:window.__tutorial.index,
        totalTaps:window.__game.s.totalTaps,
        respect:window.__game.s.respect,
      }))()`);
      instructionLock = {
        before,
        tap,
        after,
        locked: tap.physicalTouchObserved
          && after.index === before.index
          && after.totalTaps === before.totalTaps
          && after.respect === before.respect,
      };
    }

    capture(`step-${String(index + 1).padStart(2, '0')}.png`);
    const actionBefore = await evaluate(`(() => ({
      totalTaps:window.__game.s.totalTaps,
      respect:window.__game.s.respect,
    }))()`);
    const actionTaps = [];
    for (let tapIndex = 0; tapIndex < actions[index].taps; tapIndex += 1) {
      actionTaps.push(await physicalTap(
        actions[index].selector,
        `${actions[index].description} ${tapIndex + 1}/${actions[index].taps}`,
        tapIndex === actions[index].taps - 1 ? 300 : 150,
      ));
    }
    if (index === 0) {
      const observed = await evaluate(`(() => ({
        totalTaps:window.__game.s.totalTaps,
        respect:window.__game.s.respect,
        tutorialIndex:window.__tutorial.index,
        tutorialTapCount:window.__tutorial.tapCount,
        eyeContact:window.__scene.isMakingEyeContact(),
      }))()`);
      if (observed.totalTaps - actionBefore.totalTaps !== actions[index].taps) {
        throw new Error(`First tutorial action did not produce three accepted gameplay taps: ${
          JSON.stringify({ actionBefore, observed, actionTaps })
        }`);
      }
    }
    try {
      if (index < actions.length - 1) {
        await waitFor(`Boolean(window.__tutorial.active
          &&window.__tutorial.index===${index + 1})`,
        `advance from tutorial step ${index + 1}`);
      } else {
        await waitFor(`Boolean(!window.__tutorial.active
          &&!document.querySelector('.tutorial-layer'))`,
        'full tutorial completion');
      }
    } catch (error) {
      const state = await evaluate(`(() => ({
        index:window.__tutorial.index,
        active:window.__tutorial.active,
        openTab:window.__ui.openTab||null,
        advanceQueued:window.__tutorial.advanceQueued,
        actionTarget:document.elementFromPoint(
          ${actionTaps.at(-1)?.css.x ?? 0},
          ${actionTaps.at(-1)?.css.y ?? 0}
        )?.outerHTML?.slice(0,240)||null,
      }))()`);
      const events = await readEvents();
      throw new Error(`${error.message}; state=${JSON.stringify(state)}; events=${
        JSON.stringify(events?.history?.slice(-12) || [])
      }`);
    }
    const after = await evaluate(`(() => ({
      index:window.__tutorial.index,
      active:window.__tutorial.active,
      tutorialComplete:window.__game.s.tutorialComplete,
      layerPresent:Boolean(document.querySelector('.tutorial-layer')),
      totalTaps:window.__game.s.totalTaps,
      respect:window.__game.s.respect,
    }))()`);
    const advanced = index < actions.length - 1
      ? after.active === true && after.index === index + 1
      : after.active === false && after.layerPresent === false
        && after.tutorialComplete === true;
    const successfulGameplay = index !== 0
      || (after.totalTaps - actionBefore.totalTaps === actions[index].taps
        && after.respect > actionBefore.respect);
    reports.push({
      index: index + 1,
      expectedIndex: index,
      ...layout,
      stepIndexMatches: layout.actualIndex === index
        && layout.step === `QUICK START ${index + 1}/${actions.length}`,
      wrongControl: {
        selector: wrong,
        before: wrongBefore,
        tap: wrongTap,
        after: wrongAfter,
        locked: wrongControlLocked,
      },
      instructionLock,
      action: actions[index],
      actionBefore,
      actionTaps,
      actionPhysical: actionTaps.every(tap => tap.physicalTouchObserved),
      successfulGameplay,
      after,
      advanced,
    });
  }
  reports.push({
    completed: await evaluate(`Boolean(!document.querySelector('.tutorial-layer')
      &&!window.__tutorial.active&&window.__game.s.tutorialComplete)`),
  });
} catch (error) {
  runError = error;
  reports.push({ scenario: 'fatal', error: error.message });
} finally {
  if (newDocumentScriptId) {
    try {
      await call('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: newDocumentScriptId,
      });
    } catch (error) {
      restoreError ||= error;
    }
  }
  if (originalSnapshot) {
    try {
      await evaluate(`(() => {
        const original=${JSON.stringify(originalSnapshot)};
        const handlers=window.__disciplineTutorialFlowHandlers||{};
        for(const [type,handler] of Object.entries(handlers))
          window.removeEventListener(type,handler,true);
        delete window.__disciplineTutorialFlowHandlers;
        delete window.__disciplineTutorialFlowEvents;
        localStorage.clear();
        for(const [key,value] of original.storage)localStorage.setItem(key,value);
        if(window.__game&&original.game){
          for(const key of Object.keys(window.__game.s))delete window.__game.s[key];
          Object.assign(window.__game.s,original.game);
          // Preserve the player's economy exactly while excluding audit wall
          // time from the next launch's offline-reward calculation.
          window.__game.s.lastSeen=Date.now();
          window.__game.save();
        }
        if(window.__ui?.account)window.__ui.account.cloudReadyAccountId='';
        setTimeout(()=>location.reload(),0);
        return true;
      })()`);
    } catch (error) {
      restoreError ||= error;
    }
  }
  ws.close();
}

if (captures.length) {
  for (let start = 0, page = 1; start < captures.length; start += 5, page += 1) {
    await writeContactSheet(
      captures.slice(start, start + 5),
      join(output, `contact-sheet-tutorial-${page}.png`),
      { columns: 3, tileWidth: 360, tileHeight: 640 },
    );
  }
}

const failures = reports.filter(report =>
  report.error
  || report.ok === false
  || report.missing
  || report.outside?.length
  || report.focusOverlap
  || report.skipBubbleOverlap
  || report.controlOverlap?.length
  || report.clipped?.length
  || report.blockedTarget
  || report.stepIndexMatches === false
  || report.wrongControl?.locked === false
  || report.instructionLock?.locked === false
  || report.actionPhysical === false
  || report.successfulGameplay === false
  || report.advanced === false
  || report.completed === false);
if (restoreError) failures.push({ scenario: 'restore', error: restoreError.message });
const expectedCases = 15;
if (reports.length !== expectedCases) failures.push({
  scenario: 'coverage',
  error: `Expected ${expectedCases} tutorial cases, recorded ${reports.length}`,
});
writeFileSync(join(output, 'audit.json'), `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  invocation: `node scripts/audit-android-tutorial-flow.mjs --port ${port} --serial ${serial} --package ${packageName}`,
  serial,
  packageName,
  pid,
  expectedCases,
  cases: reports,
  failures,
}, null, 2)}\n`);
writeFileSync(join(output, 'failures.json'), `${JSON.stringify(failures, null, 2)}\n`);
console.log(JSON.stringify({
  cases: reports.length,
  expectedCases,
  failures: failures.length,
  output,
}));
if (runError || failures.length) process.exitCode = 1;
