import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const port = Number(process.argv[2] || 9222);
const screenFilter = process.argv[3]?.split(',').filter(Boolean) ?? null;
const root = resolve(import.meta.dirname, '..');
const out = join(root, 'devlog', screenFilter ? 'responsive-ui-targeted' : 'responsive-ui');
mkdirSync(out, { recursive: true });
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find(candidate => candidate.type === 'page' && /^https?:/.test(candidate.url)) ?? pages.find(candidate => candidate.type === 'page');
if (!page) throw new Error(`No inspectable game page found on CDP port ${port}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
let id = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(String(data));
  if (!msg.id || !pending.has(msg.id)) return;
  const { ok, fail } = pending.get(msg.id); pending.delete(msg.id);
  if (msg.error) fail(new Error(JSON.stringify(msg.error))); else ok(msg.result);
};
const call = (method, params = {}) => new Promise((ok, fail) => {
  const requestId = ++id; pending.set(requestId, { ok, fail });
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
const evaluate = async (expression) => {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const viewports = [
  { name: 'legacy-small', width: 280, height: 480 },
  { name: 'compact', width: 320, height: 568 },
  { name: 'standard', width: 360, height: 640 },
  { name: 'tall', width: 412, height: 915 },
  { name: 'short-landscape', width: 480, height: 280 },
  { name: 'landscape', width: 640, height: 360 },
  { name: 'tablet', width: 768, height: 1024 },
];
const visualViewports = new Set(['legacy-small', 'compact', 'tall', 'short-landscape', 'landscape']);
const allScreens = ['main', 'upgrades', 'crew', 'garage', 'ranks', 'boosters', 'settings', 'settings-account', 'account', 'username', 'mshop', 'offline', 'delete-account'];
const screens = screenFilter ? allScreens.filter(screen => screenFilter.includes(screen)) : allScreens;
const reports = [];
const captures = [];

await evaluate(`(() => {
  if (window.__tutorial) {
    // The first-launch timer may already have created an active walkthrough
    // even after the save flag changes. End that instance cleanly so its
    // capture-phase input guard cannot intercept audit clicks.
    window.__tutorial.active = true;
    window.__tutorial.end();
  }
  window.__ui?.close?.();
  document.querySelectorAll('.title-screen,.tutorial-layer,.ad-overlay').forEach(e => e.remove());
  if (window.__game) { window.__game.s.tutorialComplete = true; window.__game.save(); }
  document.getElementById('app').style.visibility = 'visible';
  return true;
})()`);

for (const viewport of viewports) {
  await call('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: true,
    screenWidth: viewport.width, screenHeight: viewport.height,
    screenOrientation: { type: viewport.width > viewport.height ? 'landscapePrimary' : 'portraitPrimary', angle: viewport.width > viewport.height ? 90 : 0 },
  });
  await wait(120);
  for (let tier = 0; tier < 4; tier++) {
    await evaluate(`(async()=>{
      window.__ui.close();
      window.__game.s.textSizeTier=${tier};
      window.__ui.applyTextSize();
      await new Promise(r=>setTimeout(r,30));
      return true;
    })()`);
    for (const screen of screens) {
      await evaluate(`(async()=>{
        document.querySelectorAll('.ad-overlay').forEach(e=>e.remove());
        window.__ui.close();
        await new Promise(r=>setTimeout(r,25));
        const screen=${JSON.stringify(screen)};
        if(screen==='settings') window.__ui.toggle('settings');
        else if(screen==='settings-account') { window.__ui.account={signedIn:true,username:'VISUALQA',deleteAccount:async()=>{}}; window.__ui.toggle('settings'); }
        else if(screen==='account') { if(!window.__ui.account) window.__ui.account={}; void window.__ui.promptAccount(); }
        else if(screen==='username') void window.__ui.promptUsername(false);
        else if(screen==='mshop') window.__ui.showMShop();
        else if(screen==='offline') window.__ui.showOfflineModal(12345,3600);
        else if(screen==='delete-account') { window.__ui.account={signedIn:true,username:'VISUALQA',deleteAccount:async()=>{}}; void window.__ui.promptDeleteAccount(); }
        else if(screen!=='main') window.__ui.toggle(screen);
        await new Promise(r=>setTimeout(r,260));
        if(screen==='garage') document.querySelector('.g-show')?.click();
        await new Promise(r=>setTimeout(r,260));
        document.querySelectorAll('.panel-scroll,.ad-box').forEach(e=>e.scrollTop=0);
        return true;
      })()`);
      const audit = await evaluate(`(() => {
        const expectedScreen=${JSON.stringify(screen)};
        const visible = e => {
          const closed=e.closest('details:not([open])');
          if(closed&&!e.matches('summary')&&!e.closest('summary'))return false;
          const s=getComputedStyle(e),r=e.getBoundingClientRect();
          return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>1&&r.height>1;
        };
        const label = e => (e.id?('#'+e.id):e.classList.length?('.'+[...e.classList].join('.')):e.tagName)+' '+(e.textContent||'').trim().replace(/\s+/g,' ').slice(0,55);
        const allInteractive=[...document.querySelectorAll('button,input,summary')].filter(visible);
        const visibleOverlays=[...document.querySelectorAll('.ad-overlay')].filter(visible);
        const activeOverlay=visibleOverlays[visibleOverlays.length-1];
        // A modal intentionally blocks the game behind it; audit its controls,
        // not the deliberately inert controls below the modal scrim.
        const interactive=activeOverlay?allInteractive.filter(e=>activeOverlay.contains(e)):allInteractive;
        const topVisible=e=>{const r=e.getBoundingClientRect(),x=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2));const t=document.elementFromPoint(x,y);return !!t&&(e===t||e.contains(t));};
        const inScrollableClip=e=>{let p=e.parentElement;while(p){const s=getComputedStyle(p);if(/auto|scroll|hidden/.test(s.overflowY+s.overflowX)){const a=e.getBoundingClientRect(),b=p.getBoundingClientRect();if(a.top<b.top||a.bottom>b.bottom||a.left<b.left||a.right>b.right)return true;}p=p.parentElement;}return false;};
        const outside=interactive.filter(e=>!inScrollableClip(e)).filter(e=>{const r=e.getBoundingClientRect();return r.left<-1||r.top<-1||r.right>innerWidth+1||r.bottom>innerHeight+1}).map(label);
        const overlaps=[];
        const panelBox=document.querySelector('.panel')?.getBoundingClientRect(),navElement=document.querySelector('.menu-row'),navBox=navElement?.getBoundingClientRect();
        const navVisible=navElement&&visible(navElement);
        if(panelBox&&navBox&&Math.min(panelBox.right,navBox.right)-Math.max(panelBox.left,navBox.left)>2&&Math.min(panelBox.bottom,navBox.bottom)-Math.max(panelBox.top,navBox.top)>2) overlaps.push('PANEL <> BOTTOM NAV');
        if(panelBox&&navVisible&&navBox&&navBox.top-panelBox.bottom<8) overlaps.push('PANEL HAS LESS THAN 8PX NAV GUTTER');
        for(let i=0;i<interactive.length;i++)for(let j=i+1;j<interactive.length;j++){
          const a=interactive[i],b=interactive[j];
          const panelNav=(a.closest('.panel')&&b.closest('.menu-row'))||(b.closest('.panel')&&a.closest('.menu-row'));
          // Compare controls even while their scroll container clips them out
          // of the current viewport. Their rectangles retain the same relative
          // geometry, so this catches collisions that appear after scrolling.
          if(a.contains(b)||b.contains(a)||panelNav)continue;
          const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();
          if(Math.min(x.right,y.right)-Math.max(x.left,y.left)>2&&Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>2) overlaps.push(label(a)+' <> '+label(b));
        }
        const occluded=interactive.filter(e=>!inScrollableClip(e)&&!topVisible(e)).map(label);
        const clipped=[...document.querySelectorAll('button,input,.stat,.stat .k,.stat .v,.panel-head,.row-name,.row-desc,.panel-note,.setting label,.setting-check,.lb-row,.garage-bar,.name-copy,.ad-label,.ad-copy')].filter(visible).filter(e=>{
          const s=getComputedStyle(e); return (e.scrollWidth>e.clientWidth+2&&s.overflowX!=='auto'&&s.overflowX!=='scroll')||(e.scrollHeight>e.clientHeight+2&&s.overflowY!=='auto'&&s.overflowY!=='scroll');
        }).map(label);
        const buttonLabels=[...document.querySelectorAll('button')].filter(visible).filter(button=>{
          const style=getComputedStyle(button);
          const range=document.createRange(); range.selectNodeContents(button);
          const rects=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0);
          const lineTops=new Set(rects.map(r=>Math.round(r.top*2)/2));
          return style.whiteSpace!=='nowrap'||style.wordBreak==='break-all'||lineTops.size>1
            ||button.scrollWidth>button.clientWidth+1||button.scrollHeight>button.clientHeight+1;
        }).map(label);
        const multiRowGroups=[...document.querySelectorAll('.menu-row,.name-actions,.text-size-choices,.garage-bar,.cheat-entry')].filter(visible).filter(group=>{
          const buttons=[...group.querySelectorAll(':scope > button')].filter(visible);
          if(buttons.length<2)return false;
          const tops=buttons.map(button=>Math.round(button.getBoundingClientRect().top));
          return Math.max(...tops)-Math.min(...tops)>2;
        }).map(label);
        const panel=document.querySelector('.panel');
        const panelBg=panel?getComputedStyle(panel).backgroundColor:'';
        const panelParts=panelBg.split(',');
        const panelAlpha=panelBg.startsWith('rgba')?Number(panelParts[panelParts.length-1].replace(')','')):1;
        const panelOpaque=!panel||panelAlpha>=.995;
        const garageState=expectedScreen!=='garage'||(document.body.classList.contains('in-garage')&&getComputedStyle(document.querySelector('.hud-top')).display==='none');
        return { outside, overlaps, occluded, clipped, buttonLabels, multiRowGroups, panelOpaque, garageState, viewport:[innerWidth,innerHeight], panel:panel?.getBoundingClientRect().toJSON?.()||null };
      })()`);
      reports.push({ viewport: viewport.name, tier, screen, ...audit });
      if (visualViewports.has(viewport.name)) {
        const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const file = `${viewport.name}-t${tier}-${screen}.png`;
        writeFileSync(join(out, file), Buffer.from(shot.data, 'base64'));
        captures.push({ viewport: viewport.name, tier, screen, file });
      }
    }
  }
}

await call('Emulation.clearDeviceMetricsOverride');
writeFileSync(join(out, 'audit.json'), JSON.stringify(reports, null, 2));
const failures = reports.filter(r => r.outside.length || r.overlaps.length || r.occluded.length || r.clipped.length || r.buttonLabels.length || r.multiRowGroups.length || !r.panelOpaque || !r.garageState);
writeFileSync(join(out, 'failures.json'), JSON.stringify(failures, null, 2));

for (const screen of screens) {
  const items = captures.filter(c => c.screen === screen);
  const tileW = 240, tileH = 390, labelH = 28, cols = 4;
  const rows = Math.ceil(items.length / cols);
  const layers = [];
  for (const [i, item] of items.entries()) {
    const image = await sharp(join(out, item.file)).resize(tileW, tileH, { fit: 'contain', background: '#080910' }).png().toBuffer();
    const text = `${item.viewport.toUpperCase()} · TIER ${item.tier + 1}`;
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${labelH}"><rect width="100%" height="100%" fill="#151621"/><text x="8" y="19" fill="#ffd890" font-family="monospace" font-size="13">${text}</text></svg>`);
    const left = (i % cols) * tileW, top = Math.floor(i / cols) * (tileH + labelH);
    layers.push({ input: image, left, top }, { input: label, left, top: top + tileH });
  }
  await sharp({ create: { width: cols * tileW, height: rows * (tileH + labelH), channels: 4, background: '#080910' } })
    .composite(layers).png().toFile(join(out, `sheet-${screen}.png`));
}

console.log(JSON.stringify({ cases: reports.length, failures: failures.length, output: out }));
ws.close();
