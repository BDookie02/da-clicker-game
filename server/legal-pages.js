const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const readText = (env, name) => typeof env?.[name] === 'string'
  ? env[name].trim()
  : '';

export const legalConfig = (env = {}) => {
  const publisherName = readText(env, 'LEGAL_PUBLISHER_NAME');
  const contactCandidate = readText(env, 'LEGAL_CONTACT_EMAIL');
  const effectiveCandidate = readText(env, 'LEGAL_EFFECTIVE_DATE');
  const retentionNotice = readText(env, 'LEGAL_RETENTION_NOTICE');
  const targetAudienceNotice = readText(env, 'LEGAL_TARGET_AUDIENCE_NOTICE');

  const contactEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactCandidate)
    ? contactCandidate
    : '';
  const effectiveTimestamp = Date.parse(`${effectiveCandidate}T00:00:00Z`);
  const effectiveDate = /^\d{4}-\d{2}-\d{2}$/.test(effectiveCandidate)
    && Number.isFinite(effectiveTimestamp)
    && new Date(effectiveTimestamp).toISOString().slice(0, 10) === effectiveCandidate
    ? effectiveCandidate
    : '';

  const missing = [];
  if (!publisherName) missing.push('LEGAL_PUBLISHER_NAME');
  if (!contactEmail) missing.push('LEGAL_CONTACT_EMAIL (valid email required)');
  if (!effectiveDate) missing.push('LEGAL_EFFECTIVE_DATE (YYYY-MM-DD required)');
  if (!retentionNotice) missing.push('LEGAL_RETENTION_NOTICE');
  if (!targetAudienceNotice) missing.push('LEGAL_TARGET_AUDIENCE_NOTICE');

  return {
    publisherName,
    contactEmail,
    effectiveDate,
    retentionNotice,
    targetAudienceNotice,
    missing,
    ready: missing.length === 0,
  };
};

const legalStatus = (config) => config.ready
  ? `<p class="muted">Published by ${escapeHtml(config.publisherName)} · Effective ${escapeHtml(config.effectiveDate)}</p>`
  : `<section class="launch-blocker" role="alert"><h2>Not launch-ready</h2>
<p>This legal page has not been finalized by the publisher. It must not be used as the production Play listing policy yet.</p>
<p><b>Missing or invalid server configuration:</b> ${config.missing.map(escapeHtml).join(', ')}</p></section>`;

const contactSection = (config) => config.contactEmail
  ? `<section><h2>Contact</h2><p>For privacy, support, or moderation questions, email <a href="mailto:${escapeHtml(config.contactEmail)}">${escapeHtml(config.contactEmail)}</a>.</p></section>`
  : `<section class="launch-blocker"><h2>Contact not configured</h2><p>The publisher must configure a monitored, non-public privacy and support contact before release.</p></section>`;

const shell = (title, body, script = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · DISCIPLINE.</title><style>
body{margin:0;background:#0a0a12;color:#e8e8f0;font:16px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}main{width:min(760px,calc(100% - 32px));margin:40px auto 80px}h1,h2{color:#ffd890}h1{letter-spacing:.08em}a{color:#ff9b57}section{margin:28px 0;padding:18px;border:1px solid #3a3a55;background:#11111c}label{display:block;margin:14px 0 5px}input{box-sizing:border-box;width:100%;padding:12px;background:#090910;color:#fff;border:2px solid #4a4a70;font:inherit}button{margin-top:18px;padding:12px 18px;border:2px solid #d94b4b;background:#3a1118;color:#ffb0b0;font:bold 15px inherit}button:disabled{opacity:.45}.muted{color:#a0a0b8}.status{min-height:28px;margin-top:14px}.danger,.launch-blocker{color:#ffb0b0}.launch-blocker{border-color:#d94b4b;background:#2b0e14}
</style></head><body><main>${body}</main>${script}</body></html>`;

// The optional env argument is deliberately backwards-compatible with the
// existing renderer interface. The Worker must pass its env object before a
// production deployment; rendering without it exposes a visible launch block.
export const privacyPage = (env = {}) => {
  const config = legalConfig(env);
  return shell('Privacy Policy', `
<h1>DISCIPLINE. Privacy Policy</h1>${legalStatus(config)}
<p>This policy explains how DISCIPLINE. handles information when you use the game and its account service.</p>
<section><h2>Information processed</h2><ul>
<li><b>Account information:</b> your chosen username, a salted password hash, an internal account identifier, and hashed session tokens. DISCIPLINE. does not request an email address, legal name, or payment-card number when creating a game account.</li>
<li><b>Game and app activity:</b> cloud-save progress, settings stored in the save, inventory, purchases granted to the account, and total physical taps used for leaderboards.</li>
<li><b>Community safety:</b> the accepted Terms version and time, private hide relationships, submitted report reasons and explanations, report status, and moderator notes.</li>
<li><b>Purchase history:</b> product identifiers, platform transaction identifiers, purchase-token hashes, quantity, verification and consumption/delivery state, granted currency amounts, billing region, exact paid amount and currency when the store provides it, standard/test/promo/rewarded purchase classification, financial/order status, and refund/void evidence. These records verify purchases, reconcile refunds, calculate account spending without treating test, promo, or rewarded transactions as real spending, and prevent duplicate grants. Google Play or Apple processes the payment itself.</li>
<li><b>Advertising and diagnostics:</b> Google Mobile Ads may process IP-derived approximate location, app interactions, diagnostic/performance information, advertising data, and device or account identifiers for advertising, analytics, and fraud prevention. The account service records signed rewarded-ad transaction identifiers and reward types to prevent duplicate or spoofed grants.</li>
</ul></section>
<section><h2>How information is used</h2><p>Information is used to authenticate accounts, synchronize progress across devices, restore verified purchases, operate leaderboards, review reports, enforce moderation decisions, prevent fraud and duplicate grants, provide rewarded ads, diagnose failures, and maintain the game.</p></section>
<section><h2>Public leaderboard and community safety</h2><p>Your chosen username and all-time tap score are visible to other players on the public leaderboard after you accept the current Terms. Other signed-in players can report a username or score and can hide an account from their own leaderboard. Reports, their selected reason, and any optional explanation are stored for operator review. Hiding is private and is not shown to the hidden player.</p></section>
<section><h2>Sharing and service providers</h2><p>Account and gameplay data is processed by the DISCIPLINE. account service and its infrastructure provider. Purchase verification uses Google Play or Apple. Rewarded advertising uses Google Mobile Ads. Public leaderboard viewers receive public usernames, tap totals, and ranks. Advertising and platform providers process data under their own terms and available privacy controls.</p></section>
<section><h2>Security</h2><p>The production app is intended to use encrypted network connections. Passwords are stored as salted PBKDF2 hashes; session and purchase tokens are stored as hashes where supported. These measures reduce risk, but no system can guarantee absolute security. Production encryption must be verified against the exact release build and deployed endpoints before publication.</p></section>
<section><h2>Retention</h2><p>Primary DISCIPLINE. account data remains while the account exists. Account deletion removes the username, Terms/profile state, cloud save, leaderboard score, reports involving the account, private hide relationships, sessions, rewarded-ad ledger, and DISCIPLINE. purchase ledger from the primary account database.</p>
${config.retentionNotice
    ? `<p>${escapeHtml(config.retentionNotice)}</p>`
    : '<p class="danger"><b>Not finalized:</b> retention for infrastructure logs, backups, fraud/security records, and legal obligations has not been configured. This policy is not ready for publication.</p>'}</section>
<section id="deletion"><h2>Your choices and deletion</h2><p>You can revisit advertising privacy choices from Settings. A signed-in player can choose <b>Settings &gt; Delete account</b>. You may also use the <a href="/account-deletion">web account-deletion page</a> if the app is no longer installed. Platform transaction or advertising records controlled by Google or Apple are not deleted by deleting a DISCIPLINE. account.</p></section>
<section><h2>Age eligibility and target audience</h2>${config.targetAudienceNotice
    ? `<p>${escapeHtml(config.targetAudienceNotice)}</p>`
    : '<p class="danger"><b>Not finalized:</b> the publisher has not configured an age-eligibility and target-audience statement consistent with the Play Console selection, content rating, and ad treatment. No age threshold is asserted by this draft.</p>'}</section>
${contactSection(config)}`);
};

export const termsPage = (version, env = {}) => {
  const config = legalConfig(env);
  return shell('Terms', `
<h1>DISCIPLINE. Terms</h1><p class="muted">Version ${escapeHtml(version)}</p>${legalStatus(config)}
<p>These Terms govern use of the DISCIPLINE. game account, cloud save, and public leaderboard.</p>
<section><h2>Account and access</h2><p>Use a unique password and do not share account access. A username is public. You are responsible for activity performed through your account. You may delete the account and its primary game-service data from Settings or the public account-deletion page.</p></section>
<section><h2>Leaderboard conduct</h2><p>Do not use a username or leaderboard activity to harass, impersonate, threaten, promote hate, evade enforcement, or submit manipulated scores. Do not attempt to interfere with the service, other accounts, purchases, ads, or ranking integrity.</p></section>
<section><h2>Reports, hides, and moderation</h2><p>Players can report leaderboard accounts and hide them from their own view. Reports may be reviewed and accounts may be removed from the public leaderboard when necessary to protect players or ranking integrity. Knowingly false or abusive reports may also result in action.</p></section>
<section><h2>Purchases and rewarded ads</h2><p>Platform purchases are processed by the applicable store and remain subject to that store's terms. Currency or rewards are granted only after successful platform or signed-ad verification. Closing an ad early, being offline, or failing verification does not grant a reward.</p></section>
<section><h2>Availability and changes</h2><p>The game and online services may change, experience interruptions, or be discontinued. If these Terms materially change, an existing player must review and accept the new version before participating in the public leaderboard again; ordinary offline play and locally stored progress remain available.</p></section>
${contactSection(config)}
<p><a href="/privacy">Privacy Policy</a> · <a href="/account-deletion">Account deletion</a></p>`);
};

export const deletionPage = (env = {}) => {
  const config = legalConfig(env);
  return shell('Delete Account', `
<h1>Delete a DISCIPLINE. account</h1>${legalStatus(config)}
<p>This page works even after the game has been uninstalled. Enter the same username and password used in the game.</p>
<section><h2 class="danger">Permanent deletion</h2><p>Deletion erases the account username, Terms/profile state, cloud progress, leaderboard score, reports involving the account, private hide relationships, inventory, sessions, rewarded-ad ledger, and DISCIPLINE. purchase ledger from the primary account database. It cannot be undone. Google Play or Apple may retain their own transaction records.</p>
<form id="delete-form"><label for="username">Username</label><input id="username" autocomplete="username" maxlength="14" required>
<label for="password">Password</label><input id="password" type="password" autocomplete="current-password" minlength="10" required>
<label for="confirm">Type DELETE</label><input id="confirm" autocomplete="off" required>
<button id="delete-button" type="submit" disabled>DELETE ACCOUNT</button><div class="status" id="status" aria-live="polite"></div></form></section>
${contactSection(config)}
<p><a href="/privacy">Read the DISCIPLINE. Privacy Policy</a></p>`, `<script>
const form=document.getElementById('delete-form'),confirmInput=document.getElementById('confirm'),button=document.getElementById('delete-button'),status=document.getElementById('status');
confirmInput.addEventListener('input',()=>{button.disabled=confirmInput.value.trim().toUpperCase()!=='DELETE'});
form.addEventListener('submit',async(event)=>{event.preventDefault();if(confirmInput.value.trim().toUpperCase()!=='DELETE')return;button.disabled=true;status.textContent='Verifying account...';try{const login=await fetch('/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('username').value.trim(),password:document.getElementById('password').value})});const auth=await login.json();if(!login.ok)throw new Error('Username or password is incorrect.');status.textContent='Deleting account and associated data...';const removed=await fetch('/v1/account',{method:'DELETE',headers:{Authorization:'Bearer '+auth.token}});if(!removed.ok)throw new Error('Deletion failed. Please try again.');form.remove();status.textContent='Account deleted. Your DISCIPLINE. cloud data has been erased.'}catch(error){status.textContent=error.message||'Deletion failed. Please try again.';button.disabled=false}});
</script>`);
};
