import { BOOSTERS, COSMETICS, CREW, LAB, UPGRADES, type BoosterDef } from './config';
import { fmt, PRESTIGE_STEP, type Game } from './state';
import { music, sfx } from './audio';
import { fetchBoardRemote, getWorldList, type LbEntry, type LeaderboardProvider } from './leaderboard';
import { API_URL } from './config';
import { RENAME_COST, validateUsername, type UsernameService } from './username';
import type { AccountService } from './account';

// Rewarded ads live in src/ads.ts: real AdMob on device, verified-watch
// placeholder on web. main.ts swaps the provider in via initAds().
import { AD_CONFIG, PlaceholderAdProvider, showAdPrivacyOptions, withMusicPause, type AdProvider, type AdResult } from './ads';
import { AD_M_REWARD, M_PACKS, PlaceholderPurchases, queuePendingPurchase, removePendingPurchase, type PurchaseProvider } from './purchases';

function el(tag: string, cls?: string, html?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export class UI {
  onEyeReset?: () => void;
  root: HTMLElement;
  ads: AdProvider = withMusicPause(new PlaceholderAdProvider());
  purchases: PurchaseProvider = new PlaceholderPurchases();
  account: AccountService | null = null;
  private panel: HTMLElement | null = null;
  private bars: Record<string, HTMLElement> = {};
  private fade: HTMLElement;
  private openTab: string | null = null;
  private prestigeArmed = false;
  private remoteBoard: LbEntry[] | null = null;
  private garageSheetOpen = true; // cosmetics list visible over the 3D garage
  private adInProgress = false;
  private lastAdStartedAt = 0;
  private fadeTransition = 0;
  private readonly scaledFontElements = new Set<HTMLElement>();
  private readonly fittedFontSizes = new Map<HTMLElement, string>();
  private readonly textScales = [1, 1.15, 1.3, 1.45] as const;
  private readonly layoutObserver: ResizeObserver;

  lb: LeaderboardProvider | null = null;
  names: UsernameService | null = null;
  /** fired with true when the garage tab opens, false when it closes */
  onGarage?: (open: boolean) => void;
  onViewSettings?: (fov: number, sensitivity: number, reducedMotion: boolean) => void;
  onResetView?: () => void;

  constructor(private game: Game, private onCosmeticsChanged: () => void) {
    this.root = document.getElementById('app')!;
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="stat"><span class="k">RESPECT</span><span class="v" id="v-respect">0</span></div>
        <div class="stat"><span class="k">MENTALITY</span><span class="v gold" id="v-mentality">0</span></div>
        <div class="stat small"><span class="k">/TAP</span><span class="v" id="v-tap">1</span></div>
        <div class="stat small"><span class="k">/SEC</span><span class="v" id="v-rps">0</span></div>
        <button class="stat eye" id="btn-eye" title="reset eye contact">&#128065;</button><button class="stat settings" id="btn-settings" title="settings">&#9881;</button>
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
        <button data-tab="ranks">RANKS</button>
        <button data-tab="boosters" class="hot">BOOSTERS</button>
      </div>
      <div class="toasts" id="toasts"></div>
      <div class="fade" id="fade"></div>`;
    this.fade = document.getElementById('fade')!;
    // Reserve the space the rendered HUD/navigation actually consume. This
    // updates after wrapping, text scaling, rotation, and split-screen resize.
    this.layoutObserver = new ResizeObserver(() => this.updateLayoutMetrics());
    this.layoutObserver.observe(this.root.querySelector('.hud-top')!);
    this.layoutObserver.observe(this.root.querySelector('.menu-row')!);
    this.applyTextSize();
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) {
          this.scaleTextTree(node);
          this.scheduleTextFit(node);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    new MutationObserver(() => {
      requestAnimationFrame(() => {
        this.updateLayoutMetrics();
        requestAnimationFrame(() => this.updateLayoutMetrics());
      });
    }).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-text-tier'] });
    addEventListener('resize', () => {
      this.updateLayoutMetrics();
      this.scheduleTextFit(document.body);
    });
    requestAnimationFrame(() => {
      this.updateLayoutMetrics();
      this.scheduleTextFit(document.body);
    });

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

    const eyeBtn = document.getElementById('btn-eye')!;
    eyeBtn.addEventListener('click', (ev) => { ev.stopPropagation(); this.onEyeReset?.(); });
    const settingsBtn = document.getElementById('btn-settings')!;
    settingsBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.toggle('settings');
    });
  }

  private scaleTextTree(root: HTMLElement) {
    const scale = this.textScales[this.game.s.textSizeTier] ?? 1;
    const elements = root === document.body
      ? [root, ...root.querySelectorAll<HTMLElement>('*')]
      : [root, ...root.querySelectorAll<HTMLElement>('*')];
    for (const element of elements) {
      // Scale each actual text run once. Scaling structural parents and then
      // their descendants compounded inherited sizes (1.45x became 2.10x).
      // If a text-owning ancestor already scales this run, descendants inherit.
      const ownsText = [...element.childNodes].some(node =>
        node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()))
        || element.matches('input, textarea, select');
      if (!ownsText) continue;
      let parent = element.parentElement;
      let inheritedFromScaledParent = false;
      while (parent && parent !== root.parentElement) {
        if (this.scaledFontElements.has(parent)) { inheritedFromScaledParent = true; break; }
        parent = parent.parentElement;
      }
      if (inheritedFromScaledParent) continue;
      const base = Number.parseFloat(getComputedStyle(element).fontSize);
      if (!Number.isFinite(base) || base <= 0) continue;
      element.style.fontSize = `${Math.round(base * scale * 100) / 100}px`;
      this.scaledFontElements.add(element);
    }
  }

  private applyTextSize() {
    for (const [element, size] of this.fittedFontSizes) element.style.fontSize = size;
    this.fittedFontSizes.clear();
    for (const element of this.scaledFontElements) element.style.removeProperty('font-size');
    this.scaledFontElements.clear();
    document.body.dataset.textTier = String(this.game.s.textSizeTier);
    this.scaleTextTree(document.body);
    this.scheduleTextFit(document.body);
    requestAnimationFrame(() => this.updateLayoutMetrics());
  }

  private scheduleTextFit(root: HTMLElement) {
    requestAnimationFrame(() => {
      this.fitBorderedLabels(root);
      // Android WebView can settle fallback/emoji glyph metrics a frame late.
      requestAnimationFrame(() => this.fitBorderedLabels(root));
    });
  }

  /** Keep every UI word intact. Buttons stay single-line; prose may wrap only
   * between words. Type shrinks only when an unbroken word would cross its
   * visible container. */
  private fitBorderedLabels(root: HTMLElement) {
    const selector = 'button, .panel-title, .stat .k, .stat .v, .row-name, .row-desc, .panel-note, .setting-name, .setting-value, .setting-check, .name-copy, .ad-copy, .tutorial-copy';
    const targets = root.matches(selector)
      ? [root, ...root.querySelectorAll<HTMLElement>(selector)]
      : [...root.querySelectorAll<HTMLElement>(selector)];
    for (const element of targets) {
      const previous = this.fittedFontSizes.get(element);
      if (previous !== undefined) {
        element.style.fontSize = previous;
        this.fittedFontSizes.delete(element);
      }
      if (element.clientWidth < 2 || element.clientHeight < 2
        || (element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)) continue;
      const start = Number.parseFloat(getComputedStyle(element).fontSize);
      if (!Number.isFinite(start) || start <= 0) continue;
      this.fittedFontSizes.set(element, element.style.fontSize);
      // Binary-search the largest size that preserves one complete line. This
      // is stable for emoji/fallback fonts and avoids the multi-pass rounding
      // errors that previously left a last letter clipped on narrow phones.
      const fits = () => element.scrollWidth <= element.clientWidth + 1
        && element.scrollHeight <= element.clientHeight + 1;
      let low = 4;
      let high = start;
      element.style.fontSize = `${low}px`;
      if (!fits()) continue;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const mid = (low + high) / 2;
        element.style.fontSize = `${mid}px`;
        if (fits()) low = mid; else high = mid;
      }
      element.style.fontSize = `${Math.floor(low * 100) / 100}px`;
    }
  }

  private updateLayoutMetrics() {
    const hud = this.root.querySelector<HTMLElement>('.hud-top');
    const nav = this.root.querySelector<HTMLElement>('.menu-row');
    if (!hud || !nav) return;
    const hr = hud.getBoundingClientRect();
    const nr = nav.getBoundingClientRect();
    const hudBottom = getComputedStyle(hud).display === 'none' ? 8 : Math.ceil(hr.bottom + 8);
    // Store the navigation's actual occupied lane. CSS adds a separate,
    // visible panel gutter so the menu and buttons cannot share pixels.
    const navHeight = getComputedStyle(nav).display === 'none' ? 0 : Math.ceil(innerHeight - nr.top);
    document.body.style.setProperty('--hud-bottom', `${hudBottom}px`);
    document.body.style.setProperty('--nav-height', `${navHeight}px`);
  }

  /** One rewarded request at a time, with a five-second start cooldown. */
  private async showRewardedAd(fallbackSeconds: number, rewardKind: 'm' | 'boost' | 'offline'): Promise<AdResult | null> {
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
    const loading = { current: null as HTMLElement | null };
    const loadingTimer = window.setTimeout(() => {
      loading.current = el('div', 'ad-loading', `
        <div class="ad-loading-box" role="status" aria-live="polite">
          <div class="ad-loading-spinner" aria-hidden="true"></div>
          <div>LOADING AD…</div>
          <small>Waiting for the ad network</small>
        </div>`);
      document.body.appendChild(loading.current);
    }, 450);
    try {
      const cap = (window as any).Capacitor;
      const productionNative = !AD_CONFIG.TESTING && cap?.isNativePlatform?.();
      if (productionNative && !this.account?.signedIn) {
        this.toast('Log in before watching a reward ad so the reward can be verified.');
        return null;
      }
      const verification = productionNative
        ? await this.account!.adVerification(rewardKind)
        : undefined;
      return await this.ads.show(fallbackSeconds, verification);
    }
    finally {
      window.clearTimeout(loadingTimer);
      loading.current?.remove();
      this.adInProgress = false;
    }
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

    // Settings contains live sliders and a password field. Rebuilding it every
    // frame resets native controls, closes <details>, and erases typed codes.
    if (this.openTab && this.openTab !== 'settings') this.refreshPanel();
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

  /** One Discipline login restores the same save on Android, iOS, and web. */
  promptAccount(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.account) { resolve(); return; }
      const overlay = el('div', 'ad-overlay');
      overlay.innerHTML = `
        <div class="ad-box name-box account-box">
          <div class="ad-label">DISCIPLINE ACCOUNT</div>
          <div class="name-copy">One login keeps your username, progress, inventory, and verified purchases across Android and iOS.</div>
          <input class="name-input account-name" maxlength="14" autocomplete="username" placeholder="USERNAME" spellcheck="false" />
          <input class="name-input account-pass" type="password" maxlength="128" autocomplete="current-password" placeholder="PASSWORD 10+ CHARS" />
          <div class="name-status"></div>
          <div class="name-actions"><button class="account-login">LOG IN</button><button class="account-create">CREATE ACCOUNT</button></div>
        </div>`;
      document.body.appendChild(overlay);
      const name = overlay.querySelector('.account-name') as HTMLInputElement;
      const pass = overlay.querySelector('.account-pass') as HTMLInputElement;
      const status = overlay.querySelector('.name-status') as HTMLElement;
      const submit = async (create: boolean) => {
        const usernameCheck = validateUsername(name.value.trim());
        if (!usernameCheck.ok) { status.textContent = usernameCheck.error; return; }
        if (pass.value.length < 10) { status.textContent = 'Password must be at least 10 characters.'; return; }
        status.textContent = create ? 'Creating account…' : 'Signing in…';
        try {
          if (create) await this.account!.register(name.value.trim(), pass.value);
          else await this.account!.login(name.value.trim(), pass.value);
          this.game.s.username = this.account!.username;
          const source = await this.account!.sync(this.game.s);
          overlay.remove();
          if (source === 'cloud') location.reload();
          else { this.game.save(); this.toast(`Signed in as ${this.account!.username}`, 'gold'); this.refresh(); resolve(); }
        } catch (e) {
          const code = e instanceof Error ? e.message : '';
          status.textContent = code === 'username_taken' ? 'That username is already claimed. Log in or choose another.'
            : code === 'inappropriate_username' || code === 'reserved_username' ? 'That username is not allowed.'
            : code === 'invalid_login' ? 'Username or password is incorrect.'
              : 'Account service unavailable. Check your connection and retry.';
        }
      };
      overlay.querySelector('.account-login')!.addEventListener('click', () => void submit(false));
      overlay.querySelector('.account-create')!.addEventListener('click', () => void submit(true));
      pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit(false); });
      name.focus();
    });
  }

  /** Policy-required, deliberate account deletion. The typed phrase prevents
   * an accidental tap from erasing a cross-device save. */
  promptDeleteAccount(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.account?.signedIn) { resolve(); return; }
      const overlay = el('div', 'ad-overlay account-delete-overlay');
      overlay.innerHTML = `
        <div class="ad-box name-box account-delete-box">
          <div class="ad-label">DELETE DISCIPLINE ACCOUNT</div>
          <div class="name-copy">Permanently deletes your username, cloud progress, leaderboard score, inventory, and purchase ledger. This cannot be undone.</div>
          <input class="name-input delete-confirm" autocomplete="off" spellcheck="false" placeholder="TYPE DELETE" />
          <div class="name-status">Type DELETE to confirm.</div>
          <div class="name-actions"><button class="delete-cancel">CANCEL</button><button class="delete-final" disabled>DELETE ACCOUNT</button></div>
        </div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('.delete-confirm') as HTMLInputElement;
      const status = overlay.querySelector('.name-status') as HTMLElement;
      const remove = overlay.querySelector('.delete-final') as HTMLButtonElement;
      const done = () => { overlay.remove(); resolve(); };
      overlay.querySelector('.delete-cancel')!.addEventListener('click', done);
      input.addEventListener('input', () => { remove.disabled = input.value.trim().toUpperCase() !== 'DELETE'; });
      remove.addEventListener('click', async () => {
        if (input.value.trim().toUpperCase() !== 'DELETE') return;
        remove.disabled = true; input.disabled = true; status.textContent = 'Deleting account and cloud data…';
        try {
          await this.account!.deleteAccount();
          overlay.remove(); resolve(); location.reload();
        } catch {
          input.disabled = false; remove.disabled = false;
          status.textContent = 'Deletion failed. Check your connection and try again.';
        }
      });
      input.focus();
    });
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
          <input class="name-input" maxlength="14" placeholder="3-14 LETTERS/#/_" spellcheck="false" />
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
        const usernameCheck = validateUsername(name);
        if (!usernameCheck.ok) { status.textContent = usernameCheck.error; return; }
        if (!this.names && !this.account?.signedIn) { status.textContent = 'Name service unavailable.'; return; }
        if (!firstTime && g.s.respect < RENAME_COST) { status.textContent = 'Not enough Respect.'; return; }
        status.textContent = 'Checking availability...';
        const old = g.s.username;
        if (this.account?.signedIn) {
          try { await this.account.rename(name); }
          catch (e) {
            const code = e instanceof Error ? e.message : '';
            status.textContent = code === 'username_taken' ? `"${name}" is taken. Names can't be stolen.`
              : code === 'inappropriate_username' || code === 'reserved_username' ? 'That username is not allowed.'
                : 'Name service unavailable. Check your connection and retry.';
            return;
          }
        } else if (!this.names || !(await this.names.claim(name))) {
          status.textContent = `"${name}" is taken. Names can't be stolen.`; return;
        }
        if (!firstTime) g.s.respect -= RENAME_COST;
        g.s.username = name;
        g.save();
        // Remote rename freed old atomically. The offline provider mirrors it.
        if (old && this.names) await this.names.release(old);
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
      const ad = await this.showRewardedAd(15, 'm');
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
        const receipt = await this.purchases.buy(pack, this.account?.accountId);
        if (receipt) {
          try {
            if (receipt.platform !== 'web') {
              // Persist first: a store completion survives a crash, offline
              // period, or a player choosing to log in only after checkout.
              queuePendingPurchase(receipt);
              if (!this.account) {
                this.toast('Purchase saved. Connect the account service to verify and restore it.');
                return;
              }
              if (!this.account.signedIn) {
                close();
                this.toast('Payment saved. Log in now to attach it to your Discipline account.', 'gold');
                await this.promptAccount();
              }
            }
            const grant = receipt.platform === 'web'
              ? { amount: pack.amount, transactionId: `web-${Date.now()}` }
              : await this.account!.verifyPurchase(receipt);
            const { amount, transactionId } = grant;
            if (this.game.s.appliedPurchases.includes(transactionId)) {
              if (await this.account?.save(this.game.s)) removePendingPurchase(receipt);
              await this.purchases.finish(receipt);
              this.toast('Purchase was already added to this account.'); return;
            }
            if (amount <= 0) {
              if (await this.account?.save(this.game.s)) removePendingPurchase(receipt);
              await this.purchases.finish(receipt); this.toast('Purchase was already added to this account.'); return;
            }
            this.game.s.mentality += amount;
            this.game.s.appliedPurchases.push(transactionId);
            this.game.save();
            if (await this.account?.save(this.game.s)) removePendingPurchase(receipt);
            await this.purchases.finish(receipt);
            sfx.buy();
            this.toast(`Purchased ${fmt(amount)} M!`, 'gold');
            this.refresh();
          } catch {
            this.toast('Payment completed but verification is pending. No duplicate charge—retry after reconnecting.');
          }
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
    document.body.classList.add('panel-open');
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
      const ad = await this.showRewardedAd(15, 'offline');
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
    const transition = ++this.fadeTransition;
    this.fade.classList.add('quick', 'on');
    setTimeout(() => {
      if (transition === this.fadeTransition) cb();
    }, 180);
    setTimeout(() => {
      if (transition === this.fadeTransition) this.fade.classList.remove('on');
    }, 320);
    setTimeout(() => {
      if (transition === this.fadeTransition) this.fade.classList.remove('quick');
    }, 650);
  }

  close() {
    const wasGarage = this.openTab === 'garage';
    this.openTab = null;
    this.prestigeArmed = false;
    this.remoteBoard = null; // refetch live board next open
    this.panel?.remove();
    this.panel = null;
    document.body.classList.remove('panel-open');
    if (wasGarage) this.onGarage?.(false);
  }

  get isPanelOpen() { return this.openTab !== null; }

  private refreshPanel() {
    if (!this.panel || !this.openTab) return;
    const g = this.game;
    const rows: string[] = [`<div class="panel-head"><span class="panel-title">${this.openTab.toUpperCase()}</span><button class="x">✕</button></div>`];

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
        rows.push(`<div class="dash-grid-label">DASHBOARD · 6 FIXED MOUNTS</div>
          <div class="dash-slot-grid">${g.s.dashboardSlots.map((id, i) => {
            const item = id ? COSMETICS.find(c => c.id === id) : null;
            return `<div class="dash-slot${item ? ' occupied' : ''}" title="${item?.name ?? `Empty slot ${i + 1}`}">
              <span>${i + 1}</span><b>${item ? item.name.slice(0, 3).toUpperCase() : '—'}</b>
            </div>`;
          }).join('')}</div>`);
        for (const c of COSMETICS) {
          const owned = g.s.ownedCosmetics.includes(c.id);
          const equipped = c.slot === 'ornament' || c.slot === 'dash'
            ? g.s.dashboardSlots.includes(c.id)
            : g.s.equippedCosmetics[c.slot] === c.id;
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
        : API_URL ? ' · real Discipline accounts only' : ' · account server not connected'}</div>`);
      // Live worldwide data patches in when the authenticated fetch lands.
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
      if (!API_URL) rows.push(row('rename', `Username: ${g.s.username ?? '—'}`,
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
    } else if (this.openTab === 'settings') {
      const musicVol = Math.round(Number(localStorage.getItem('discipline-music-volume') ?? '1') * 100);
      const sfxVol = Math.round(Number(localStorage.getItem('discipline-sfx-volume') ?? '1') * 100);
      const fov = Number(localStorage.getItem('discipline-fov') ?? '100');
      const sensitivity = Number(localStorage.getItem('discipline-look-sensitivity') ?? '1.5');
      const vibration = localStorage.getItem('discipline-vibration') !== '0';
      const reduced = localStorage.getItem('discipline-reduced-motion') === '1';
      const textTier = Math.max(0, Math.min(3, this.game.s.textSizeTier ?? 0));
      rows.push(`<div class="panel-note">Audio and view settings save automatically on this device.</div>
        <div class="setting text-size-setting"><label><span class="setting-name">Universal text size</span><span class="setting-value text-size-val">${['SMALL', 'MEDIUM', 'LARGE', 'EXTRA LARGE'][textTier]}</span></label>
          <div class="text-size-choices" role="group" aria-label="Universal text size">${['S', 'M', 'L', 'XL'].map((label, tier) => `<button type="button" data-text-tier="${tier}" class="${tier === textTier ? 'selected' : ''}" aria-pressed="${tier === textTier}">${label}</button>`).join('')}</div>
        </div>
        <div class="setting"><label><span class="setting-name">Music</span><span class="setting-value music-val">${musicVol}%</span></label><input class="music-volume" type="range" min="0" max="100" value="${musicVol}"></div>
        <div class="setting"><label><span class="setting-name">Sound effects</span><span class="setting-value sfx-val">${sfxVol}%</span></label><input class="sfx-volume" type="range" min="0" max="100" value="${sfxVol}"></div>
        <div class="setting"><label><span class="setting-name">Field of view</span><span class="setting-value fov-val">${fov}%</span></label><input class="fov-setting" type="range" min="70" max="130" value="${fov}"></div>
        <div class="setting"><label><span class="setting-name">Look sensitivity</span><span class="setting-value sense-val">${sensitivity.toFixed(1)}×</span></label><input class="sense-setting" type="range" min="0.5" max="2" step="0.1" value="${sensitivity}"></div>
        <label class="setting-check"><input class="vibration-setting" type="checkbox" ${vibration ? 'checked' : ''}> Haptic feedback <span class="setting-hint">subtle taps · strong explosions</span></label>
        <label class="setting-check"><input class="motion-setting" type="checkbox" ${reduced ? 'checked' : ''}> Reduced motion</label>
        <button class="reset-view">RESET VIEW TO OPPONENT</button>
        <button class="ad-privacy">AD PRIVACY OPTIONS</button>
        <details class="cheat-vault"><summary>ENCRYPTED ACCESS</summary>
          <div class="panel-note">Owner codes are verified by one-way cryptographic hash.</div>
          <div class="cheat-entry"><input class="cheat-code" type="password" autocomplete="off" spellcheck="false" placeholder="ENTER OWNER CODE"><button class="cheat-submit">UNLOCK</button></div>
        </details>`);
      if (this.account?.signedIn) {
        rows.push(row('logout', `Account: ${this.account.username}`,
          'Progress is synced across devices.', 'LOG OUT', true, 'account'));
        rows.push(row('delete', 'Delete account',
          'Permanently erase this account and associated cloud data.', 'DELETE', true, 'account'));
      }
    }

    const collapsedGarage = this.openTab === 'garage' && !this.garageSheetOpen;
    // Keep the header/close (and GARAGE hide) controls outside the scrolling
    // content. Scrolling can no longer carry rows underneath those buttons.
    this.panel.innerHTML = collapsedGarage
      ? rows.join('')
      : `${rows[0]}<div class="panel-viewport"><div class="panel-scroll">${rows.slice(1).join('')}</div></div>`;
    this.scheduleTextFit(this.panel);
    this.panel.querySelector('.x')?.addEventListener('click', () => this.close());
    if (this.openTab === 'settings') this.bindSettings();
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

  private bindSettings() {
    if (!this.panel) return;
    const musicInput = this.panel.querySelector('.music-volume') as HTMLInputElement;
    const sfxInput = this.panel.querySelector('.sfx-volume') as HTMLInputElement;
    const fovInput = this.panel.querySelector('.fov-setting') as HTMLInputElement;
    const senseInput = this.panel.querySelector('.sense-setting') as HTMLInputElement;
    const vibration = this.panel.querySelector('.vibration-setting') as HTMLInputElement;
    const motion = this.panel.querySelector('.motion-setting') as HTMLInputElement;
    this.panel.querySelectorAll<HTMLButtonElement>('[data-text-tier]').forEach((button) => {
      button.addEventListener('click', (ev) => {
        ev.stopImmediatePropagation();
        this.game.s.textSizeTier = Number(button.dataset.textTier);
        this.game.save();
        this.applyTextSize();
        this.refreshPanel();
      });
    });
    const applyView = () => {
      localStorage.setItem('discipline-fov', fovInput.value);
      localStorage.setItem('discipline-look-sensitivity', senseInput.value);
      localStorage.setItem('discipline-reduced-motion', motion.checked ? '1' : '0');
      this.onViewSettings?.(Number(fovInput.value), Number(senseInput.value), motion.checked);
      (this.panel!.querySelector('.fov-val') as HTMLElement).textContent = `${fovInput.value}%`;
      (this.panel!.querySelector('.sense-val') as HTMLElement).textContent = `${Number(senseInput.value).toFixed(1)}×`;
    };
    musicInput.addEventListener('input', () => {
      music.setVolume(Number(musicInput.value) / 100);
      (this.panel!.querySelector('.music-val') as HTMLElement).textContent = `${musicInput.value}%`;
    });
    sfxInput.addEventListener('input', () => {
      sfx.setVolume(Number(sfxInput.value) / 100);
      (this.panel!.querySelector('.sfx-val') as HTMLElement).textContent = `${sfxInput.value}%`;
    });
    fovInput.addEventListener('input', applyView);
    senseInput.addEventListener('input', applyView);
    motion.addEventListener('change', applyView);
    vibration.addEventListener('change', () => localStorage.setItem('discipline-vibration', vibration.checked ? '1' : '0'));
    this.panel.querySelector('.reset-view')!.addEventListener('click', (ev) => {
      ev.stopImmediatePropagation(); this.onResetView?.(); this.toast('View reset.');
    });
    this.panel.querySelector('.ad-privacy')!.addEventListener('click', async (ev) => {
      ev.stopImmediatePropagation();
      const shown = await showAdPrivacyOptions();
      if (!shown) this.toast('Ad privacy options are unavailable on this build.');
    });
    this.panel.querySelector('.cheat-submit')!.addEventListener('click', async (ev) => {
      ev.stopImmediatePropagation();
      const input = this.panel!.querySelector('.cheat-code') as HTMLInputElement;
      const normalized = input.value.trim().toUpperCase();
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
      const digest = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (digest === 'bf0d3de7c4baafabe6d6143f61db643125b855c8a38b959c210509c6ac734674') {
        this.game.enableInfiniteCurrency();
        input.value = '';
        this.toast('OWNER MODE: infinite M and R enabled.', 'gold');
        this.refresh();
      } else {
        input.value = '';
        this.toast('Invalid owner code.');
      }
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
      if (g.s.ownedCosmetics.includes(id)) {
        if (!g.toggleCosmetic(id)) { this.toast('Dashboard full — unequip an item first.'); return; }
      }
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
    } else if (kind === 'account' && id === 'logout') {
      this.account?.logout();
      this.close();
      await this.promptAccount();
    } else if (kind === 'account' && id === 'delete') {
      this.close();
      await this.promptDeleteAccount();
    } else if (kind === 'booster') {
      this.close(); // starting an ad closes any open menu — no stacked overlays
      const ad = await this.showRewardedAd(15, 'boost');
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
