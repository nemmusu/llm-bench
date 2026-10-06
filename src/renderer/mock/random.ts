/** Small deterministic PRNG (mulberry32) so mock data and screenshots are stable run to run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value around `center` with ± `spread` uniform noise. */
export function jitter(rand: () => number, center: number, spread: number): number {
  return center + (rand() * 2 - 1) * spread;
}

export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
