import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'devlog', 'tutorial-responsive');
mkdirSync(out, { recursive: true });
const port = Number(process.argv[2] || 9222);
const pages = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
const page = pages.find(candidate => candidate.type === 'page' && /^https?:/.test(candidate.url)) ?? pages.find(candidate => candidate.type === 'page');
if (!page) throw new Error(`No inspectable game page found on CDP port ${port}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
let seq = 0; const pending = new Map();
ws.onmessage = ({ data }) => { const m=JSON.parse(String(data)); if(!pending.has(m.id))return; const p=pending.get(m.id);pending.delete(m.id);m.error?p.fail(m.error):p.ok(m.result); };
const call = (method, params={}) => new Promise((ok,fail)=>{const id=++seq;pending.set(id,{ok,fail});ws.send(JSON.stringify({id,method,params}));});
const evalJs = async expression => {
  const reply = await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result.value;
};
const wait = ms => new Promise(r=>setTimeout(r,ms));
const viewports=[['compact',320,568],['standard',360,640],['tall',412,915],['landscape',640,360],['tablet',768,1024]];
const reports=[]; const captures=[];
// The real tutorial starts after the title card has completed its exit. Keep
// the audit in that same state so screenshots exercise the actual play UI.
await evalJs(`(()=>{document.querySelector('.title-screen')?.remove();document.querySelectorAll('.ad-overlay').forEach(e=>e.remove());document.getElementById('app').style.visibility='visible';return true})()`);
for(const [name,width,height] of viewports){
  await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true,screenWidth:width,screenHeight:height,screenOrientation:{type:width>height?'landscapePrimary':'portraitPrimary',angle:width>height?90:0}});
  for(let tier=0;tier<4;tier++){
    await evalJs(`(()=>{const t=window.__tutorial;t.overlay?.remove();document.body.classList.remove('tutorial-active');t.overlay=t.focus=t.bubble=null;t.active=false;t.index=0;window.__ui.close();window.__game.s.textSizeTier=${tier};window.__ui.applyTextSize();t.start();return true})()`);
    for(let step=0;step<13;step++){
      const result=await evalJs(`(async()=>{
        const t=window.__tutorial;if(!t.overlay?.isConnected){t.active=false;t.start();}
        t.index=${step};t.render();await new Promise(r=>setTimeout(r,230));
        const b=document.querySelector('.tutorial-bubble'),f=document.querySelector('.tutorial-focus'),skip=document.querySelector('.tutorial-skip');
        const R=e=>e.getBoundingClientRect();
        const intersects=(a,c)=>Math.min(a.right,c.right)-Math.max(a.left,c.left)>2&&Math.min(a.bottom,c.bottom)-Math.max(a.top,c.top)>2;
        const outside=e=>{const r=R(e);return r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight};
        const clipped=e=>e.scrollWidth>e.clientWidth+2||e.scrollHeight>e.clientHeight+2;
        const selector=t.steps[${step}].target,target=selector&&selector!=='#game-canvas'?document.querySelector(selector):null,br=R(b),fr=target?R(target):R(f);
        const overlap=!f.hidden&&intersects(br,fr),sr=R(skip),skipTarget=!f.hidden&&intersects(sr,fr);
        const controls=[...document.querySelectorAll('.menu-row,.hud-top button')].filter(e=>{const r=R(e),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'});
        const controlOverlap=controls.filter(e=>intersects(br,R(e))||intersects(sr,R(e))).map(e=>e.className||e.id||e.tagName);
        return {outside:[b,skip,...b.querySelectorAll('*')].filter(outside).map(e=>e.className||e.tagName),clipped:[b,skip,...b.querySelectorAll('*')].filter(clipped).map(e=>e.className||e.tagName),focusOverlap:overlap||skipTarget,controlOverlap,bubble:br.toJSON(),bubbleSize:{client:[b.clientWidth,b.clientHeight],scroll:[b.scrollWidth,b.scrollHeight]},focus:f.hidden?null:fr.toJSON()}
      })()`);
      reports.push({viewport:name,width,height,tier,step:step+1,...result});
      if(tier===3&&(name==='compact'||name==='landscape')){
        await wait(30); const shot=await call('Page.captureScreenshot',{format:'png',fromSurface:true});
        const file=`${name}-xl-step-${step+1}.png`;writeFileSync(join(out,file),Buffer.from(shot.data,'base64'));captures.push({name,step,file});
      }
    }
    await evalJs(`(()=>{const t=window.__tutorial;t.overlay?.remove();document.body.classList.remove('tutorial-active');t.overlay=t.focus=t.bubble=null;t.active=false;window.__ui.close();return true})()`);
  }
}
await call('Emulation.clearDeviceMetricsOverride');
const failures=reports.filter(r=>r.outside.length||r.clipped.length||r.focusOverlap||r.controlOverlap.length);
writeFileSync(join(out,'audit.json'),JSON.stringify(reports,null,2));writeFileSync(join(out,'failures.json'),JSON.stringify(failures,null,2));
for(const name of ['compact','landscape']){
  const items=captures.filter(c=>c.name===name), tileW=220,tileH=340,labelH=24,cols=4,rows=Math.ceil(items.length/cols),layers=[];
  for(const [i,item] of items.entries()){
    const im=await sharp(join(out,item.file)).resize(tileW,tileH,{fit:'contain',background:'#080910'}).png().toBuffer();
    const label=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${labelH}"><rect width="100%" height="100%" fill="#151621"/><text x="8" y="17" fill="#ffd890" font-family="monospace" font-size="12">XL · STEP ${item.step}</text></svg>`);
    const left=i%cols*tileW,top=Math.floor(i/cols)*(tileH+labelH);layers.push({input:im,left,top},{input:label,left,top:top+tileH});
  }
  await sharp({create:{width:cols*tileW,height:rows*(tileH+labelH),channels:4,background:'#080910'}}).composite(layers).png().toFile(join(out,`sheet-${name}-xl.png`));
}
console.log(JSON.stringify({cases:reports.length,failures:failures.length,output:out}));ws.close();
