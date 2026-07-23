import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'devlog', 'android-tutorial-flow');
mkdirSync(out, { recursive: true });
const port = Number(process.argv[2] || 9222);
const captureEnabled = process.argv[3] !== 'no-captures';
const pages = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
const page = pages.find(candidate => candidate.type === 'page');
if (!page) throw new Error('No Android WebView page found');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => { ws.onopen = resolveOpen; ws.onerror = rejectOpen; });
let sequence = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(String(data));
  if (!pending.has(message.id)) return;
  const handlers = pending.get(message.id); pending.delete(message.id);
  message.error ? handlers.reject(message.error) : handlers.resolve(message.result);
};
const call = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
  const id = ++sequence; pending.set(id, { resolve: resolveCall, reject: rejectCall });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const reply = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result.value;
};
const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
const saveKey = 'discipline-clicker-save-v1';
const originalSave = await evaluate(`localStorage.getItem(${JSON.stringify(saveKey)})`);
const originalAuditFlag = await evaluate(`localStorage.getItem('discipline-visual-audit')`);
const reports = [];

try {
  await evaluate(`(()=>{
    localStorage.setItem('discipline-visual-audit','1');
    const key=${JSON.stringify(saveKey)}, raw=localStorage.getItem(key), save=raw?JSON.parse(raw):{};
    save.textSizeTier=3; localStorage.setItem(key,JSON.stringify(save)); return true;
  })()`);
  await call('Page.reload', { ignoreCache: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await evaluate(`Boolean(document.querySelector('.title-screen')&&window.__tutorial)`)) break;
    await wait(500);
  }
  await evaluate(`(()=>{
    const title=document.querySelector('.title-screen');
    if(!title) throw new Error('Title screen missing');
    title.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'touch'}));
    return true;
  })()`);
  await wait(600);
  await evaluate(`(()=>{window.__tutorial.start();return true})()`);
  await wait(800);

  const actions = [
    `(()=>{const c=document.querySelector('#game-canvas');for(let i=0;i<3;i++){c.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:i+1,pointerType:'touch'}));c.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:i+1,pointerType:'touch'}));}return true})()`,
    `document.querySelector('[data-tab="upgrades"]').click()`,
    `document.querySelector('.tutorial-next').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:20,pointerType:'touch'}))`,
    `document.querySelector('[data-tab="crew"]').click()`,
    `document.querySelector('.tutorial-next').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:21,pointerType:'touch'}))`,
    `document.querySelector('[data-tab="garage"]').click()`,
    `document.querySelector('.tutorial-next').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:22,pointerType:'touch'}))`,
    `document.querySelector('[data-tab="boosters"]').click()`,
    `document.querySelector('.tutorial-next').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:23,pointerType:'touch'}))`,
    `document.querySelector('[data-tab="ranks"]').click()`,
    `document.querySelector('.tutorial-next').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:24,pointerType:'touch'}))`,
    `document.querySelector('#btn-settings').click()`,
    `document.querySelector('.tutorial-next').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:25,pointerType:'touch'}))`,
  ];

  for (let index = 0; index < actions.length; index += 1) {
    await wait(350);
    const report = await evaluate(`(()=>{
      const bubble=document.querySelector('.tutorial-bubble'),focus=document.querySelector('.tutorial-focus'),skip=document.querySelector('.tutorial-skip'),next=document.querySelector('.tutorial-next');
      if(!bubble||!focus||!skip) return {missing:true};
      const rect=e=>e.getBoundingClientRect(), intersects=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>2&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>2;
      const visible=e=>{const s=getComputedStyle(e),r=rect(e);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>1&&r.height>1};
      const outside=e=>{const r=rect(e);return r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight};
      const br=rect(bubble),fr=rect(focus),sr=rect(skip);
      const selector=${JSON.stringify(['#game-canvas','[data-tab="upgrades"]',null,'[data-tab="crew"]',null,'[data-tab="garage"]',null,'[data-tab="boosters"]',null,'[data-tab="ranks"]',null,'#btn-settings',null][index])};
      const target=selector?document.querySelector(selector):null;
      const controls=[...document.querySelectorAll('.menu-row button,.hud-top button,.panel button,.garage-exit-fixed')].filter(visible);
      const blockedTarget=selector!=='#game-canvas'&&target&&visible(target)&&(()=>{const r=rect(target),x=r.left+r.width/2,y=r.top+r.height/2,t=document.elementFromPoint(x,y);return !(t===target||target.contains(t));})();
      return {
        step:(document.querySelector('.tutorial-step')?.textContent||''),
        missing:false,
        outside:[bubble,skip,...bubble.querySelectorAll('*')].filter(visible).filter(outside).map(e=>e.className||e.tagName),
        focusOverlap:visible(focus)&&(intersects(br,fr)||intersects(sr,fr)),
        skipBubbleOverlap:intersects(br,sr),
        controlOverlap:controls.filter(e=>!bubble.contains(e)&&intersects(br,rect(e))).map(e=>e.id||e.textContent.trim()),
        clipped:[bubble,skip,...bubble.querySelectorAll('*')].filter(visible).filter(e=>e.scrollWidth>e.clientWidth+2||e.scrollHeight>e.clientHeight+2).map(e=>e.className||e.tagName),
        blockedTarget:Boolean(blockedTarget), panelOpen:Boolean(document.querySelector('.panel')),
        hasNext:visible(next), viewport:[innerWidth,innerHeight]
      };
    })()`);
    reports.push({ index: index + 1, ...report });
    if (captureEnabled) {
      const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
      writeFileSync(join(out, `step-${String(index + 1).padStart(2, '0')}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    await evaluate(actions[index]);
  }
  await wait(500);
  reports.push({ completed: await evaluate(`!document.querySelector('.tutorial-layer')`) });
} finally {
  await evaluate(`(()=>{
    const key=${JSON.stringify(saveKey)},raw=${JSON.stringify(originalSave)},flag=${JSON.stringify(originalAuditFlag)};
    if(raw===null)localStorage.removeItem(key);else localStorage.setItem(key,raw);
    if(flag===null)localStorage.removeItem('discipline-visual-audit');else localStorage.setItem('discipline-visual-audit',flag);
    return true;
  })()`);
  await call('Page.reload', { ignoreCache: true });
  await wait(900);
  ws.close();
}

const failures = reports.filter(report => report.missing || report.outside?.length || report.focusOverlap || report.skipBubbleOverlap || report.controlOverlap?.length || report.clipped?.length || report.blockedTarget || report.completed === false);
writeFileSync(join(out, 'audit.json'), JSON.stringify(reports, null, 2));
writeFileSync(join(out, 'failures.json'), JSON.stringify(failures, null, 2));
console.log(JSON.stringify({ cases: reports.length, failures: failures.length, output: out }));
