// ---------------------------------------------------------------------------
// Unique username system.
//
// Rules: claimed at first launch (free), renames cost 100K Respect, and a
// name can never be registered twice — nobody can take yours.
//
// Uniqueness needs a shared database, so this sits behind UsernameService.
// The local provider enforces uniqueness against a device-local registry
// (plus all placeholder rival names) so the full flow is testable today.
// At launch, swap in a tiny API (e.g. Cloudflare Worker/KV or Firebase with
// the name as a unique document key) — claim() must be an atomic
// insert-if-absent on the server so two players can't race for one name.
// ---------------------------------------------------------------------------

export const USERNAME_RE = /^[A-Za-z0-9_]{3,14}$/;
export const RENAME_COST = 1_000_000;

const RESERVED_NAMES = new Set([
  'admin', 'administrator', 'mod', 'moderator', 'support', 'official',
  'developer', 'discipline', 'system', 'google', 'apple', 'admob',
]);
const BLOCKED_EXACT = new Set([
  'sex', 'anal', 'anus', 'balls', 'boobs', 'boob', 'ass', 'bitch', 'bastard',
  'suicide', 'murder', 'terrorist',
]);
// These roots are sufficiently unambiguous to catch separators, repeated
// letters, and basic leetspeak without rejecting ordinary names like Classy.
const BLOCKED_ROOTS = [
  'fuck', 'cunt', 'nigger', 'nigga', 'faggot', 'kike', 'chink', 'retard',
  'rapist', 'rape', 'porn', 'cock', 'dick', 'penis', 'vagina', 'pussy',
  'whore', 'slut', 'hitler', 'nazi',
];

function moderationKey(name: string): string {
  const leet: Record<string, string> = {
    '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g',
  };
  return name.toLowerCase().replace(/[01345789]/g, (ch) => leet[ch] ?? ch)
    .replace(/[^a-z]/g, '');
}

export function validateUsername(name: string): { ok: true } | { ok: false; error: string } {
  if (!USERNAME_RE.test(name)) return { ok: false, error: 'Username: 3-14 letters, numbers, or _' };
  const raw = name.toLowerCase();
  const key = moderationKey(name);
  const collapsed = key.replace(/(.)\1+/g, '$1');
  if (RESERVED_NAMES.has(raw) || RESERVED_NAMES.has(key) || RESERVED_NAMES.has(collapsed)) return { ok: false, error: 'That username is reserved.' };
  if (BLOCKED_EXACT.has(key) || BLOCKED_EXACT.has(collapsed)
      || BLOCKED_ROOTS.some((root) => key.includes(root) || collapsed.includes(root)))
    return { ok: false, error: 'That username is not allowed.' };
  return { ok: true };
}

export interface UsernameService {
  isTaken(name: string): Promise<boolean>;
  /** Atomic claim. Returns false if the name is already owned. */
  claim(name: string): Promise<boolean>;
  release(name: string): Promise<void>;
}

/** Real registry: server/worker.js — claims are atomic (UNIQUE constraint). */
export class RemoteUsernameService implements UsernameService {
  constructor(private apiUrl: string, private currentName: () => string | null) {}

  async isTaken(name: string): Promise<boolean> {
    // claim() is the source of truth; a cheap pre-check isn't worth a race
    void name;
    return false;
  }

  async claim(name: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, old: this.currentName() ?? undefined }),
      });
      return res.ok;
    } catch { return false; } // offline: keep the modal open, player retries
  }

  async release(): Promise<void> { /* handled server-side by claim(old) */ }
}

const REGISTRY_KEY = 'discipline-username-registry';

export class LocalUsernameService implements UsernameService {
  constructor(private reserved: string[] = []) {}

  private registry(): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem(REGISTRY_KEY) ?? '[]'));
    } catch { return new Set(); }
  }

  private write(s: Set<string>) {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify([...s]));
  }

  async isTaken(name: string): Promise<boolean> {
    const key = name.toLowerCase();
    return this.reserved.some(r => r.toLowerCase() === key) || this.registry().has(key);
  }

  async claim(name: string): Promise<boolean> {
    if (!validateUsername(name).ok) return false;
    if (await this.isTaken(name)) return false;
    const reg = this.registry();
    reg.add(name.toLowerCase());
    this.write(reg);
    return true;
  }

  async release(name: string): Promise<void> {
    const reg = this.registry();
    reg.delete(name.toLowerCase());
    this.write(reg);
  }
}
