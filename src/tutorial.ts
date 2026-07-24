export interface TutorialHooks {
  finish: () => void;
  closePanel: () => void;
  eyeContactPoint?: () => { x: number; y: number } | null;
}

type Step = {
  text: string;
  target?: string;
  taps?: number;
  button?: string;
  after?: () => void;
};

/** First-launch, input-gated tour. Only the highlighted control is interactive. */
export class FirstLaunchTutorial {
  private index = 0;
  private tapCount = 0;
  private active = false;
  private overlay: HTMLElement | null = null;
  private focus: HTMLElement | null = null;
  private bubble: HTMLElement | null = null;
  private raf = 0;
  private bubbleObserver: ResizeObserver | null = null;
  private advanceQueued = false;
  private advanceTimer = 0;

  private readonly steps: Step[] = [
    { target: '#game-canvas', taps: 3, text: 'Eye contact. Tap driver 3x. Earn RESPECT.' },
    { target: '[data-tab="upgrades"]', text: 'UPGRADES spend Respect to make every manual tap stronger.' },
    { button: 'GOT IT', text: 'Buy the cheapest upgrade whenever you can. The quick-buy prompt also surfaces affordable power.' },
    { target: '[data-tab="crew"]', text: 'CREW spends Respect on automatic Respect per second.' },
    { button: 'NEXT', text: 'Upgrades reward active tapping; Crew keeps progress moving while you wait.' },
    { target: '[data-tab="garage"]', text: 'The GARAGE is where you inspect the car and equip cosmetic market items.' },
    { button: 'NEXT', text: 'Swipe to look around, tap the laptop for the market, and mount dashboard items in the six safe slots.', after: () => this.hooks.closePanel() },
    { target: '[data-tab="boosters"]', text: 'BOOSTERS use completed rewarded ads for temporary power—or let you earn M.' },
    { button: 'NEXT', text: 'Ads grant rewards only after completion. M buys cosmetics; booster rewards never add M.' },
    { target: '[data-tab="ranks"]', text: 'RANKS shows real players. Your raw physical taps—not idle earnings—set your score.' },
    { button: 'NEXT', text: 'A Discipline account protects your username, progress, inventory, and verified purchases across devices.' },
    { target: '#btn-settings', text: 'SETTINGS controls audio, FOV, look sensitivity, text size, motion, and haptics.' },
    { button: 'FINISH', text: 'That is the full loop: tap, upgrade, automate, customize, boost, and climb the ranks.' },
  ];

  constructor(private readonly hooks: TutorialHooks) {}

  get isActive() { return this.active; }

  start() {
    if (this.active) return;
    clearTimeout(this.advanceTimer);
    this.advanceTimer = 0;
    this.advanceQueued = false;
    this.index = 0;
    this.tapCount = 0;
    // A killed/restarted app can restore whichever panel was open. Every tour
    // run begins from the same unobstructed tap screen.
    this.hooks.closePanel();
    this.active = true;
    document.body.classList.add('tutorial-active');
    this.overlay = document.createElement('div');
    this.overlay.className = 'tutorial-layer';
    this.overlay.innerHTML = '<button class="tutorial-skip">SKIP TUTORIAL</button><div class="tutorial-focus"><span class="tutorial-arrow">▼</span></div><div class="tutorial-bubble"><div class="tutorial-step"></div><div class="tutorial-copy"></div><button class="tutorial-next"></button></div>';
    document.body.appendChild(this.overlay);
    this.focus = this.overlay.querySelector('.tutorial-focus');
    this.bubble = this.overlay.querySelector('.tutorial-bubble');
    // Text-tier changes, font loading, and narrow-screen wrapping can change
    // the callout after its first painted frame. Re-anchor it whenever that
    // happens so it can grow away from the required control, never over it.
    this.bubbleObserver = new ResizeObserver(() => this.queuePosition());
    this.bubbleObserver.observe(this.bubble!);
    this.overlay.querySelector('.tutorial-skip')!.addEventListener('click', (event) => {
      event.stopPropagation();
      this.end();
    });
    document.addEventListener('pointerdown', this.guard, true);
    document.addEventListener('pointerup', this.guard, true);
    document.addEventListener('click', this.guard, true);
    document.addEventListener('click', this.onClick, true);
    addEventListener('resize', this.position);
    this.render();
  }

  private readonly guard = (event: Event) => {
    if (!this.active) return;
    const target = event.target as HTMLElement;
    if (target.closest('.tutorial-skip, .tutorial-next')) return;
    const step = this.steps[this.index];
    const allowed = step.target === '#game-canvas'
      // #app is the transparent full-screen gesture surface above the WebGL
      // canvas. Accept only those two exact gameplay surfaces—never tutorial
      // copy or another descendant layered over them.
      ? target.matches('#game-canvas, #app')
      : step.target && target.closest(step.target);
    if (!allowed) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
  };

  /** Count only taps the game accepted after its eye-contact and transition
   * gates. Touching tutorial copy or a rejected canvas press can never satisfy
   * the first step. */
  recordSuccessfulTap() {
    if (!this.active) return;
    const step = this.steps[this.index];
    if (step.target !== '#game-canvas') return;
    this.tapCount += 1;
    if (this.tapCount < (step.taps ?? 1)) {
      this.updateCopy(`${step.text} (${this.tapCount}/${step.taps})`);
      return;
    }
    this.queueAdvance();
  }

  /** Observe allowed menu clicks during capture because the game intentionally
   * stops them from bubbling. The queued advance runs after its handler opens
   * the required panel. */
  private readonly onClick = (event: MouseEvent) => {
    if (!this.active) return;
    const step = this.steps[this.index];
    if (!step.target || step.target === '#game-canvas') return;
    const target = event.target as HTMLElement;
    if (target.closest(step.target)) this.queueAdvance();
  };

  private queueAdvance() {
    if (this.advanceQueued) return;
    this.advanceQueued = true;
    this.advanceTimer = window.setTimeout(() => {
      this.advanceTimer = 0;
      this.advanceQueued = false;
      if (this.active) this.advance();
    }, 0);
  }

  private render() {
    const step = this.steps[this.index];
    document.body.classList.toggle('tutorial-target-settings', step.target === '#btn-settings');
    this.tapCount = 0;
    this.updateCopy(step.text);
    const stepEl = this.overlay!.querySelector('.tutorial-step')!;
    stepEl.textContent = `QUICK START ${this.index + 1}/${this.steps.length}`;
    const next = this.overlay!.querySelector('.tutorial-next') as HTMLButtonElement;
    next.hidden = !step.button;
    next.textContent = step.button ?? '';
    next.onclick = step.button ? (event) => {
      event.stopPropagation(); event.preventDefault(); this.advance();
    } : null;
    this.focus!.hidden = !step.target;
    cancelAnimationFrame(this.raf);
    this.position();
    // Universal text sizing is applied by UI's mutation observer after this
    // DOM update. Re-measure on the next painted frame so the enlarged bubble
    // never grows back over the highlighted button.
    this.raf = requestAnimationFrame(this.position);
  }

  private queuePosition() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.position);
  }

  private updateCopy(text: string) {
    const copy = this.overlay?.querySelector('.tutorial-copy');
    if (copy) copy.textContent = text;
  }

  private readonly position = () => {
    if (!this.active) return;
    const step = this.steps[this.index];
    const target = step.target ? document.querySelector<HTMLElement>(step.target) : null;
    Object.assign(this.bubble!.style, { left: '18px', right: '18px', width: 'auto' });
    if (step.target && (!target || target.getBoundingClientRect().width < 1)) {
      this.raf = requestAnimationFrame(this.position); return;
    }
    if (target) {
      const r = target.getBoundingClientRect();
      const pad = step.target === '#game-canvas' ? 0 : 6;
      const shortLandscape = innerWidth > innerHeight;
      const box = step.target === '#game-canvas'
        ? (() => {
          // Project the real 3D face into this viewport. Opponent cars and
          // driver mounts vary, so a percentage-based windshield rectangle
          // can point above or beside the person the player must look at.
          const point = this.hooks.eyeContactPoint?.()
            ?? { x: innerWidth / 2, y: innerHeight * (shortLandscape ? .42 : .5) };
          const width = Math.min(150, Math.max(84, Math.min(innerWidth, innerHeight) * .26));
          const height = width * .9;
          return {
            left: Math.max(4, Math.min(innerWidth - width - 4, point.x - width / 2)),
            top: Math.max(4, Math.min(innerHeight - height - 4, point.y - height / 2)),
            width,
            height,
          };
        })()
        : { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
      Object.assign(this.focus!.style, {
        left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`,
      });
      // Constrain the callout to measured free space. A guessed minimum height
      // can overflow and cover the required control on short displays.
      // Keep a clear visual gutter without wasting the few pixels that short
      // landscape/compact screens need to show the entire callout.
      const compactNarrow = innerWidth <= 320;
      const gap = compactNarrow ? 4 : 10;
      const skip = this.overlay!.querySelector<HTMLElement>('.tutorial-skip')!.getBoundingClientRect();
      const safeTop = Math.max(8, skip.bottom + 8);
      const nav = document.querySelector<HTMLElement>('.menu-row');
      const navRect = nav?.getBoundingClientRect();
      const navVisible = nav && getComputedStyle(nav).display !== 'none' && navRect && navRect.height > 1;
      const safeBottom = navVisible ? navRect.top - (compactNarrow ? 8 : 12) : innerHeight - 8;
      // In a short landscape viewport the real face sits near vertical center,
      // leaving too little room above or below for accessible text. Put the
      // first callout beside the projected face, bounded by the rendered HUD
      // and navigation, instead of clipping or scrolling its instructions.
      if (shortLandscape && step.target === '#game-canvas') {
        const sideInset = 8;
        const sideGap = 10;
        const leftWidth = box.left - sideGap - sideInset;
        const rightStart = box.left + box.width + sideGap;
        const rightWidth = innerWidth - rightStart - sideInset;
        const useLeft = leftWidth >= 140 || leftWidth >= rightWidth;
        const sideWidth = useLeft ? leftWidth : rightWidth;
        if (sideWidth >= 120) {
          const hud = document.querySelector<HTMLElement>('.hud-top')?.getBoundingClientRect();
          const top = Math.max(8, (hud?.bottom ?? 0) + 6);
          Object.assign(this.bubble!.style, {
            left: `${useLeft ? sideInset : rightStart}px`,
            right: 'auto',
            width: `${sideWidth}px`,
            top: `${top}px`,
            bottom: 'auto',
            maxHeight: `${Math.max(24, safeBottom - top)}px`,
          });
          return;
        }
      }
      // The SKIP control is itself enlarged by the universal text tier. Start
      // below both the highlighted target and SKIP; otherwise a tall SKIP
      // button can cut across the upper-left of a settings callout.
      const belowStart = Math.max(box.top + box.height + gap, safeTop);
      const aboveEnd = box.top - gap;
      const below = Math.max(0, safeBottom - belowStart);
      const above = Math.max(0, aboveEnd - safeTop);
      // max-height uses border-box sizing while scrollHeight excludes borders.
      // Include them when deciding whether a callout fits, otherwise the last
      // line/button is clipped even though the arithmetic appears exact.
      const wanted = this.bubble!.scrollHeight + 4;
      if (below >= wanted || below >= above) {
        this.bubble!.style.maxHeight = `${Math.max(24, below)}px`;
        this.bubble!.style.top = `${belowStart}px`;
        this.bubble!.style.bottom = 'auto';
      } else {
        this.bubble!.style.maxHeight = `${Math.max(24, above)}px`;
        // Anchor the lower edge above the target/nav. If larger text wraps
        // later, the callout grows upward instead of covering the control.
        this.bubble!.style.top = 'auto';
        this.bubble!.style.bottom = `${Math.max(0, innerHeight - aboveEnd)}px`;
      }
    } else {
      this.bubble!.style.top = 'auto';
      this.bubble!.style.bottom = 'calc(var(--nav-height) + 12px)';
      this.bubble!.style.maxHeight = 'calc(100vh - var(--hud-bottom) - 40px)';
    }
  };

  private advance() {
    this.steps[this.index].after?.();
    // A top-level tutorial target opens a full menu. Close it before the next
    // explanation so menu rows, NEXT, and the next required target never
    // occupy the same visual lane on a compact screen.
    this.hooks.closePanel();
    this.index += 1;
    if (this.index >= this.steps.length) this.end();
    else this.render();
  }

  private end() {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.advanceTimer);
    this.advanceTimer = 0;
    this.advanceQueued = false;
    cancelAnimationFrame(this.raf);
    this.bubbleObserver?.disconnect();
    this.bubbleObserver = null;
    document.removeEventListener('pointerdown', this.guard, true);
    document.removeEventListener('pointerup', this.guard, true);
    document.removeEventListener('click', this.guard, true);
    document.removeEventListener('click', this.onClick, true);
    removeEventListener('resize', this.position);
    this.overlay?.remove();
    document.body.classList.remove('tutorial-active', 'tutorial-target-settings');
    this.overlay = this.focus = this.bubble = null;
    this.hooks.closePanel();
    this.hooks.finish();
  }
}
