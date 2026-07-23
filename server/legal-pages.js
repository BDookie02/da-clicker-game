const shell = (title, body, script = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · DISCIPLINE.</title><style>
body{margin:0;background:#0a0a12;color:#e8e8f0;font:16px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}main{width:min(760px,calc(100% - 32px));margin:40px auto 80px}h1,h2{color:#ffd890}h1{letter-spacing:.08em}a{color:#ff9b57}section{margin:28px 0;padding:18px;border:1px solid #3a3a55;background:#11111c}label{display:block;margin:14px 0 5px}input{box-sizing:border-box;width:100%;padding:12px;background:#090910;color:#fff;border:2px solid #4a4a70;font:inherit}button{margin-top:18px;padding:12px 18px;border:2px solid #d94b4b;background:#3a1118;color:#ffb0b0;font:bold 15px inherit}button:disabled{opacity:.45}.muted{color:#a0a0b8}.status{min-height:28px;margin-top:14px}.danger{color:#ff9a9a}
</style></head><body><main>${body}</main>${script}</body></html>`;

export const privacyPage = () => shell('Privacy Policy', `
<h1>DISCIPLINE. Privacy Policy</h1><p class="muted">Effective July 22, 2026</p>
<p>This policy explains how DISCIPLINE. handles information when you use the game on Android, and how the same account system is intended to work on future supported platforms.</p>
<section><h2>Information processed</h2><ul>
<li><b>Account information:</b> your chosen username, a salted password hash, account identifier, and hashed session tokens. The service does not need your email address, legal name, or payment-card number.</li>
<li><b>Game and app activity:</b> cloud-save progress, settings stored in the save, inventory, purchases granted to the account, and total physical taps used for leaderboards.</li>
<li><b>Purchase history:</b> product identifiers, platform transaction identifiers, purchase-token hashes, and granted currency amounts used to verify purchases and prevent duplicate grants. Google Play or Apple processes the payment itself.</li>
<li><b>Advertising and diagnostics:</b> Google Mobile Ads may process IP-derived approximate location, app interactions, diagnostic/performance information, advertising data, and device or account identifiers for advertising, analytics, and fraud prevention. The account service records signed rewarded-ad transaction identifiers and reward types to prevent duplicate or spoofed grants.</li>
</ul></section>
<section><h2>How information is used</h2><p>Information is used to authenticate accounts, synchronize progress across devices, restore verified purchases, operate leaderboards, prevent fraud and duplicate grants, provide rewarded ads, diagnose failures, and maintain the game.</p></section>
<section><h2>Sharing and service providers</h2><p>Account and gameplay data is processed by the DISCIPLINE. account service and its infrastructure provider. Purchase verification uses Google Play or Apple. Rewarded advertising uses Google Mobile Ads. We do not directly sell your account or gameplay data. Advertising providers may process data under their own terms and the privacy choices available in the game.</p></section>
<section><h2>Security and retention</h2><p>Production traffic is encrypted in transit. Passwords are stored as salted PBKDF2 hashes; session and purchase tokens are stored as hashes where supported. Account data remains while the account exists. Account deletion removes the username, cloud save, leaderboard score, sessions, rewarded-ad ledger, and DISCIPLINE. purchase ledger. Platform transaction records retained by Google or Apple are controlled by those platforms.</p></section>
<section id="deletion"><h2>Your choices and deletion</h2><p>You can revisit advertising privacy choices from Settings. A signed-in player can choose <b>Settings → Delete account</b>. You may also use the <a href="/account-deletion">web account-deletion page</a> if the app is no longer installed.</p></section>
<section><h2>Children</h2><p>DISCIPLINE. is not directed to children under 13. Do not create an account if you are under the minimum age required in your country.</p></section>
<section><h2>Contact</h2><p>For privacy or support questions, use the public <a href="https://github.com/BDookie02/da-clicker-game/issues">DISCIPLINE. support page</a>.</p></section>`);

export const deletionPage = () => shell('Delete Account', `
<h1>Delete a DISCIPLINE. account</h1>
<p>This page works even after the game has been uninstalled. Enter the same username and password used in the game.</p>
<section><h2 class="danger">Permanent deletion</h2><p>Deletion erases the account username, cloud progress, leaderboard score, inventory, sessions, rewarded-ad ledger, and DISCIPLINE. purchase ledger. It cannot be undone. Google Play or Apple may retain their own transaction records.</p>
<form id="delete-form"><label for="username">Username</label><input id="username" autocomplete="username" maxlength="14" required>
<label for="password">Password</label><input id="password" type="password" autocomplete="current-password" minlength="10" required>
<label for="confirm">Type DELETE</label><input id="confirm" autocomplete="off" required>
<button id="delete-button" type="submit" disabled>DELETE ACCOUNT</button><div class="status" id="status" aria-live="polite"></div></form></section>
<p><a href="/privacy">Read the DISCIPLINE. Privacy Policy</a></p>`, `<script>
const form=document.getElementById('delete-form'),confirmInput=document.getElementById('confirm'),button=document.getElementById('delete-button'),status=document.getElementById('status');
confirmInput.addEventListener('input',()=>{button.disabled=confirmInput.value.trim().toUpperCase()!=='DELETE'});
form.addEventListener('submit',async(event)=>{event.preventDefault();if(confirmInput.value.trim().toUpperCase()!=='DELETE')return;button.disabled=true;status.textContent='Verifying account…';try{const login=await fetch('/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('username').value.trim(),password:document.getElementById('password').value})});const auth=await login.json();if(!login.ok)throw new Error('Username or password is incorrect.');status.textContent='Deleting account and associated data…';const removed=await fetch('/v1/account',{method:'DELETE',headers:{Authorization:'Bearer '+auth.token}});if(!removed.ok)throw new Error('Deletion failed. Please try again.');form.remove();status.textContent='Account deleted. Your DISCIPLINE. cloud data has been erased.'}catch(error){status.textContent=error.message||'Deletion failed. Please try again.';button.disabled=false}});
</script>`);
