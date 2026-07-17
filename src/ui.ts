import { BOOSTERS, COSMETICS, CREW, LAB, UPGRADES, type BoosterDef } from './config';
import { fmt, PRESTIGE_STEP, type Game } from './state';
import { sfx } from './audio';
import { fetchBoardRemote, getWorldList, type LbEntry, type LeaderboardProvider } from './leaderboard';
import { API_URL } from './config';
import { RENAME_COST, USERNAME_RE, type UsernameService } from './username';

// Rewarded ads live in src/ads.ts: real AdMob on device, verified-watch
// placeholder on web. main.ts swaps the provider in via initAds().
import { PlaceholderAdProvider, withMusicPause, type AdProvider, type AdResult } from './ads';
import { AD_M_REWARD, M_PACKS, PlaceholderPurchases, type PurchaseProvider } from './purchases';

function el(tag: string, cls?: string, html?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export class UI {
  root: HTMLElement;
  ads: AdProvider = withMusicPause(new PlaceholderAdProvider());
  purchases: PurchaseProvider = new PlaceholderPurchases();
  private panel: HTMLElement | null = null;
  private bars: Record<string, HTMLElement> = {};
  private fade: HTMLElement;
  private openTab: string | null = null;
  private prestigeArmed = false;
  private remoteBoard: LbEntry[] | null = null;
  private garageSheetOpen = true; // cosmetics list visible over the 3D garage
  private adInProgress = false;
  private lastAdStartedAt = 0;

  lb: LeaderboardProvider | null = null;
  names: UsernameService | null = null;
  /** fired with true when the garage tab opens, false when it closes */
  onGarage?: (open: boolean) => void;

  constructor(private game: Game, private onCosmeticsChanged: () => void) {
    this.root = document.getElementById('app')!;
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="stat"><span class="k">RESPECT</span><span class="v" id="v-respect">0</span></div>
        <div class="stat"><span class="k">MENTALITY</span><span class="v gold" id="v-mentality">0</span></div>
        <div class="stat small"><span class="k">/TAP</span><span class="v" id="v-tap">1</span></div>
        <div class="stat small"><span class="k">/SEC</span><span class="v" id="v-rps">0</span></div>
        <button class="stat mute" id="btn-mute" title="sound">🔊</button>
      </div>
      <div class="boost-pill" id="boost-pill" hidden></div>
      <button class="quick-buy" id="quick-buy" hidden></button>
      <div class="opp-bar">
        <div class="opp-name" id="opp-name"></div>
        <div class="bar"><div class="fill" id="opp-fill"></div>
          <div class="notch" style="left:25%"></div><div class="notch" style="left:50%"></div>
          <div class="notch" style="left:75%"></div><div class="notch" style="left:90%"></div>
        </div>
        <div class="opp-blurb" id="opp-blurb"></div>
      </div>
      <div class="menu-row">
        <button data-tab="upgrades">UPGRADES</button>
        <button data-tab="crew">CREW</button>
        <button data-tab="garage">GARAGE</button>
        <button data-tab="ranks">🏆 RANKS</button>
        <button data-tab="boosters" class="hot">📺 BOOSTERS</button>
      </div>
      <div class="toasts" id="toasts"></div>
      <div class="fade" id="fade"></div>`;
    this.fade = document.getElementById('fade')!;

    this.root.querySelectorAll('.menu-row button').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.toggle((b as HTMLElement).dataset.tab!);
      });
    });

    // quick-buy: the always-visible "next affordable purchase" (constant
    // cadence — no menu diving for the next power bump)
    document.getElementById('quick-buy')!.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const best = this.game.cheapestAffordable();
      if (!best) return;
      if (best.kind === 'upgrades' ? this.game.buyUpgrade(best.id) : this.game.buyCrew(best.id)) {
        sfx.buy();
        this.refresh();
      }
    });

    const muteBtn = document.getElementById('btn-mute')!;
    muteBtn.textContent = sfx.muted ? '🔇' : '🔊';
    muteBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      muteBtn.textContent = sfx.toggleMute() ? '🔇' : '🔊';
    });
  }

  /** One rewarded request at a time, with a five-second start cooldown. */
  private async showRewardedAd(fallbackSeconds: number): Promise<AdResult | null> {
    const now = Date.now();
    const waitMs = 5000 - (now - this.lastAdStartedAt);
    if (this.adInProgress) {
      this.toast('An ad is already opening.');
      return null;
    }
    if (waitMs > 0) {
      this.toast(`Please wait ${Math.ceil(waitMs / 1000)}s before opening another ad.`);
      return null;
    }
    this.adInProgress = true;
    this.lastAdStartedAt = now;
    try { return await this.ads.show(fallbackSeconds); }
    finally { this.adInProgress = false; }
  }

  // ---- HUD refresh ----------------------------------------------------------
  refresh() {
    const g = this.game;
    setText('v-respect', fmt(g.s.respect));
    setText('v-mentality', fmt(g.s.mentality));
    setText('v-tap', fmt(g.respectPerTap));
    setText('v-rps', fmt(g.respectPerSec));
    setText('opp-name', `RED LIGHT ${g.s.opponentIndex + 1} — ${g.opponent.name}`);
    setText('opp-blurb', g.opponent.blurb);
    (document.getElementById('opp-fill')!).style.width = `${(g.progress01 * 100).toFixed(1)}%`;

    const qb = document.getElementById('quick-buy')!;
    const best = g.cheapestAffordable();
    if (best && !this.isPanelOpen) {
      qb.hidden = false;
      qb.textContent = `⚡ ${best.name} — ${fmt(best.cost)} R`;
    } else qb.hidden = true;

    const pill = document.getElementById('boost-pill')!;
    if (g.boostActive) {
      pill.hidden = false;
      pill.textContent = `🔥 x${g.s.boostMult} — ${Math.ceil((g.s.boostEndsAt - Date.now()) / 1000)}s`;
    } else pill.hidden = true;

    if (this.openTab) this.refreshPanel();
  }

  toast(msg: string, cls = '') {
    const t = el('div', `toast ${cls}`, msg);
    document.getElementById('toasts')!.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 2600);
  }

  flashFade(cb?: () => void) {
    this.fade.classList.add('on');
    setTimeout(() => { this.fade.classList.remove('on'); cb?.(); }, 2400);
  }

  // ---- panels -----------------------------------------------------------------
  /** First-launch claim (free) or paid rename (100K Respect). Resolves once
   *  a unique name is secured; first-launch cannot be dismissed. */
  promptUsername(firstTime: boolean): Promise<void> {
    return new Promise((resolve) => {
      const g = this.game;
      const overlay = el('div', 'ad-overlay');
      overlay.innerHTML = `
        <div class="ad-box name-box">
          <div class="ad-label">${firstTime ? 'WELCOME TO THE INTERSECTION' : 'CHANGE USERNAME'}</div>
          <div class="name-copy">${firstTime
            ? 'Claim your one-of-a-kind username. Nobody else can ever register it.'
            : `Costs ${fmt(RENAME_COST)} Respect. Your new name must also be unique.`}</div>
          <input class="name-input" maxlength="14" placeholder="3-14 letters/numbers/_" spellcheck="false" />
          <div class="name-status"></div>
          <div class="name-actions">
            ${firstTime ? '' : '<button class="name-cancel">CANCEL</button>'}
            <button class="name-ok">${firstTime ? 'CLAIM' : `PAY ${fmt(RENAME_COST)}`}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('.name-input') as HTMLInputElement;
      const status = overlay.querySelector('.name-status') as HTMLElement;
      const done = () => { overlay.remove(); this.refresh(); resolve(); };
      overlay.querySelector('.name-cancel')?.addEventListener('click', done);
      overlay.querySelector('.name-ok')!.addEventListener('click', async () => {
        const name = input.value.trim();
        if (!USERNAME_RE.test(name)) { status.textContent = '3-14 chars: letters, numbers, _'; return; }
        if (!this.names) { status.textContent = 'Name service unavailable.'; return; }
        if (!firstTime && g.s.respect < RENAME_COST) { status.textContent = 'Not enough Respect.'; return; }
        status.textContent = 'Checking availability...';
        if (!(await this.names.claim(name))) { status.textContent = `"${name}" is taken. Names can't be stolen.`; return; }
        const old = g.s.username;
        if (!firstTime) g.s.respect -= RENAME_COST;
        g.s.username = name;
        g.save();
        if (old) void this.names.release(old);
        sfx.buy();
        this.toast(`Username secured: ${name}`, 'gold');
        done();
      });
      input.focus();
    });
  }

  /** The M (Mentality) store: buy premium currency with real money, or watch
   *  a rewarded ad for a small amount (roughly the ad's worth). */
  showMShop() {
    const ov = el('div', 'ad-overlay');
    const packRows = M_PACKS.map(p => `
      <div class="row">
        <div class="row-txt"><div class="row-name">💎 ${fmt(p.amount)} M${p.tag ? ` <span class="mtag">${p.tag}</span>` : ''}</div>
          <div class="row-desc">${p.bonus ? `${p.bonus} bonus` : 'Starter pack'}</div></div>
        <button data-pack="${p.id}">${p.price}</button>
      </div>`).join('');
    ov.innerHTML = `
      <div class="ad-box mshop">
        <div class="panel-head">GET MORE M<button class="x">✕</button></div>
        <div class="panel-note">M is premium currency for cosmetics & The Lab. Complete the ad to earn M; closing early or going offline gives no reward.</div>
        <div class="row mshop-ad">
          <div class="row-txt"><div class="row-name">📺 Watch ad → +${AD_M_REWARD} M</div>
            <div class="row-desc">Free. As much M as the ad is worth.</div></div>
          <button class="m-ad">WATCH</button>
        </div>
        ${packRows}
      </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector('.x')!.addEventListener('click', close);
    ov.querySelector('.m-ad')!.addEventListener('click', async () => {
      const ad = await this.showRewardedAd(15);
      if (!ad) return;
      if (ad.rewarded) {
        this.game.s.mentality += AD_M_REWARD;
        this.game.save();
        sfx.buy();
        this.toast(`+${AD_M_REWARD} M`, 'gold');
        this.refresh();
      } else this.toast('Ad closed early or unavailable — no M awarded.');
    });
    ov.querySelectorAll('.row button[data-pack]').forEach((b) => {
      b.addEventListener('click', async () => {
        const pack = M_PACKS.find(p => p.id === (b as HTMLElement).dataset.pack)!;
        const ok = await this.purchases.buy(pack);
        if (ok) {
          this.game.s.mentality += pack.amount;
          this.game.save();
          sfx.buy();
          this.toast(`Purchased ${fmt(pack.amount)} M!`, 'gold');
          this.refresh();
        }
      });
    });
  }

  /** Shown when a purchase fails for lack of M — routes to the M store. */
  needMoreM(shortBy?: number) {
    const ov = el('div', 'ad-overlay');
    ov.innerHTML = `
      <div class="ad-box">
        <div class="ad-label">NOT ENOUGH M</div>
        <div class="ad-screen">
          <div class="ad-art">💎</div>
          <div class="ad-copy">You need more <b style="color:#e6c84a">M</b>${shortBy ? ` (${fmt(shortBy)} short)` : ''}.<br/>
          Watch an ad to earn some, or grab a pack.</div>
        </div>
        <div class="name-actions">
          <button class="nm-cancel">NOT NOW</button>
          <button class="nm-shop">📺 GET M</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ov.querySelector('.nm-cancel')!.addEventListener('click', () => ov.remove());
    ov.querySelector('.nm-shop')!.addEventListener('click', () => { ov.remove(); this.showMShop(); });
  }

  /** Laptop tapped in the garage → expand the cosmetics shop sheet. */
  openGarageShop() {
    if (this.openTab !== 'garage') return;
    this.garageSheetOpen = true;
    this.panel?.classList.remove('collapsed');
    this.refreshPanel();
    sfx.click();
  }

  private toggle(tab: string) {
    if (this.openTab === tab) return this.close();
    const wasGarage = this.openTab === 'garage';
    this.openTab = tab;
    // garage opens with the sheet COLLAPSED — you see your car first,
    // cosmetics list is one tap away
    this.garageSheetOpen = tab !== 'garage';
    this.panel?.remove();
    this.panel = el('div', tab === 'garage' ? 'panel panel-garage collapsed' : 'panel');
    this.root.appendChild(this.panel);
    this.refreshPanel();
    const isGarage = tab === 'garage';
    // Only the actual garage transition gets a scene fade/audio swap.
    if (wasGarage !== isGarage) this.onGarage?.(isGarage);
    sfx.click();
  }

  /** Offline earnings collect: take it, or double it with an ad. */
  showOfflineModal(gain: number, seconds: number) {
    const overlay = el('div', 'ad-overlay');
    overlay.innerHTML = `
      <div class="ad-box">
        <div class="ad-label">WHILE YOU WERE GONE</div>
        <div class="ad-screen">
          <div class="ad-art">😴</div>
          <div class="ad-copy">Your crew kept tapping for ${Math.round(seconds / 60)} min.<br/>
          They earned <b style="color:#e6c84a">${fmt(gain)} Respect</b>.</div>
        </div>
        <div class="name-actions">
          <button class="off-collect">COLLECT</button>
          <button class="off-double" title="Complete the ad. Closing early gives no bonus.">📺 COLLECT ×2</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.off-collect')!.addEventListener('click', () => {
      overlay.remove();
      this.refresh();
    });
    overlay.querySelector('.off-double')!.addEventListener('click', async () => {
      overlay.remove();
      const ad = await this.showRewardedAd(15);
      if (!ad) return;
      if (ad.rewarded) {
        this.game.s.respect += gain; // second copy of the earnings
        sfx.buy();
        this.toast(`DOUBLED: +${fmt(gain)} bonus Respect`, 'gold');
      } else this.toast('Ad closed early or unavailable — no bonus awarded.');
      this.refresh();
    });
  }

  /** fast black dip for scene transitions (garage in/out) */
  quickFade(cb: () => void) {
    this.fade.classList.add('quick', 'on');
    setTimeout(() => { cb(); }, 180);
    setTimeout(() => this.fade.classList.remove('on'), 320);
    setTimeout(() => this.fade.classList.remove('quick'), 650);
  }

  close() {
    const wasGarage = this.openTab === 'garage';
    this.openTab = null;
    this.prestigeArmed = false;
    this.remoteBoard = null; // refetch live board next open
    this.panel?.remove();
    this.panel = null;
    if (wasGarage) this.onGarage?.(false);
  }

  get isPanelOpen() { return this.openTab !== null; }

  private refreshPanel() {
    if (!this.panel || !this.openTab) return;
    const g = this.game;
    const rows: string[] = [`<div class="panel-head">${this.openTab.toUpperCase()}<button class="x">✕</button></div>`];

    if (this.openTab === 'upgrades') {
      // New Route (prestige) lives at the top of the upgrades list
      if (g.canPrestige) {
        rows.push(row('prestige', this.prestigeArmed ? '⚠️ TAP AGAIN TO CONFIRM' : '🛣️ NEW ROUTE',
          `Reset the run for a PERMANENT x2 respect (now x${fmt(g.routeMult)}). Keeps Mentality, garage, username.`,
          this.prestigeArmed ? 'CONFIRM' : `x${fmt(g.routeMult * 2)}`, true, 'prestige'));
      } else {
        rows.push(row('prestige', '🛣️ New Route (locked)',
          `Reach RED LIGHT ${g.prestigeRequirement + 1} to reset for a permanent x2 respect. Next route: +${PRESTIGE_STEP} lights.`,
          `LIGHT ${g.prestigeRequirement + 1}`, false, 'prestige'));
      }
      for (const u of UPGRADES) {
        const lv = g.s.upgradeLevels[u.id] ?? 0;
        const maxed = !!u.maxLevel && lv >= u.maxLevel;
        const cost = g.upgradeCost(u.id);
        rows.push(row(u.id, u.name, `Lv ${lv}${maxed ? ' MAX' : ''} · ${u.desc}`,
          maxed ? '—' : `${fmt(cost)} R`, !maxed && g.s.respect >= cost, 'upgrades'));
      }
      // THE LAB: permanent Mentality upgrades, survive New Route
      rows.push(`<div class="panel-note">🧪 THE LAB — permanent upgrades bought with Mentality. These survive New Route.</div>`);
      for (const l of LAB) {
        const owned = g.hasLab(l.id);
        rows.push(row(l.id, `${l.name}${owned ? ' ✓' : ''}`, l.desc,
          owned ? 'OWNED' : `${l.cost} M`, !owned, 'lab')); // clickable even if unaffordable → prompt
      }
    } else if (this.openTab === 'crew') {
      for (const c of CREW) {
        const n = g.s.crewCounts[c.id] ?? 0;
        const cost = g.crewCost(c.id);
        rows.push(row(c.id, c.name, `x${n} · ${c.desc} (+${fmt(c.tapsPerSec)}/s)`,
          `${fmt(cost)} R`, g.s.respect >= cost, 'crew'));
      }
    } else if (this.openTab === 'garage') {
      // Garage is a 3D room behind the UI. The cosmetics list is a collapsible
      // bottom sheet — collapsing it reveals the car; a dedicated EXIT leaves.
      if (this.garageSheetOpen) {
        rows.length = 0; // custom header for garage
        rows.push(`<div class="panel-head garage-head">
          <button class="g-exit">‹ EXIT</button>
          <span>GARAGE</span>
          <button class="g-collapse">▾ HIDE</button></div>`);
        rows.push(`<div class="panel-note">Swipe the car to rotate · tap it to sit inside. Equip cosmetics to see them on your ride.</div>`);
        // premium currency store — buy M or watch an ad for it
        rows.push(row('getm', `💎 Get More M — you have ${fmt(g.s.mentality)}`,
          'Buy premium M, or watch an ad for a little.', 'STORE', true, 'getm'));
        for (const c of COSMETICS) {
          const owned = g.s.ownedCosmetics.includes(c.id);
          const equipped = g.s.equippedCosmetics[c.slot] === c.id;
          rows.push(row(c.id, `${c.name}${equipped ? ' ✓' : ''}`, c.desc,
            owned ? (equipped ? 'UNEQUIP' : 'EQUIP') : `${c.cost} M`,
            true, 'cosmetic')); // always clickable → buy or "need more M" prompt
        }
      } else {
        rows.length = 0; // collapsed: just controls, car fully visible
        rows.push(`<div class="garage-bar">
          <button class="g-exit">‹ EXIT GARAGE</button>
          <button class="g-show">▴ COSMETICS</button></div>`);
      }
    } else if (this.openTab === 'ranks') {
      const native = !!this.lb && this.lb.platform !== 'web';
      rows.push(`<div class="panel-note">🌍 WORLDWIDE — ALL-TIME TAPS (raw taps only, boosters don't count)${native
        ? ` · syncing via ${this.lb!.platform === 'gamecenter' ? 'Game Center' : 'Google Play Games'}`
        : ' · placeholder rivals until store launch (Game Center / Play Games)'}</div>`);
      // real backend when configured (async: seeded list shows immediately,
      // live worldwide data patches in when the fetch lands)
      if (API_URL && g.s.username && this.openTab === 'ranks' && !this.remoteBoard) {
        void fetchBoardRemote(API_URL, g.s.username).then((b) => {
          if (b?.length) { this.remoteBoard = b; if (this.openTab === 'ranks') this.refreshPanel(); }
        });
      }
      const list = this.remoteBoard ?? getWorldList(g.s.totalTaps, g.s.username ?? 'YOU');
      const yourRank = list.find(e => e.you)?.rank ?? Infinity;
      // Subway-Surfers-style ranked list: top 10, a gap, then your neighborhood
      const shown = list.filter(e => e.rank <= 10 || Math.abs(e.rank - yourRank) <= 2);
      let prev = 0;
      for (const e of shown) {
        if (e.rank > prev + 1) rows.push(`<div class="lb-gap">···</div>`);
        prev = e.rank;
        rows.push(`<div class="lb-row${e.you ? ' lb-you' : ''}">
          <span class="lb-rank">${e.rank <= 3 ? ['🥇', '🥈', '🥉'][e.rank - 1] : '#' + e.rank}</span>
          <span class="lb-name">${e.you ? `⭐ ${e.name}` : e.name}</span>
          <span class="lb-score">${fmt(e.taps)}</span>
        </div>`);
      }
      rows.push(row('rename', `Username: ${g.s.username ?? '—'}`,
        `Change costs ${fmt(RENAME_COST)} Respect (one-of-a-kind, can't be stolen)`,
        'CHANGE', g.s.respect >= RENAME_COST, 'name'));
      if (native) {
        rows.push(row('official', 'Official Board', 'Open the platform leaderboard', 'VIEW', true, 'lb'));
        rows.push(row('signin', 'Account', 'Sign in to submit your taps worldwide', 'SIGN IN', true, 'lb'));
      }
    } else if (this.openTab === 'boosters') {
      rows.push(`<div class="panel-note">AdMob chooses the ad length. Finish it to receive the matching reward below; closing early or going offline gives no reward. Ads watched: ${g.s.adsWatched}</div>`);
      for (const b of BOOSTERS) {
        rows.push(row(b.id, `📺 ${b.name}`, b.desc, b.id === 'mid' ? 'WATCH AD' : 'AUTO', b.id === 'mid', b.id === 'mid' ? 'booster' : 'tier'));
      }
    }

    this.panel.innerHTML = rows.join('');
    this.panel.querySelector('.x')?.addEventListener('click', () => this.close());
    // garage-specific controls
    this.panel.querySelector('.g-exit')?.addEventListener('click', () => this.close());
    this.panel.querySelector('.g-collapse')?.addEventListener('click', () => {
      this.garageSheetOpen = false; this.panel!.classList.add('collapsed'); this.refreshPanel();
    });
    this.panel.querySelector('.g-show')?.addEventListener('click', () => {
      this.garageSheetOpen = true; this.panel!.classList.remove('collapsed'); this.refreshPanel();
    });
    this.panel.querySelectorAll('.row button').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = (btn as HTMLElement).dataset.id!;
        const kind = (btn as HTMLElement).dataset.kind!;
        this.action(kind, id);
      });
    });
  }

  private async action(kind: string, id: string) {
    const g = this.game;
    if (kind === 'prestige') {
      if (!this.prestigeArmed) {
        this.prestigeArmed = true;
      } else {
        this.prestigeArmed = false;
        if (g.prestige()) { this.close(); return; }
      }
    } else if (kind === 'lab') {
      const l = LAB.find(x => x.id === id);
      if (g.buyLab(id)) sfx.buy();
      else if (l && !g.hasLab(id) && g.s.mentality < l.cost) { this.needMoreM(l.cost - g.s.mentality); return; }
    }
    else if (kind === 'upgrades') { if (g.buyUpgrade(id)) sfx.buy(); }
    else if (kind === 'crew') { if (g.buyCrew(id)) sfx.buy(); }
    else if (kind === 'getm') { this.showMShop(); return; }
    else if (kind === 'cosmetic') {
      const c = COSMETICS.find(x => x.id === id);
      if (g.s.ownedCosmetics.includes(id)) g.toggleCosmetic(id);
      else if (!g.buyCosmetic(id)) {
        if (c && g.s.mentality < c.cost) this.needMoreM(c.cost - g.s.mentality);
        return;
      }
      sfx.buy();
      this.onCosmeticsChanged();
    } else if (kind === 'lb') {
      if (!this.lb) return;
      if (id === 'signin') {
        const ok = await this.lb.signIn();
        this.toast(ok ? 'Signed in — taps will sync worldwide.' : 'Sign-in unavailable here.', ok ? 'gold' : '');
      } else {
        await this.lb.show();
      }
    } else if (kind === 'name') {
      this.close();
      await this.promptUsername(false);
    } else if (kind === 'booster') {
      this.close(); // starting an ad closes any open menu — no stacked overlays
      const ad = await this.showRewardedAd(15);
      if (!ad) return;
      if (ad.rewarded) {
        const b = ad.watchedSeconds < 10 ? BOOSTERS[0]
          : ad.watchedSeconds < 25 ? BOOSTERS[1]
            : BOOSTERS[2];
        g.grantBooster(b);
        sfx.boost();
        this.toast(`${Math.round(ad.watchedSeconds)}s ad complete — ${b.name} awarded!`, 'gold');
      } else this.toast('Ad closed early or unavailable — no boost awarded.');
    }
    this.refresh();
  }
}

function row(id: string, name: string, desc: string, action: string, enabled: boolean, kind?: string): string {
  return `<div class="row">
    <div class="row-txt"><div class="row-name">${name}</div><div class="row-desc">${desc}</div></div>
    <button data-id="${id}" data-kind="${kind ?? 'AUTO'}" ${enabled ? '' : 'disabled'}>${action}</button>
  </div>`;
}

function setText(id: string, v: string) {
  const e = document.getElementById(id);
  if (e && e.textContent !== v) e.textContent = v;
}
