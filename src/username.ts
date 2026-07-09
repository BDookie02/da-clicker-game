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
export const RENAME_COST = 100_000;

export interface UsernameService {
  isTaken(name: string): Promise<boolean>;
  /** Atomic claim. Returns false if the name is already owned. */
  claim(name: string): Promise<boolean>;
  release(name: string): Promise<void>;
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
