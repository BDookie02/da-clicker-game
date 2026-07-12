import { Game, fmt } from './state';
import { GameScene } from './scene';
import { UI } from './ui';
import { sfx } from './audio';
import { API_URL, getDistrict } from './config';
import { getWorldList, initLeaderboards, submitScoreRemote, type LeaderboardProvider } from './leaderboard';
import { LocalUsernameService, RemoteUsernameService } from './username';
import { initAds } from './ads';

const game = new Game();
// debug/testing handles (harmless in prod; used by automated checks)
(window as unknown as { __game: Game }).__game = game;

// --- devlog capture helpers (dev server only; /__save writes to devlog/) ---
async function saveBlob(name: string, blob: Blob) {
  await fetch(`/__save?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
}
(window as any).__shot = (name: string) =>
  new Promise<void>((res) => {
    (document.getElementById('game-canvas') as HTMLCanvasElement).toBlob(async (b) => {
      if (b) await saveBlob(name.endsWith('.png') ? name : `${name}.png`, b);
      res();
    }, 'image/png');
  });
(window as any).__rec = (name: string, seconds: number) =>
  new Promise<void>((res) => {
    const stream = (document.getElementById('game-canvas') as HTMLCanvasElement).captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      await saveBlob(name.endsWith('.webm') ? name : `${name}.webm`, new Blob(chunks, { type: 'video/webm' }));
      res();
    };
    rec.start();
    setTimeout(() => rec.stop(), seconds * 1000);
  });

const canvas = document.createElement('canvas');
canvas.id = 'game-canvas';
document.body.prepend(canvas);
const scene = new GameScene(canvas);
(window as any).__scene = scene;

const applyCosmetics = () => {
  // equipped sky cosmetic overrides the current district's time-of-day
  scene.setSky(game.equipped('sky') ?? getDistrict(game.s.opponentIndex).sky);
  scene.setDecal(game.equipped('decal'));
  scene.setOrnament(game.equipped('ornament') ?? game.equipped('dash'));
  scene.setGarageCosmetics(game.equipped('decal'),
    game.equipped('ornament') ?? game.equipped('dash'), game.equipped('goop'));
};

const ui = new UI(game, applyCosmetics);

// Worldwide leaderboards: Game Center / Play Games on device, local bests on web
let leaderboards: LeaderboardProvider | null = null;
initLeaderboards().then((lb) => {
  leaderboards = lb;
  ui.lb = lb;
  void lb.submit(game.s.totalTaps);
});
initAds().then((ads) => { ui.ads = ads; }); // AdMob on device, placeholder on web

// Unique usernames: real API when configured, local registry otherwise
ui.names = API_URL
  ? new RemoteUsernameService(API_URL, () => game.s.username)
  : new LocalUsernameService(getWorldList(0).filter(e => !e.you).map(e => e.name));
if (!game.s.username) void ui.promptUsername(true); // first open: claim your name

const syncScore = () => {
  if (API_URL && game.s.username) submitScoreRemote(API_URL, game.s.username, game.s.totalTaps);
};
syncScore();

scene.setOpponent(game.opponent);
scene.setShakeAmp(game.shakeAmp);
scene.setDriverAnger(game.currentTier()); // restore mid-fight fury on load
applyCosmetics();

let transitioning = false;

game.on((e) => {
  if (e.type === 'tap') {
    scene.tapPulse();
  } else if (e.type === 'milestone') {
    scene.setShakeAmp(game.shakeAmp);
    scene.setDriverAnger(e.tier); // face gets angrier and redder each tier
    ui.toast(e.label, 'warn');
    sfx.milestone();
    navigator.vibrate?.(30 + e.tier * 25);
  } else if (e.type === 'defeated') {
    transitioning = true;
    void leaderboards?.submit(game.s.totalTaps);
    syncScore();
    const beatenName = e.name;
    scene.goop(game.equipped('goop'));
    scene.setShakeAmp(0);
    sfx.goop();
    sfx.horn(game.equipped('horn'));
    navigator.vibrate?.([80, 40, 160]);
    ui.toast(`${beatenName} is FINISHED. +${e.mentality} Mentality`, 'gold');
    setTimeout(() => {
      sfx.green();
      ui.toast('GREEN LIGHT. You are free to go.', 'green');
      scene.driveToNext(game.opponent, () => {
        scene.setOpponent(game.opponent);
        scene.setShakeAmp(game.shakeAmp);
        applyCosmetics();
        if (game.s.opponentIndex % 10 === 0 && game.s.opponentIndex > 0) {
          ui.toast(`NEW DISTRICT: ${getDistrict(game.s.opponentIndex).name}`, 'gold');
        }
        ui.toast(`RED LIGHT ${game.s.opponentIndex + 1}: ${game.opponent.name}`, '');
        transitioning = false;
      });
    }, 1600);
  } else if (e.type === 'prestige') {
    scene.setOpponent(game.opponent);
    scene.setShakeAmp(game.shakeAmp);
    scene.setDriverAnger(0);
    applyCosmetics();
    ui.flashFade();
    ui.toast(`NEW ROUTE. Permanent x${Math.pow(2, e.count)} respect.`, 'gold');
    sfx.green();
  } else if (e.type === 'boost') {
    ui.toast(`BOOST ACTIVE: x${e.mult} for ${e.seconds}s`, 'gold');
  } else if (e.type === 'offline') {
    ui.showOfflineModal(e.gain, e.seconds); // collect, or double it with an ad
  }
});

// PS1-style title card: first tap dismisses it (and unlocks WebAudio)
const title = document.createElement('div');
title.className = 'title-screen';
title.innerHTML = `
  <div class="title-word">DISCIPLINE.</div>
  <div class="title-sub">a red light story</div>
  <div class="title-tap">TAP TO ENGAGE</div>`;
document.body.appendChild(title);
title.addEventListener('pointerdown', (ev) => {
  ev.stopPropagation();
  title.classList.add('gone');
  setTimeout(() => title.remove(), 450);
  sfx.green();
}, { once: true });

// Tap anywhere on the scene (not on UI) to tap
const onTap = (ev: Event) => {
  if (scene.inGarage) return; // garage has its own swipe/tap controls
  const t = ev.target as HTMLElement;
  if (t.closest('.panel, .menu-row, .ad-overlay, button')) return; // UI handles it
  if (ui.isPanelOpen) { ui.close(); return; } // tapping outside any menu closes it
  if (transitioning) return;
  game.tap();
  sfx.tap();
  ev.preventDefault();
};

// garage controls: swipe to orbit the car, clean tap to hop in/out of the seat
ui.onGarage = (open) => {
  // seamless: quick black dip, HUD hides inside the garage
  ui.quickFade(() => {
    document.body.classList.toggle('in-garage', open);
    if (open) { scene.enterGarage(); applyCosmetics(); }
    else scene.exitGarage();
  });
};
let gDrag: { x: number; y: number; moved: boolean } | null = null;
window.addEventListener('pointerdown', (ev) => {
  if (!scene.inGarage) return;
  if ((ev.target as HTMLElement).closest('.panel, .menu-row, button, .ad-overlay')) return;
  gDrag = { x: ev.clientX, y: ev.clientY, moved: false };
});
window.addEventListener('pointermove', (ev) => {
  if (!scene.inGarage || !gDrag) return;
  const dx = ev.clientX - gDrag.x, dy = ev.clientY - gDrag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) gDrag.moved = true;
  scene.garageSwipe(dx, dy);
  gDrag.x = ev.clientX;
  gDrag.y = ev.clientY;
});
window.addEventListener('pointerup', () => {
  if (!scene.inGarage || !gDrag) return;
  if (!gDrag.moved) scene.garageTap();
  gDrag = null;
});
canvas.addEventListener('pointerdown', onTap);
document.getElementById('app')!.addEventListener('pointerdown', onTap);

// main loop
let last = performance.now();
let uiAccum = 0;
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  game.tick(dt);
  scene.render(dt);
  uiAccum += dt;
  if (uiAccum > 0.2) { uiAccum = 0; ui.refresh(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
ui.refresh();

// autosave
setInterval(() => game.save(), 5000);
window.addEventListener('beforeunload', () => game.save());
document.addEventListener('visibilitychange', () => { if (document.hidden) game.save(); });
