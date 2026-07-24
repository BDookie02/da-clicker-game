import { mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  connectAndroidWebView,
  numericOption,
  option,
  requireVisualAuditHandles,
  writeContactSheet,
  writeJson,
  writeLabeledPng,
} from './lib/android-visual-qa.mjs';

const root = resolve(import.meta.dirname, '..');
const port = numericOption('--port', 9222);
const output = resolve(root, option('--out', join('devlog', 'android-ugc-responsive-cdp')));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(output, { recursive: true });

const viewports = [
  { name: 'legacy-small', width: 280, height: 480 },
  { name: 'compact', width: 320, height: 568 },
  { name: 'standard', width: 360, height: 640 },
  { name: 'tall', width: 412, height: 915 },
  { name: 'short-landscape', width: 480, height: 280 },
  { name: 'landscape', width: 640, height: 360 },
  { name: 'tablet', width: 768, height: 1024 },
];
const scenarios = [
  { id: 'ranks-actions', scroll: 'top', required: ['FLAG', 'HIDE'] },
  { id: 'ranks-hidden', scroll: 'bottom', required: ['UNHIDE'] },
  { id: 'report-modal', scroll: 'top', required: ['CANCEL', 'SEND REPORT'] },
  { id: 'report-modal-bottom', scroll: 'bottom', required: ['CANCEL', 'SEND REPORT'] },
];

const reports = [];
const captures = [];
const failures = [];
let cdp = null;
let snapshotCreated = false;
let webview = null;

try {
  cdp = await connectAndroidWebView(port);
  webview = await requireVisualAuditHandles(cdp, [
    'ui.close',
    'ui.toggle',
    'ui.refreshPanel',
    'ui.applyTextSize',
  ]);
  await cdp.evaluate(`(() => {
    if (window.__disciplineUgcQaSnapshot)
      throw new Error('A UGC responsive-audit snapshot already exists');
    const ui = window.__ui;
    const game = window.__game;
    const account = ui.account || null;
    window.__disciplineUgcQaSnapshot = {
      storage: Object.entries(localStorage),
      game: JSON.parse(JSON.stringify(game.s)),
      account,
      cloudReadyAccountId: account?.cloudReadyAccountId ?? null,
      remoteBoard: ui.remoteBoard,
      bodyClass: document.body.className,
      bodyTextTier: document.body.dataset.textTier ?? null,
    };
    // The real five-second autosave closes over the original AccountService,
    // not ui.account. Pause its upload gate while synthetic layout state is on
    // screen so visual QA can never enter a cloud save.
    if (account) account.cloudReadyAccountId = '';
    const style = document.createElement('style');
    style.id = 'discipline-ugc-qa-style';
    style.textContent = [
      '.title-screen,.tutorial-layer,.fade,.toasts{display:none!important}',
      '.ad-overlay:not([data-visual-qa-owned="true"]){display:none!important}',
    ].join('');
    document.head.appendChild(style);
    window.__disciplineUgcQaAccount = {
      signedIn: true,
      username: 'VISUALQA',
      accountId: 'visual-qa-account',
      termsCurrent: true,
      termsVersion: 'visual-qa',
      reportPlayer: async () => true,
      blockPlayer: async () => undefined,
      unblockPlayer: async () => undefined,
      markTermsOutdated: () => undefined,
    };
    return true;
  })()`);
  snapshotCreated = true;

  for (const viewport of viewports) {
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      screenOrientation: {
        type: viewport.width > viewport.height ? 'landscapePrimary' : 'portraitPrimary',
        angle: viewport.width > viewport.height ? 90 : 0,
      },
    });
    await wait(180);

    for (let tier = 0; tier < 4; tier++) {
      for (const scenario of scenarios) {
        try {
          await cdp.evaluate(`(async () => {
            const ui = window.__ui;
            const game = window.__game;
            document.querySelectorAll('[data-visual-qa-owned="true"]').forEach(node => node.remove());
            ui.close();
            game.s.username = 'VISUALQA';
            game.s.textSizeTier = ${tier};
            ui.applyTextSize();
            ui.account = window.__disciplineUgcQaAccount;
            // Prevent the first ranks render from starting a real network
            // request. Patch in deterministic authenticated rows, then render
            // the real production panel and controls.
            ui.remoteBoardLoading = true;
            ui.toggle('ranks');
            ui.remoteBoard = {
              entries: [
                { rank: 1, name: 'VISUALQA', taps: 9876543, you: true },
                { rank: 2, name: 'TARGETPLAYER14', taps: 7654321, you: false,
                  playerRef: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
              ],
              blocked: [
                { name: 'HIDDENPLAYER14',
                  playerRef: 'cccccccccccccccccccccccccccccccc' },
              ],
              termsRequired: false,
            };
            ui.remoteBoardLoading = false;
            ui.refreshPanel();
            await new Promise(resolve => requestAnimationFrame(() =>
              requestAnimationFrame(resolve)));
            const scenario = ${JSON.stringify(scenario.id)};
            const scroll = document.querySelector('.panel-scroll');
            if (scroll) scroll.scrollTop =
              scenario === 'ranks-hidden' ? scroll.scrollHeight : 0;
            if (scenario.startsWith('report-modal')) {
              const flag = [...document.querySelectorAll('.lb-action')]
                .find(button => button.textContent.trim() === 'FLAG');
              if (!flag) throw new Error('FLAG control was not rendered');
              flag.click();
              await new Promise(resolve => requestAnimationFrame(() =>
                requestAnimationFrame(resolve)));
              const overlay = document.querySelector('.report-overlay');
              if (!overlay) throw new Error('Report modal did not open');
              overlay.dataset.visualQaOwned = 'true';
              const reportBox = overlay.querySelector('.ad-box');
              reportBox?.scrollTo?.(0,
                scenario === 'report-modal-bottom' ? reportBox.scrollHeight : 0);
            }
            await new Promise(resolve => setTimeout(resolve, 220));
            return true;
          })()`);

          const audit = await cdp.evaluate(`(() => {
            const scenario = ${JSON.stringify(scenario)};
            const scope = scenario.id.startsWith('report-modal')
              ? document.querySelector('.report-overlay')
              : document.querySelector('.panel');
            if (!scope) return { fatal: 'Expected audit scope is missing' };
            const rect = (element) => element.getBoundingClientRect();
            const intersects = (a, b, gap = 0) =>
              Math.min(a.right, b.right) - Math.max(a.left, b.left) > gap
              && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > gap;
            const intersection = (a, b) => {
              const left = Math.max(a.left, b.left);
              const top = Math.max(a.top, b.top);
              const right = Math.min(a.right, b.right);
              const bottom = Math.min(a.bottom, b.bottom);
              return right - left > 1 && bottom - top > 1
                ? { left, top, right, bottom, width: right - left, height: bottom - top }
                : null;
            };
            const rendered = (element) => {
              const style = getComputedStyle(element);
              const box = rect(element);
              return style.display !== 'none' && style.visibility !== 'hidden'
                && Number(style.opacity) !== 0 && box.width > 1 && box.height > 1;
            };
            const label = (element) => {
              const identity = element.id ? '#' + element.id
                : element.classList.length ? '.' + [...element.classList].join('.')
                  : element.tagName;
              return identity + ' ' + (element.textContent || element.value || '')
                .trim().replace(/\\s+/g, ' ').slice(0, 64);
            };
            const scrollableAncestor = (element) => {
              for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                if (/(auto|scroll)/.test(style.overflowY + style.overflowX)
                    && (parent.scrollHeight > parent.clientHeight + 1
                      || parent.scrollWidth > parent.clientWidth + 1)) return parent;
                if (parent === scope) break;
              }
              return null;
            };
            const visibleRect = (element) => {
              if (!rendered(element)) return null;
              let box = intersection(rect(element),
                { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
              if (!box) return null;
              for (let parent = element.parentElement; parent && parent !== document.body;
                parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                if (/(hidden|auto|scroll)/.test(style.overflowY + style.overflowX)) {
                  box = intersection(box, rect(parent));
                  if (!box) return null;
                }
              }
              return box;
            };
            const currentlyVisible = (element) => Boolean(visibleRect(element));
            const buttons = [...scope.querySelectorAll('button')].filter(rendered);
            const controls = [...scope.querySelectorAll('button,input,select,textarea')]
              .filter(rendered);
            const missingRequired = scenario.required.filter((text) =>
              !buttons.some((button) => button.textContent.trim() === text));

            const scopeBox = rect(scope);
            const outside = [];
            if (scopeBox.left < -1 || scopeBox.top < -1
                || scopeBox.right > innerWidth + 1 || scopeBox.bottom > innerHeight + 1)
              outside.push(label(scope));
            for (const control of controls) {
              const box = rect(control);
              const reachableByScroll = Boolean(scrollableAncestor(control));
              if (!reachableByScroll && (box.left < -1 || box.top < -1
                  || box.right > innerWidth + 1 || box.bottom > innerHeight + 1))
                outside.push(label(control));
            }

            const overlaps = [];
            const visibleControls = controls.filter(currentlyVisible);
            for (let i = 0; i < visibleControls.length; i++) {
              for (let j = i + 1; j < visibleControls.length; j++) {
                const first = visibleControls[i];
                const second = visibleControls[j];
                if (first.contains(second) || second.contains(first)) continue;
                const firstVisible = visibleRect(first);
                const secondVisible = visibleRect(second);
                if (firstVisible && secondVisible
                    && intersects(firstVisible, secondVisible, 2))
                  overlaps.push(label(first) + ' <> ' + label(second));
              }
            }
            const panel = document.querySelector('.panel');
            const nav = document.querySelector('.menu-row');
            const hud = document.querySelector('.hud-top');
            if (!scenario.id.startsWith('report-modal') && panel && nav && rendered(nav)) {
              if (intersects(rect(panel), rect(nav), 2)) overlaps.push('PANEL <> BOTTOM NAV');
              if (rect(nav).top - rect(panel).bottom < 8)
                overlaps.push('PANEL HAS LESS THAN 8PX NAV GUTTER');
            }
            if (!scenario.id.startsWith('report-modal') && panel && hud && rendered(hud)
                && intersects(rect(panel), rect(hud), 2)) overlaps.push('PANEL <> HUD');

            const clipped = [...scope.querySelectorAll(
              'button,select,textarea,.panel-head,.panel-note,.lb-rank,.lb-score,.lb-blocked-title,.ad-label,.name-copy,.report-label,.name-status',
            )].filter(rendered).filter((element) => {
              const style = getComputedStyle(element);
              return (element.scrollWidth > element.clientWidth + 2
                  && !/(auto|scroll)/.test(style.overflowX))
                || (element.scrollHeight > element.clientHeight + 2
                  && !/(auto|scroll)/.test(style.overflowY));
            }).map(label);

            const wrappedButtons = buttons.filter((button) => {
              const style = getComputedStyle(button);
              const range = document.createRange();
              range.selectNodeContents(button);
              const lines = new Set([...range.getClientRects()]
                .filter((box) => box.width > 0 && box.height > 0)
                .map((box) => Math.round(box.top * 2) / 2));
              return style.whiteSpace !== 'nowrap'
                || style.wordBreak === 'break-all'
                || lines.size > 1
                || button.scrollWidth > button.clientWidth + 1
                || button.scrollHeight > button.clientHeight + 1;
            }).map(label);

            const multiRowGroups = [...scope.querySelectorAll(
              '.lb-actions,.lb-blocked-row,.name-actions',
            )].filter(rendered).filter((group) => {
              const children = [...group.children].filter(rendered);
              if (children.length < 2) return false;
              const centers = children.map((child) => {
                const box = rect(child);
                return box.top + box.height / 2;
              });
              return Math.max(...centers) - Math.min(...centers) > 3;
            }).map(label);
            const multiRowLeaderboardRows = [...scope.querySelectorAll('.lb-row')]
              .filter(rendered)
              .filter((row) => getComputedStyle(row).gridTemplateRows.trim().split(/\\s+/).length > 1)
              .map(label);

            const occluded = visibleControls.filter((control) => {
              const box = visibleRect(control);
              if (!box) return false;
              const x = Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2));
              const y = Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2));
              const top = document.elementFromPoint(x, y);
              return !top || !(top === control || control.contains(top));
            }).map(label);

            const actionTexts = buttons.map((button) => button.textContent.trim())
              .filter((text) => ['FLAG', 'HIDE', 'UNHIDE', 'CANCEL', 'SEND REPORT'].includes(text));
            const reportFields = !scenario.id.startsWith('report-modal') || (
              Boolean(scope.querySelector('.report-reason'))
              && Boolean(scope.querySelector('.report-details'))
              && Boolean(scope.querySelector('.report-cancel'))
              && Boolean(scope.querySelector('.report-send'))
            );
            const panelOpaque = !panel
              || Number.parseFloat(getComputedStyle(panel).backgroundColor.split(',').slice(-1)[0]) >= 0.995
              || !getComputedStyle(panel).backgroundColor.startsWith('rgba');
            return {
              fatal: null,
              viewport: [innerWidth, innerHeight],
              scope: scopeBox.toJSON?.() || null,
              actionTexts,
              missingRequired,
              reportFields,
              outside: [...new Set(outside)],
              overlaps: [...new Set(overlaps)],
              clipped: [...new Set(clipped)],
              wrappedButtons: [...new Set(wrappedButtons)],
              multiRowGroups: [...new Set(multiRowGroups)],
              multiRowLeaderboardRows: [...new Set(multiRowLeaderboardRows)],
              occluded: [...new Set(occluded)],
              panelOpaque,
            };
          })()`);

          if (audit.fatal) throw new Error(audit.fatal);
          const failed = audit.missingRequired.length
            || !audit.reportFields
            || audit.outside.length
            || audit.overlaps.length
            || audit.clipped.length
            || audit.wrappedButtons.length
            || audit.multiRowGroups.length
            || audit.multiRowLeaderboardRows.length
            || audit.occluded.length
            || !audit.panelOpaque;

          const raw = await cdp.capture();
          const filename = `${viewport.name}-tier-${tier + 1}-${scenario.id}.png`;
          const file = join(output, filename);
          const image = await writeLabeledPng(raw, file,
            `${scenario.id.replaceAll('-', ' ').toUpperCase()} · TEXT TIER ${tier + 1}`,
            `${viewport.name} · ${viewport.width}×${viewport.height}`);
          reports.push({
            viewport,
            tier,
            scenario: scenario.id,
            ok: !failed,
            audit,
            file: basename(file),
            image,
          });
          captures.push({ viewport: viewport.name, tier, scenario: scenario.id, file });
          if (failed) failures.push({
            viewport: viewport.name,
            tier,
            scenario: scenario.id,
            audit,
          });
        } catch (error) {
          const failure = {
            viewport: viewport.name,
            tier,
            scenario: scenario.id,
            error: error.message,
          };
          failures.push(failure);
          reports.push({ ...failure, ok: false });
        }
      }
    }
  }
} catch (error) {
  failures.push({ stage: 'fatal', error: error.message });
} finally {
  if (cdp) {
    try { await cdp.call('Emulation.clearDeviceMetricsOverride'); }
    catch (error) { failures.push({ stage: 'metrics-restore', error: error.message }); }
  }
  if (cdp && snapshotCreated) {
    try {
      await cdp.evaluate(`(() => {
        const snapshot = window.__disciplineUgcQaSnapshot;
        if (!snapshot) return false;
        const ui = window.__ui;
        const game = window.__game;
        document.querySelectorAll('[data-visual-qa-owned="true"]').forEach(node => node.remove());
        ui.close();
        localStorage.clear();
        for (const [key, value] of snapshot.storage) localStorage.setItem(key, value);
        for (const key of Object.keys(game.s)) delete game.s[key];
        Object.assign(game.s, snapshot.game);
        ui.account = snapshot.account;
        ui.remoteBoard = snapshot.remoteBoard;
        if (snapshot.account)
          snapshot.account.cloudReadyAccountId = snapshot.cloudReadyAccountId ?? '';
        document.getElementById('discipline-ugc-qa-style')?.remove();
        document.body.className = snapshot.bodyClass;
        if (snapshot.bodyTextTier === null) delete document.body.dataset.textTier;
        else document.body.dataset.textTier = snapshot.bodyTextTier;
        delete window.__disciplineUgcQaAccount;
        delete window.__disciplineUgcQaSnapshot;
        // A reload rebuilds the exact persisted UI and removes every synthetic
        // object reference without changing the restored local save.
        setTimeout(() => location.reload(), 0);
        return true;
      })()`);
    } catch (error) {
      failures.push({ stage: 'state-restore', error: error.message });
    }
  }
  cdp?.close();
}

for (const scenario of scenarios) {
  const items = captures.filter((capture) => capture.scenario === scenario.id);
  if (items.length) {
    await writeContactSheet(items, join(output, `contact-sheet-${scenario.id}.png`), {
      columns: 4,
      tileWidth: 250,
      tileHeight: 420,
    });
  }
}

const expectedCases = viewports.length * 4 * scenarios.length;
if (reports.length !== expectedCases) {
  failures.push({
    stage: 'coverage',
    error: `Expected ${expectedCases} responsive cases, recorded ${reports.length}`,
  });
}
const audit = {
  generatedAt: new Date().toISOString(),
  tool: 'scripts/audit-android-ugc-responsive-cdp.mjs',
  invocation: `node scripts/audit-android-ugc-responsive-cdp.mjs --port ${port}`,
  output,
  webview,
  viewports,
  textTiers: [0, 1, 2, 3],
  scenarios,
  expectedCases,
  recordedCases: reports.length,
  restored: !failures.some((failure) =>
    failure.stage === 'metrics-restore' || failure.stage === 'state-restore'),
  cases: reports,
  failures,
};
writeJson(join(output, 'audit.json'), audit);
writeJson(join(output, 'failures.json'), failures);

console.log(JSON.stringify({
  cases: reports.length,
  expectedCases,
  failures: failures.length,
  output,
}));
if (failures.length) process.exitCode = 1;
