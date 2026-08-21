import { Capacitor, registerPlugin } from '@capacitor/core';
import type { AccountService, ReferralEvidence } from './account';

interface InstallReferrerResult {
  installReferrer: string;
  clickTimestamp: number;
  installTimestamp: number;
  installVersion: string;
}

const InstallReferrer = registerPlugin<{ get(): Promise<InstallReferrerResult> }>(
  'DisciplineInstallReferrer',
);
const processedKey = (accountId: string) => `discipline-referral-processed-v1:${accountId}`;

export async function claimInstallReferral(account: AccountService): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android' || !account.accountId)
    return false;
  const key = processedKey(account.accountId);
  if (localStorage.getItem(key) === '1') return false;
  let evidence: InstallReferrerResult;
  try { evidence = await InstallReferrer.get(); }
  catch { return false; }
  const params = new URLSearchParams(evidence.installReferrer || '');
  const code = (params.get('discipline_ref') || '').trim().toUpperCase();
  if (!/^[A-F0-9]{10}$/.test(code)) {
    localStorage.setItem(key, '1');
    return false;
  }
  const payload: ReferralEvidence = {
    code,
    platform: 'android',
    installReferrer: evidence.installReferrer,
    clickTimestamp: Number(evidence.clickTimestamp),
    installTimestamp: Number(evidence.installTimestamp),
    installVersion: String(evidence.installVersion || ''),
  };
  await account.claimReferral(payload);
  localStorage.setItem(key, '1');
  return true;
}

export async function shareReferral(url: string, code: string): Promise<void> {
  const text = `Try DISCIPLINE. on Google Play. Install with my verified referral link to unlock a random shop item for me. Referral code: ${code}.`;
  if (navigator.share) {
    await navigator.share({ title: 'DISCIPLINE.', text, url });
    return;
  }
  await navigator.clipboard.writeText(`${text}\n${url}`);
}
