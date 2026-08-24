import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const ui = readFileSync(new URL('../src/ui.ts', import.meta.url), 'utf8');
const account = readFileSync(new URL('../src/account.ts', import.meta.url), 'utf8');

test('multiplayer connection failures stop idle loops but every nonterminal state recovers', () => {
  assert.match(ui,
    /if \(this\.multiplayerAccountId !== this\.account\.accountId\) \{[\s\S]*?this\.multiplayerAccountId = this\.account\.accountId;[\s\S]*?this\.multiplayerLoadError = '';/,
    'the first attempted load must bind the account ID before a failure refreshes the panel');
  assert.match(ui,
    /!this\.multiplayer && !this\.multiplayerLoading && !this\.multiplayerLoadError/,
    'a failed initial request must not be restarted by each panel render');
  assert.match(ui, /if \(!this\.multiplayer\) return;/,
    'polling must stop when no multiplayer state has ever loaded');
  assert.match(ui, /const invited = this\.multiplayer\.matches\.some\(match => match\.status === 'invited'\);/);
  assert.match(ui, /const mustRecover = active \|\| invited \|\| this\.multiplayerMutationPending;/,
    'outgoing/incoming invites and uncertain mutations must recover, not only active matches');
  assert.match(ui, /if \(this\.multiplayerLoadError && !mustRecover\) return;/,
    'only truly idle panel failures may stay manually retryable');
  assert.match(ui, /const recoveryDelay = Math\.min\(3000, 300 \* \(2 \*\* Math\.min\(this\.multiplayerPollFailures, 4\)\)\);/,
    'active matches must use bounded recovery backoff after a transient failure');
  assert.match(ui, /this\.multiplayerLoadError \? recoveryDelay : waitingForDraw \? 200 : active \? 500 : 3000/,
    'active polling must continue after a transient failure instead of freezing the match');
  assert.match(ui, /class="multiplayer-retry"/,
    'a visible manual retry must remain available');
  assert.doesNotMatch(ui,
    /catch \(error\) \{\s*if \(this\.openTab === 'multiplayer'\) this\.toast\(multiplayerError\(error\)\);\s*\}/,
    'background connection failures must not produce repeated toasts');
  assert.match(account, /const MULTIPLAYER_REQUEST_TIMEOUT_MS = 3000;/);
  assert.match(account, /const PVP_TAP_REQUEST_TIMEOUT_MS = 900;/);
  assert.match(account,
    /submitPvPTaps[\s\S]*?\{ count \}, PVP_TAP_REQUEST_TIMEOUT_MS\)/,
    'tap uploads must not inherit the timeout that consumes the whole server grace');
  assert.match(account, /signal: controller\.signal/);
  assert.match(account, /finally \{\s*window\.clearTimeout\(timeout\);\s*\}/,
    'a hung fetch must abort and release the multiplayer loading guard');
  assert.match(ui, /clock\.textContent = 'RECONNECTING…';[\s\S]*?zone\.classList\.add\('waiting'\);/,
    'a failed Quick Draw poll must visibly wait for authoritative DRAW timing');
});

test('a successful or network-uncertain mutation keeps recovery armed until state is confirmed', () => {
  assert.match(ui,
    /this\.multiplayerMutationPending = true;[\s\S]*?await action\(\);[\s\S]*?error\.message !== 'multiplayer_unavailable'[\s\S]*?await this\.loadMultiplayerState\(true\);/,
    'accept/start response loss must enter state reconciliation');
  assert.match(ui,
    /this\.multiplayer = state;[\s\S]*?this\.multiplayerMutationPending = false;/,
    'only a successful authoritative GET may clear mutation uncertainty');
});

test('multiplayer polling preserves an in-progress friend code and its focus', () => {
  assert.match(ui, /private multiplayerFriendCodeDraft = '';/);
  assert.match(ui,
    /if \(previousFriendInput\) this\.multiplayerFriendCodeDraft = previousFriendInput\.value\.slice\(0, 9\);/,
    'a poll-triggered render must capture the live value before replacing the input');
  assert.match(ui, /value="\$\{escapeAttr\(this\.multiplayerFriendCodeDraft\)\}"/,
    'the replacement input must retain the captured friend code');
  assert.match(ui,
    /friendInput\?\.addEventListener\('input', \(\) => \{\s*this\.multiplayerFriendCodeDraft = friendInput\.value\.slice\(0, 9\);/,
    'every physical keystroke must update persistent draft state');
  assert.match(ui,
    /if \(friendInputWasFocused\) \{[\s\S]*?nextFriendInput\.focus\(\{ preventScroll: true \}\);[\s\S]*?nextFriendInput\.setSelectionRange/,
    'a background poll must restore focus and caret instead of dismissing mobile typing');
  assert.match(ui,
    /await this\.account!\.requestFriend\(code\);\s*this\.multiplayerFriendCodeDraft = '';/,
    'the code must clear only after the server accepts the request');
  assert.match(ui,
    /this\.multiplayerFriendCodeDraft = '';\s*const currentInput = this\.panel\?\.querySelector<HTMLInputElement>\('\.friend-code-input'\);\s*if \(currentInput\) currentInput\.value = '';/,
    'the live replacement input must also clear so the next poll cannot restore a stale submitted code');
});

test('multiplayer uses a friend-first battle flow instead of one crowded settings screen', () => {
  assert.match(ui, /private multiplayerView: 'friends' \| 'add_friend' \| 'challenge' = 'friends';/);
  assert.match(ui, /data-pvp-select-friend=/,
    'the social screen must choose one friend before showing battle setup');
  assert.match(ui,
    /this\.multiplayerSelectedFriendCode = button\.dataset\.pvpSelectFriend!;[\s\S]*?this\.multiplayerView = 'challenge';/);
  assert.match(ui, /FRIENDLY BATTLE[\s\S]*?Choose how you want to battle/,
    'battle setup must become a focused second step');
  assert.match(ui, /data-pvp-send=/,
    'the challenge must have one explicit final send action');
  assert.match(ui, /BATTLE INVITES[\s\S]*?data-pvp-decline=[\s\S]*?data-pvp-accept=/,
    'incoming challenges must remain visible cards with both choices');
  assert.match(ui, /this\.multiplayerMode === 'tap'[\s\S]*?\[30, 60, 90\]/,
    'duration choices must appear only for Tap Battle');
  assert.match(ui, /class="pvp-play-again">PLAY AGAIN/,
    'a completed friendly battle must offer a one-step rematch');
  assert.match(ui,
    /invitePvP\(match\.opponentCode, match\.mode,[\s\S]*?match\.mode === 'tap' \? match\.durationSeconds : 0\)/,
    'Play Again must preserve the exact opponent, mode, and Tap duration');
  assert.doesNotMatch(ui, /CHALLENGE SETTINGS/,
    'the old settings-wall presentation must not return');
});

test('referral connection failures stop automatic retries and remain manually retryable', () => {
  assert.match(ui,
    /if \(this\.referralAccountId !== this\.account\.accountId\) \{[\s\S]*?this\.referralAccountId = this\.account\.accountId;[\s\S]*?this\.referralLoadError = '';/);
  assert.match(ui, /!this\.referral && !this\.referralLoading && !this\.referralLoadError/);
  assert.match(ui, /class="referral-retry"/);
  assert.match(ui, /this\.referralLoadError = 'Referral status is unavailable/);
});

test('tap phase retries a failed final cumulative score without flooding or affecting Quick Draw', () => {
  assert.match(ui, /const PVP_TAP_SYNC_INTERVAL_MS = 1000;/,
    'cumulative tap snapshots must be coalesced to at most one normal upload per second');
  assert.match(ui,
    /this\.pvpTapSendTimer = window\.setTimeout\(send, PVP_TAP_SYNC_INTERVAL_MS\);/);
  assert.doesNotMatch(ui, /window\.setTimeout\(send, 140\)/,
    'the old per-140ms D1 write cadence must not return');
  assert.match(ui, /if \(this\.pvpTapFinalPhaseKey === phaseKey\) return;/);
  assert.match(ui, /\.then\(\(\) => \{[\s\S]*?this\.pvpTapFinalPhaseKey = phaseKey;/,
    'the phase is final only after the server accepts the cumulative upload');
  assert.match(ui, /this\.pvpTapFinalRetryAt = Date\.now\(\) \+ 300;/,
    'a failed final upload must remain retryable at a bounded cadence');
  assert.match(ui, /if \(this\.pvpTapSending\) \{[\s\S]*?this\.pvpTapQueuedMatchId = matchId;/);
  assert.match(ui, /this\.pvpTapQueuedFinal \|\|= immediate;/);
  assert.match(ui, /\.finally\(\(\) => \{[\s\S]*?this\.pvpTapSending = false;/);
  assert.match(ui, /if \(match\.phase === 'tap'\) this\.queuePvPTap\(match\.id, true\);/,
    'Quick Draw must never submit a tap-round score at phase close');
  assert.match(ui,
    /if \(immediate\) \{\s*window\.clearTimeout\(this\.pvpTapSendTimer\); send\(\);\s*\}/,
    'phase close must bypass the coalescing interval and flush the final cumulative score');
});

test('Quick Draw prefers authenticated server push and keeps REST state recovery', () => {
  assert.match(account,
    /quickDrawSocketTicket[\s\S]*?\/quick-draw\/ticket/);
  assert.match(account,
    /endpoint\.protocol = endpoint\.protocol === 'https:' \? 'wss:' : 'ws:'/);
  assert.match(ui,
    /message\?\.type === 'ping'[\s\S]*?\{ type: 'pong', id: message\.id \}/,
    'the client must answer server-measured pre-round pings');
  assert.match(ui,
    /message\?\.type === 'draw'[\s\S]*?this\.pvpDrawNonce = message\.nonce;[\s\S]*?this\.pvpDrawReady = true/,
    'only the server-pushed DRAW message may unlock the primary socket path');
  assert.match(ui,
    /\{ type: 'draw_response', nonce: this\.pvpDrawNonce \}/,
    'the response must echo the one-use round nonce');
  assert.match(ui,
    /!this\.pvpDrawReady \|\| Boolean\(this\.pvpDrawNonce\)/,
    'a REST-recovered DRAW must not send an empty nonce down an open socket');
  assert.match(ui,
    /this\.pvpDrawSocketRetryAt = Date\.now\(\)[\s\S]*?Math\.min\(3000, 300 \* \(2 \*\* Math\.min\(this\.pvpDrawSocketFailures - 1, 4\)\)\)/,
    'socket/ticket recovery must use bounded backoff rather than a 200 ms retry loop');
  assert.match(ui,
    /this\.account!\.submitQuickDraw\(match\.id\)/,
    'REST submission remains available when the socket cannot be established');
});

test('multiplayer UI distinguishes an eligible reward from a completed zero-reward win', () => {
  assert.match(ui, /An eligible win receives 5 Mentality/);
  assert.match(ui, /10 wins per 24 hours/);
  assert.match(ui, /one rewarded result with the same opponent per 24 hours/);
  assert.match(ui, /VICTORY — REWARD LIMIT REACHED/);
  assert.match(ui, /VICTORY — NO REWARD \(OPPONENT INACTIVE\)/);
  assert.match(ui, /match\.resultReason === 'incomplete_round'/);
  assert.match(ui, /The player who participated won by forfeit/);
  assert.doesNotMatch(ui, /Winner receives 5 Mentality/);
});
