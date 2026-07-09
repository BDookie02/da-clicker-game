import { BOOSTERS, COSMETICS, CREW, UPGRADES, type BoosterDef } from './config';
import { fmt, type Game } from './state';
import { sfx } from './audio';
import { getWorldList, type LeaderboardProvider } from './leaderboard';
import { RENAME_COST, USERNAME_RE, type UsernameService } from './username';

// ---------------------------------------------------------------------------
// Rewarded-ad adapter. The placeholder provider fakes an ad with a countdown.
// For store builds, swap in an AdMob provider (Capacitor community plugin
// `@capacitor-community/admob`, RewardedAd) behind this same interface —
// the game only ever calls show() and reads the resolved boolean.
// ---------------------------------------------------------------------------
export interface AdProvider {
  show(lengthSec: number): Promise<boolean>; // true = watched to completion
}

class PlaceholderAdProvider implements AdProvider {
  show(lengthSec: number): Promise<boolean> {
    return new Promise((resolve) => {
      const overlay = el('div', 'ad-overlay');
      overlay.innerHTML = `
        <div class="ad-box">
          <div class="ad-label">AD · PLACEHOLDER</div>
          <div class="ad-screen">
            <div class="ad-art">📺</div>
            <div class="ad-copy">Your ad network renders here.<br/>(AdMob rewarded slot)</div>
          </div>
          <div class="ad-timer"></div>
          <button class="ad-skip" disabled>reward in <span></span>s</button>
        </div>`;
      document.body.appendChild(overlay);
      const btn = overlay.querySelector('.ad-skip') as HTMLButtonElement;
      const span = btn.querySelector('span')!;
      span.textContent = String(lengthSec);

      // Verified watch: credit only wall-clock time while the page is actually
      // visible. Hiding the tab pauses the counter; there is no dismiss/skip,
      // so the reward is unreachable without a full watch. In store builds the
      // AdMob provider replaces this — its reward event only fires on SDK-
      // confirmed completion (enable server-side verification for hard proof).
      let watched = 0;
      let lastT = performance.now();
      const iv = setInterval(() => {
        const now = performance.now();
        if (!document.hidden) watched += (now - lastT) / 1000;
        lastT = now;
        const left = Math.max(0, Math.ceil(lengthSec - watched));
        span.textContent = document.hidden ? `${left} (paused)` : String(left);
        if (watched >= lengthSec) {
          clearInterval(iv);
          btn.disabled = false;
          btn.innerHTML = 'CLAIM REWARD';
          btn.onclick = () => { overlay.remove(); resolve(watched >= lengthSec); };
        }
      }, 250);
    });
  }
}

function el(tag: string, cls?: string, html?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export class UI {
  root: HTMLElement;
  private ads: AdProvider = new PlaceholderAdProvider();
  private panel: HTMLElement | null = null;
  private bars: Record<string, HTMLElement> = {};
  private fade: HTMLElement;
  private openTab: string | null = null;

  lb: LeaderboardProvider | null = null;
  names: UsernameService | null = null;

  constructor(private game: Game, private onCosmeticsChanged: () => void) {
    this.root = document.getElementById('app')!;
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="stat"><span class="k">RESPECT</span><span class="v" id="v-respect">0</span></div>
        <div class="stat"><span class="k">MENTALITY</span><span class="v gold" id="v-mentality">0</span></div>
        <div class="stat small"><span class="k">/TAP</span><span class="v" id="v-tap">1</span></div>
        <div class="stat small"><span class="k">/SEC</span><span class="v" id="v-rps">0</span></div>
      </div>
      <div class="boost-pill" id="boost-pill" hidden></div>
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

  private toggle(tab: string) {
    if (this.openTab === tab) return this.close();
    this.openTab = tab;
    this.panel?.remove();
    this.panel = el('div', 'panel');
    this.root.appendChild(this.panel);
    this.refreshPanel();
    sfx.click();
  }

  close() {
    this.openTab = null;
    this.panel?.remove();
    this.panel = null;
  }

  get isPanelOpen() { return this.openTab !== null; }

  private refreshPanel() {
    if (!this.panel || !this.openTab) return;
    const g = this.game;
    const rows: string[] = [`<div class="panel-head">${this.openTab.toUpperCase()}<button class="x">✕</button></div>`];

    if (this.openTab === 'upgrades') {
      for (const u of UPGRADES) {
        const lv = g.s.upgradeLevels[u.id] ?? 0;
        const maxed = !!u.maxLevel && lv >= u.maxLevel;
        const cost = g.upgradeCost(u.id);
        rows.push(row(u.id, u.name, `Lv ${lv}${maxed ? ' MAX' : ''} · ${u.desc}`,
          maxed ? '—' : `${fmt(cost)} R`, !maxed && g.s.respect >= cost, 'upgrades'));
      }
    } else if (this.openTab === 'crew') {
      for (const c of CREW) {
        const n = g.s.crewCounts[c.id] ?? 0;
        const cost = g.crewCost(c.id);
        rows.push(row(c.id, c.name, `x${n} · ${c.desc} (+${fmt(c.tapsPerSec)}/s)`,
          `${fmt(cost)} R`, g.s.respect >= cost, 'crew'));
      }
    } else if (this.openTab === 'garage') {
      rows.push(`<div class="panel-note">Aesthetic unlockables. Placeholder art — final meme skins land via the asset pipeline.</div>`);
      for (const c of COSMETICS) {
        const owned = g.s.ownedCosmetics.includes(c.id);
        const equipped = g.s.equippedCosmetics[c.slot] === c.id;
        rows.push(row(c.id, `${c.name}${equipped ? ' ✓' : ''}`, c.desc,
          owned ? (equipped ? 'UNEQUIP' : 'EQUIP') : `${c.cost} M`,
          owned || g.s.mentality >= c.cost, 'cosmetic'));
      }
    } else if (this.openTab === 'ranks') {
      const native = !!this.lb && this.lb.platform !== 'web';
      rows.push(`<div class="panel-note">🌍 WORLDWIDE — ALL-TIME TAPS (raw taps only, boosters don't count)${native
        ? ` · syncing via ${this.lb!.platform === 'gamecenter' ? 'Game Center' : 'Google Play Games'}`
        : ' · placeholder rivals until store launch (Game Center / Play Games)'}</div>`);
      const list = getWorldList(g.s.totalTaps, g.s.username ?? 'YOU');
      const yourRank = list.find(e => e.you)!.rank;
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
      rows.push(`<div class="panel-note">Watch an ad, get a booster. No daily limit — the more the merrier. Ads watched: ${g.s.adsWatched}</div>`);
      for (const b of BOOSTERS) {
        rows.push(row(b.id, `📺 ${b.name}`, b.desc, `WATCH ${b.adSeconds}s`, true, 'booster'));
      }
    }

    this.panel.innerHTML = rows.join('');
    this.panel.querySelector('.x')!.addEventListener('click', () => this.close());
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
    if (kind === 'upgrades') { if (g.buyUpgrade(id)) sfx.buy(); }
    else if (kind === 'crew') { if (g.buyCrew(id)) sfx.buy(); }
    else if (kind === 'cosmetic') {
      if (g.s.ownedCosmetics.includes(id)) g.toggleCosmetic(id);
      else if (!g.buyCosmetic(id)) return;
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
      const b = BOOSTERS.find(x => x.id === id) as BoosterDef;
      this.close(); // starting an ad closes any open menu — no stacked overlays
      const watched = await this.ads.show(b.adSeconds);
      if (watched) {
        g.grantBooster(b);
        sfx.boost();
      }
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
