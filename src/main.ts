import { Game, fmt } from './state';
import { GameScene } from './scene';
import { UI } from './ui';
import { music, sfx } from './audio';
import { API_URL, BOOSTERS, getDistrict } from './config';
import { initLeaderboards, type LeaderboardProvider } from './leaderboard';
import { LocalUsernameService } from './username';
import { initAds } from './ads';
import { initPurchases, removePendingPurchase } from './purchases';
import { FirstLaunchTutorial } from './tutorial';
import { AccountService } from './account';
import { installCompatibilityFallbacks } from './compat';

installCompatibilityFallbacks();

const game = new Game();
// This is compile-time only. A production player cannot expose mutable game
// internals by changing localStorage; tracked test builds opt in via .env.test.
const visualAudit = import.meta.env.VITE_VISUAL_AUDIT === 'true';
if (visualAudit) (window as unknown as { __game: Game }).__game = game;
// Visual-audit and capture handles exist only in Vite's development build.
// Keeping them out of the production bundle prevents a release WebView from
// exposing mutable game/UI objects through window.__game/__ui/__scene.
if (import.meta.env.DEV) {
  const saveBlob = async (name: string, blob: Blob) => {
    await fetch(`/__save?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
  };
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
}

const canvas = document.createElement('canvas');
canvas.id = 'game-canvas';
document.body.insertBefore(canvas, document.body.firstChild);
const scene = new GameScene(canvas);
if (visualAudit) (window as any).__scene = scene;

const applyCosmetics = () => {
  // equipped sky cosmetic overrides the current district's time-of-day
  scene.setSky(game.equipped('sky') ?? getDistrict(game.s.opponentIndex).sky);
  scene.setDecal(game.equipped('decal'));
  scene.setDashboardItems(game.dashboardItems());
  scene.setDangler(game.equipped('dangler'));
  scene.setHornVisual(game.equipped('horn'));
  scene.setGarageCosmetics(game.equipped('decal'),
    game.dashboardItems(), game.equipped('goop'), game.equipped('dangler'), game.equipped('roof'), game.equipped('horn'));
};

const ui = new UI(game, applyCosmetics);
if (visualAudit) (window as any).__ui = ui;
const purchasesReady = initPurchases().then((provider) => {
  ui.purchases = provider;
  return provider;
});
ui.onEyeReset = () => scene.resetTapLook();
ui.onViewSettings = (fov, sensitivity, reducedMotion) => scene.setViewSettings(fov, sensitivity, reducedMotion);
ui.onResetView = () => scene.resetTapLook();

// Native Android Back/Escape is routed here instead of backgrounding the app.
// Close the active in-game layer first; at the root, save and remain visible.
window.addEventListener('disciplineAndroidBack', () => {
  if (ui.isPanelOpen) ui.close();
  else {
    game.save();
  }
});
scene.setViewSettings(
  Number(localStorage.getItem('discipline-fov') ?? '100'),
  Number(localStorage.getItem('discipline-look-sensitivity') ?? '1.5'),
  localStorage.getItem('discipline-reduced-motion') === '1',
);
const vibrate = (pattern: number | number[]) => {
  if (localStorage.getItem('discipline-vibration') !== '0') navigator.vibrate?.(pattern);
};

// Worldwide leaderboards: Game Center / Play Games on device, local bests on web
let leaderboards: LeaderboardProvider | null = null;
initLeaderboards().then((lb) => {
  leaderboards = lb;
  ui.lb = lb;
  void lb.submit(game.s.totalTaps);
});
initAds().then((ads) => { ui.ads = ads; }); // AdMob on device, placeholder on web

// Discipline accounts—not Play Games/Game Center—own identity and cloud data.
// The local name provider exists only for offline web development.
let account: AccountService | null = null;
let onboarding: Promise<void> = Promise.resolve();
let entitlementRecovery: Promise<void> | null = null;

const recoverAccountEntitlements = (refreshStore: boolean): Promise<void> => {
  if (!account?.signedIn || !account.cloudReady) return Promise.resolve();
  if (entitlementRecovery) return entitlementRecovery;
  const service = account;
  const recoveringAccountId = service.accountId;
  entitlementRecovery = (async () => {
    const purchases = await purchasesReady;
    if (refreshStore) await purchases.restoreForAccount(recoveringAccountId);
    const recovered = await service.recoverPendingPurchases();
    for (const { receipt, grant } of recovered) {
      if (service.accountId !== recoveringAccountId || !service.cloudReady) return;
      if (!game.s.appliedPurchases.includes(grant.transactionId) && grant.amount > 0) {
        game.s.mentality += grant.amount;
        game.s.appliedPurchases.push(grant.transactionId);
        ui.toast(`Recovered purchase: +${fmt(grant.amount)} M`, 'gold');
      }
      game.save();
      if (await service.save(game.s)) removePendingPurchase(receipt);
      await purchases.finish(receipt).catch(() => undefined);
    }
    const recoveredAds = await service.recoverPendingAdRewards();
    for (const reward of recoveredAds) {
      if (service.accountId !== recoveringAccountId || !service.cloudReady) return;
      if (game.s.appliedAdRewards.includes(reward.nonce)) {
        service.clearPendingAdReward(reward.nonce);
        continue;
      }
      // M is reconciled from the signed server ledger by save(). Boost/offline
      // effects use the account-scoped intent persisted before AdMob opened.
      if (reward.kind === 'boost') {
        const booster = reward.watchedSeconds < 10 ? BOOSTERS[0]
          : reward.watchedSeconds < 25 ? BOOSTERS[1] : BOOSTERS[2];
        game.grantBooster(booster);
      } else if (reward.kind === 'offline') {
        game.s.respect += reward.bonusRespect;
      }
      game.s.appliedAdRewards.push(reward.nonce);
      game.save();
      if (await service.save(game.s)) service.clearPendingAdReward(reward.nonce);
      ui.toast(`Recovered verified ${reward.kind === 'm' ? 'M' : reward.kind} ad reward.`, 'gold');
    }
  })().finally(() => { entitlementRecovery = null; });
  return entitlementRecovery;
};

if (API_URL) {
  account = new AccountService(API_URL);
  ui.account = account;
  onboarding = (async () => {
    let identity = null;
    let verifiedOnline = false;
    try {
      identity = await account!.verify();
      verifiedOnline = Boolean(identity);
    } catch {
      // A cached, previously verified identity is enough for honest offline
      // play. Do not replace the whole app with an impossible network login.
      identity = account!.cachedIdentity;
      if (identity) ui.toast(`Offline as ${identity.username}. Progress will sync when connected.`);
    }
    if (!identity) {
      await ui.promptAccount();
      // A first-launch registration/login must enter the exact same sync and
      // purchase-recovery path immediately, not wait for an app restart.
      identity = await account!.verify().catch(() => null);
      if (!identity) return;
      verifiedOnline = true;
    }
    game.s.username = identity.username;
    if (!verifiedOnline) return;
    const source = await account!.sync(game.s).catch(() => null);
    if (source === 'reload') {
      location.reload();
      return;
    }
    if (source !== 'local') {
      ui.toast('Cloud sync is unavailable. Local play is safe; account uploads are paused.');
      return;
    }
    else {
      await recoverAccountEntitlements(true);
      game.save(); void account!.save(game.s);
      if (!account!.termsCurrent) await ui.promptTermsAcceptance();
    }
  })();
} else {
  ui.names = new LocalUsernameService([]);
  if (!game.s.username) onboarding = ui.promptUsername(true);
}

const syncScore = () => {
  if (account?.signedIn && account.cloudReady) void account.save(game.s);
};
syncScore();

const reconnectAccount = async () => {
  if (!account?.signedIn) return;
  try {
    const identity = await account.verify();
    if (!identity) return;
    game.s.username = identity.username;
    const source = await account.sync(game.s);
    if (source === 'reload') {
      location.reload();
      return;
    }
    await recoverAccountEntitlements(true);
    if (!account.termsCurrent) await ui.promptTermsAcceptance();
  } catch {
    // The cloud gate remains closed. Local play and account-scoped saves stay
    // intact until a later online event succeeds.
  }
};
window.addEventListener('online', () => void reconnectAccount());
setInterval(() => {
  if (account?.cloudReady) void recoverAccountEntitlements(false);
}, 15_000);

scene.setOpponent(game.opponent);
scene.setShakeAmp(game.shakeAmp);
scene.setDriverAnger(game.currentTier()); // restore mid-fight fury on load
applyCosmetics();

let transitioning = false;

game.on((e) => {
  if (e.type === 'tap') {
    // Input-driven update means speed changes never wait for tapping to pause.
    if (!transitioning) music.updateBattle(game.s.opponentIndex, game.progress01);
    scene.tapPulse();
    vibrate(8);
  } else if (e.type === 'milestone') {
    scene.setShakeAmp(game.shakeAmp);
    scene.setDriverAnger(e.tier); // face gets angrier and redder each tier
    ui.toast(e.label, 'warn');
    sfx.milestone();
    vibrate(e.tier >= 3 ? [45, 25, 75] : 25 + e.tier * 15);
  } else if (e.type === 'defeated') {
    transitioning = true;
    music.stopForDefeat();
    sfx.yelp();
    void leaderboards?.submit(game.s.totalTaps);
    syncScore();
    const beatenName = e.name;
    scene.goop(game.equipped('goop'));
    scene.setShakeAmp(0);
    sfx.goop();
    sfx.horn(game.equipped('horn'));
    vibrate([70, 35, 130, 45, 220]);
    ui.toast(`${beatenName} is FINISHED.`, 'gold');
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
        music.updateBattle(game.s.opponentIndex, game.progress01);
        transitioning = false;
      });
    }, 1600);
  } else if (e.type === 'prestige') {
    scene.setOpponent(game.opponent);
    scene.setShakeAmp(game.shakeAmp);
    scene.setDriverAnger(0);
    music.updateBattle(game.s.opponentIndex, game.progress01);
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
const tutorial = new FirstLaunchTutorial({
  closePanel: () => ui.close(),
  eyeContactPoint: () => scene.eyeContactScreenPoint(),
  finish: () => { game.s.tutorialComplete = true; game.save(); },
});
if (visualAudit) (window as any).__tutorial = tutorial;
title.addEventListener('pointerdown', (ev) => {
  ev.stopPropagation();
  title.classList.add('gone');
  setTimeout(() => title.remove(), 450);
  sfx.preloadYelp();
  sfx.green();
  music.engage(game.s.opponentIndex, game.progress01);
  // On a genuine first launch, username/account onboarding may already be
  // waiting behind the title card. Never stack the tutorial over that modal.
  // The tour starts only after onboarding has completely left the screen.
  void onboarding.then(() => {
    if (!game.s.tutorialComplete) setTimeout(() => tutorial.start(), 500);
  });
}, { once: true });

// Tap anywhere on the scene (not on UI) to tap
let lastEyeContactWarning = 0;
const onTap = (ev: Event) => {
  if (scene.inGarage) return; // garage has its own swipe/tap controls
  const t = ev.target as HTMLElement;
  if (t.closest('.panel, .menu-row, .ad-overlay, button')) return; // UI handles it
  if (ui.isPanelOpen) { ui.close(); return; } // tapping outside any menu closes it
  if (transitioning) return;
  if (!scene.isMakingEyeContact()) {
    const now = Date.now();
    if (now - lastEyeContactWarning > 1200) {
      ui.toast('MAKE EYE CONTACT TO TAP', 'warn');
      lastEyeContactWarning = now;
    }
    return;
  }
  sfx.preloadYelp();
  game.tap();
  tutorial.recordSuccessfulTap();
  sfx.tap();
  ev.preventDefault();
};

// A fixed, always-on-top EXIT button — can never be covered by the sheet or
// canvas, so leaving the garage always works on any screen/aspect.
let garageExitBtn: HTMLButtonElement | null = null;
function showGarageExit() {
  if (garageExitBtn) return;
  const b = document.createElement('button');
  b.className = 'garage-exit-fixed';
  b.textContent = '‹ EXIT GARAGE';
  b.addEventListener('click', (e) => { e.stopPropagation(); ui.close(); });
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.appendChild(b);
  garageExitBtn = b;
}
function hideGarageExit() { garageExitBtn?.remove(); garageExitBtn = null; }

// garage controls: swipe to orbit / look, pinch to zoom, tap to sit in/out
ui.onGarage = (open) => {
  music.setGarage(open);
  ui.quickFade(() => {
    document.body.classList.toggle('in-garage', open);
    if (open) { scene.enterGarage(); applyCosmetics(); showGarageExit(); }
    else { scene.exitGarage(); hideGarageExit(); }
  });
};

const gPointers = new Map<number, { startX: number; startY: number; x: number; y: number }>();
let gMoved = false;
let gPinchDist = 0;
const isUI = (t: EventTarget | null) => {
  const hit = (t as HTMLElement)?.closest?.('.panel, .menu-row, button, .ad-overlay, .garage-exit-fixed');
  // A collapsed garage sheet is visually absent and must not leave an
  // invisible gesture-blocking rectangle over the car.
  return !!hit && !(hit.classList.contains('panel') && hit.classList.contains('collapsed'));
};

// Normal tap mode also supports drag-to-look. The initial press still counts as
// a tap; movement turns the driver's head without switching modes.
const tapPointers = new Map<number, { startX: number; startY: number; x: number; y: number; moved: boolean }>();

window.addEventListener('pointerdown', (ev) => {
  if (!scene.inGarage && !isUI(ev.target)) {
    (ev.target as HTMLElement)?.setPointerCapture?.(ev.pointerId);
    tapPointers.set(ev.pointerId, { startX: ev.clientX, startY: ev.clientY, x: ev.clientX, y: ev.clientY, moved: false });
    return;
  }
  if (!scene.inGarage || isUI(ev.target)) return;
  (ev.target as HTMLElement)?.setPointerCapture?.(ev.pointerId);
  gPointers.set(ev.pointerId, { startX: ev.clientX, startY: ev.clientY, x: ev.clientX, y: ev.clientY });
  if (gPointers.size === 1) gMoved = false;
  if (gPointers.size === 1) scene.beginGarageSwipe();
  if (gPointers.size === 2) {
    const [a, b] = [...gPointers.values()];
    gPinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
window.addEventListener('pointermove', (ev) => {
  const tapPointer = tapPointers.get(ev.pointerId);
  if (!scene.inGarage && tapPointer) {
    const dx = ev.clientX - tapPointer.startX, dy = ev.clientY - tapPointer.startY;
    tapPointer.x = ev.clientX; tapPointer.y = ev.clientY;
    if (!tapPointer.moved && Math.hypot(dx, dy) < 3) return;
    if (!tapPointer.moved) scene.beginTapLook();
    tapPointer.moved = true;
    scene.tapLook(dx, dy);
    return;
  }
  const p = gPointers.get(ev.pointerId);
  if (!scene.inGarage || !p) return;
  const dx = ev.clientX - p.startX, dy = ev.clientY - p.startY;
  p.x = ev.clientX; p.y = ev.clientY;
  if (gPointers.size >= 2) {
    // pinch: change orbit zoom by the two-finger spread delta
    const [a, b] = [...gPointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (gPinchDist) scene.garageZoom((gPinchDist - d) * 0.01);
    gPinchDist = d;
    gMoved = true;
  } else {
    if (Math.abs(dx) + Math.abs(dy) > 4) gMoved = true;
    scene.garageSwipe(dx, dy);
  }
});
const endPointer = (ev: PointerEvent) => {
  const tapPointer = tapPointers.get(ev.pointerId);
  if (tapPointer) {
    tapPointers.delete(ev.pointerId);
    if (!tapPointer.moved) onTap(ev);
    return;
  }
  if (!gPointers.has(ev.pointerId)) return;
  const wasSingle = gPointers.size === 1;
  gPointers.delete(ev.pointerId);
  if (scene.inGarage && wasSingle && !gMoved) scene.garageTap(ev.clientX, ev.clientY);
  if (gPointers.size < 2) gPinchDist = 0;
};
const cancelPointer = (ev: PointerEvent) => {
  // Cancellation is cleanup only. It must never award a tap or toggle the
  // garage camera when Android interrupts a gesture.
  tapPointers.delete(ev.pointerId);
  gPointers.delete(ev.pointerId);
  if (gPointers.size < 2) gPinchDist = 0;
  if (gPointers.size === 0) gMoved = false;
};
scene.onGarageShop = () => ui.openGarageShop();

// green bouncing arrow that hovers over the garage laptop to say "tap here"
const shopArrow = document.createElement('div');
shopArrow.className = 'garage-arrow';
shopArrow.textContent = '▼';
shopArrow.hidden = true;
document.body.appendChild(shopArrow);
function updateShopArrow() {
  const p = scene.garageLaptopScreen();
  const shopOpen = ui.isPanelOpen && !document.querySelector('.panel.collapsed');
  if (p && scene.inGarage && !shopOpen) {
    shopArrow.hidden = false;
    shopArrow.style.left = `${p.x}px`;
    shopArrow.style.top = `${p.y - 54}px`;
  } else {
    shopArrow.hidden = true;
  }
  requestAnimationFrame(updateShopArrow);
}
requestAnimationFrame(updateShopArrow);
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', cancelPointer);
// mouse wheel = zoom on desktop
window.addEventListener('wheel', (ev) => {
  if (scene.inGarage && !isUI(ev.target)) scene.garageZoom(ev.deltaY * 0.003);
}, { passive: true });

// All open panels/overlays duck music to 50%. Rewarded ads additionally pause it.
const menuVolumeObserver = new MutationObserver(() => {
  music.setMenuOpen(!!document.querySelector('.panel, .ad-overlay'));
});
menuVolumeObserver.observe(document.body, { childList: true, subtree: true });

// main loop
let last = performance.now();
let uiAccum = 0;
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
    // A second idle defeat while the green-light drive is still staging would
    // replace its callback and desynchronize the opponent state from the scene.
    if (!transitioning) game.tick(dt);
  scene.render(dt);
  uiAccum += dt;
  if (uiAccum > 0.2) {
    uiAccum = 0;
    ui.refresh();
    // The next song begins only once driveToNext reaches the new red light.
    if (!transitioning) music.updateBattle(game.s.opponentIndex, game.progress01);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
ui.refresh();

// autosave
setInterval(() => { game.save(); syncScore(); }, 5000);
window.addEventListener('beforeunload', () => { game.save(); syncScore(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    game.save();
    syncScore();
    return;
  }
  // requestAnimationFrame is suspended in the background and its first delta
  // is intentionally capped. Apply the elapsed window here exactly once.
  game.applyOffline();
  game.save();
  syncScore();
  if (navigator.onLine) void recoverAccountEntitlements(false);
  ui.refresh();
});
