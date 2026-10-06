import { randomBytes } from 'node:crypto';

/** Crockford base32 (no I, L, O, U), as in ULID. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID-style id: 10 chars of millisecond time + 16 random chars (80 bits). Sorts by creation time
 * as a string and never collides between PCs writing to the same shared results folder.
 */
export function newRunId(nowMs: number = Date.now(), random: (n: number) => Uint8Array = randomBytes): string {
  let t = Math.max(0, Math.floor(nowMs));
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(16);
  let rand = '';
  // 256 is a multiple of 32, so `byte % 32` stays uniform.
  for (let i = 0; i < 16; i++) rand += ALPHABET.charAt((bytes[i] ?? 0) % 32);
  return time + rand;
}

export function isRunId(s: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
}

/** Creation time encoded in a run id (ms since epoch), undefined for non-ULID ids. */
export function runIdTime(id: string): number | undefined {
  if (!isRunId(id)) return undefined;
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + ALPHABET.indexOf(ch);
  return t;
}
