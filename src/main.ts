import { Game, fmt } from './state';
import { GameScene } from './scene';
import { UI } from './ui';
import { sfx } from './audio';
import { getDistrict } from './config';
import { initLeaderboards, type LeaderboardProvider } from './leaderboard';

const game = new Game();
// debug/testing handle (harmless in prod; used by automated checks)
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

const applyCosmetics = () => {
  // equipped sky cosmetic overrides the current district's time-of-day
  scene.setSky(game.equipped('sky') ?? getDistrict(game.s.opponentIndex).sky);
  scene.setDecal(game.equipped('decal'));
  scene.setOrnament(game.equipped('ornament') ?? game.equipped('dash'));
};

const ui = new UI(game, applyCosmetics);

// Worldwide leaderboards: Game Center / Play Games on device, local bests on web
let leaderboards: LeaderboardProvider | null = null;
initLeaderboards().then((lb) => {
  leaderboards = lb;
  ui.lb = lb;
  void lb.submit(game.s.totalTaps);
});

scene.setOpponent(game.opponent);
scene.setShakeAmp(game.shakeAmp);
applyCosmetics();

let transitioning = false;

game.on((e) => {
  if (e.type === 'tap') {
    scene.tapPulse();
  } else if (e.type === 'milestone') {
    scene.setShakeAmp(game.shakeAmp);
    ui.toast(e.label, 'warn');
    sfx.milestone();
  } else if (e.type === 'defeated') {
    transitioning = true;
    void leaderboards?.submit(game.s.totalTaps);
    const beatenName = e.name;
    scene.goop(game.equipped('goop'));
    scene.setShakeAmp(0);
    sfx.goop();
    ui.toast(`${beatenName} is FINISHED. +${e.mentality} Mentality`, 'gold');
    setTimeout(() => {
      sfx.green();
      ui.toast('GREEN LIGHT. You are free to go.', 'green');
      scene.driveToNext(() => {
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
  } else if (e.type === 'boost') {
    ui.toast(`BOOST ACTIVE: x${e.mult} for ${e.seconds}s`, 'gold');
  } else if (e.type === 'offline') {
    ui.toast(`While you were gone the crew earned ${fmt(e.gain)} respect.`, 'gold');
  }
});

// Tap anywhere on the scene (not on UI) to tap
const onTap = (ev: Event) => {
  const t = ev.target as HTMLElement;
  if (t.closest('.panel, .menu-row, .ad-overlay, button')) return; // UI handles it
  if (ui.isPanelOpen) { ui.close(); return; } // tapping outside any menu closes it
  if (transitioning) return;
  game.tap();
  sfx.tap();
  ev.preventDefault();
};
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
