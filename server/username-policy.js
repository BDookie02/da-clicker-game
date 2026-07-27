const USER_RE = /^[A-Za-z0-9_]{3,14}$/;
const RESERVED = new Set([
  'admin', 'administrator', 'mod', 'moderator', 'support', 'official',
  'developer', 'discipline', 'system', 'google', 'apple', 'admob',
]);
const BLOCKED_EXACT = new Set([
  'sex', 'anal', 'anus', 'balls', 'boobs', 'boob', 'ass', 'bitch', 'bastard',
  'suicide', 'murder', 'terrorist',
]);
const BLOCKED_ROOTS = [
  'fuck', 'cunt', 'nigger', 'nigga', 'faggot', 'kike', 'chink', 'retard',
  'rapist', 'rape', 'porn', 'cock', 'dick', 'penis', 'vagina', 'pussy',
  'whore', 'slut', 'hitler', 'nazi',
];

function key(name) {
  const leet = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g' };
  return name.toLowerCase().replace(/[01345789]/g, (ch) => leet[ch] || ch)
    .replace(/[^a-z]/g, '');
}

export function validateUsername(name) {
  if (typeof name !== 'string' || !USER_RE.test(name)) return 'invalid_username';
  const normalized = key(name);
  const collapsed = normalized.replace(/(.)\1+/g, '$1');
  if (RESERVED.has(name.toLowerCase()) || RESERVED.has(normalized) || RESERVED.has(collapsed)) return 'reserved_username';
  if (BLOCKED_EXACT.has(normalized) || BLOCKED_EXACT.has(collapsed)
      || BLOCKED_ROOTS.some((root) => normalized.includes(root) || collapsed.includes(root)))
    return 'inappropriate_username';
  return null;
}
