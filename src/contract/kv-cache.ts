/**
 * KV cache types: llama.cpp's own (-ctk / -ctv), the ones llama.cpp forks add, vLLM / SGLang's and
 * NInfer's. One place for what each costs in memory (bits per stored value) and how precise it is,
 * for the VRAM estimate, the search of "Trova le impostazioni migliori" and the forms.
 *
 * Forks: a build lists its -ctk values in `--help` ("allowed values: f32, f16, …, turbo3, turbo4");
 * LLM Bench reads that list (core/engines/llamacpp-native/caps.ts), so any fork's types can be chosen.
 * Types whose size is known below are also searched by the tuner and estimated exactly; any other one
 * is estimated as f16 (the safe side: never says it fits when it would not).
 */
/** A -ctk / -ctv value (also vLLM's and NInfer's): a short word, it becomes a command-line argument ("turbo1.5"). */
export const KV_CACHE_TYPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

/** The -ctk values of upstream llama.cpp (its --help: "allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1"). */
export const LLAMA_KV_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'] as const;

/** The types LLM Bench offers on any llama.cpp build, most precise first. */
export const LLAMA_KV_CHOICES = ['f16', 'q8_0', 'q4_0'] as const;

/**
 * Bits per stored value of llama.cpp's types: ggml's block sizes (q8_0: 32 values in 34 bytes = 8.5
 * bits; q4_0 and iq4_nl: 18 bytes = 4.5; q4_1: 20 = 5; q5_0: 22 = 5.5; q5_1: 24 = 6).
 */
const LLAMA_BITS: Readonly<Record<string, number>> = { f32: 32, f16: 16, bf16: 16, q8_0: 8.5, q5_1: 6, q5_0: 5.5, q4_1: 5, q4_0: 4.5, iq4_nl: 4.5 };

/**
 * Bits per stored value of the types llama.cpp forks add, as their own documentation gives them.
 * TurboQuant forks (craftogrammer/llama.cpp-adaptive-turboquant and the turboquant forks it builds on,
 * README as of October 2026; method: Zandieh et al., "TurboQuant", 2025): turbo4 4.25, turbo3 3.125,
 * turbo2 2.125, turbo1.5 2.0; turbo3_tcq (trellis-coded turbo3) stores the same 3 bits and scale as
 * turbo3, so its size is taken as turbo3's (approximate).
 */
export const FORK_KV_BITS: Readonly<Record<string, number>> = { turbo4: 4.25, turbo3: 3.125, turbo3_tcq: 3.125, turbo2: 2.125, 'turbo1.5': 2 };

/** Bits per stored value of a llama.cpp (or fork) KV type; undefined = not known (estimated as f16). */
export function llamaKvBits(type: string): number | undefined {
  return LLAMA_BITS[type] ?? FORK_KV_BITS[type];
}

/** A cache LLM Bench knows the size of (llama.cpp's own and the forks' listed above). */
export function knownKvType(type: string): boolean {
  return llamaKvBits(type) !== undefined;
}

/** Full-precision llama.cpp caches; every other type is quantized and runs only with flash attention. */
export function isFullPrecisionKv(type: string): boolean {
  return type === 'f32' || type === 'f16' || type === 'bf16';
}

/** The types a build lists that upstream llama.cpp does not have (a fork's own), in the build's order. */
export function forkKvTypes(listed: readonly string[] | undefined): string[] {
  const upstream = new Set<string>(LLAMA_KV_TYPES);
  return [...new Set(listed ?? [])].filter((t) => !upstream.has(t) && KV_CACHE_TYPE.test(t));
}

/**
 * The KV cache choices of a form for this build: f16, q8_0, q4_0, then the fork's own types by size
 * (the larger first; unknown sizes last, in the build's order).
 */
export function llamaKvChoices(listed: readonly string[] | undefined): string[] {
  return [...LLAMA_KV_CHOICES, ...bySize(forkKvTypes(listed))];
}

/** Larger caches first; equal sizes and unknown ones keep their order (unknown ones last). */
function bySize(types: readonly string[]): string[] {
  const bits = (t: string) => llamaKvBits(t) ?? -1;
  return types.map((t, i) => ({ t, i })).sort((a, b) => bits(b.t) - bits(a.t) || a.i - b.i).map((x) => x.t);
}

/** How many of a fork's own types "Veloce" adds to the search: the most compact ones. */
export const FAST_FORK_KV = 2;

/**
 * The KV types "Trova le impostazioni migliori" tries with llama.cpp, most precise first: f16, q8_0,
 * q4_0, and the fork's own types the build lists whose size is known, each placed by its size (between
 * q8_0 and q4_0, or after q4_0). "Veloce" adds only the {@link FAST_FORK_KV} most compact of them,
 * "Accurata" (and "Ricontrollo rapido") all. A type of unknown size is never searched (the search
 * predicts each type's largest context from its size). `budget` is a TuneBudget, spelled out so this
 * file imports nothing.
 */
export function llamaKvLadder(budget: 'fast' | 'thorough' | 'recheck', listed?: readonly string[]): string[] {
  const own = bySize(forkKvTypes(listed).filter(knownKvType));
  const extra = budget === 'fast' ? own.slice(-FAST_FORK_KV) : own;
  return bySize([...LLAMA_KV_CHOICES, ...extra]);
}

/** Precision ranks of the types that are not llama.cpp's (vLLM, NInfer): 0 = full, 1 = 8-bit, 1.5 = K 8-bit V 4-bit, 2 = 4-bit. */
const OTHER_PRECISION: Readonly<Record<string, number>> = { auto: 0, fp8: 1, int8: 1, k8v4: 1.5, rk8v4: 1.5, nvfp4: 2 };

/**
 * How precise a KV cache is, 0 = full precision, larger = more compressed (ties of the tuner's ranking
 * go to the smaller number). llama.cpp and fork types follow their size: f16 0, q8_0 1, q4_0 2, then a
 * quarter point for every bit less (turbo3 ≈ 2.3, turbo2 ≈ 2.6); between q8_0 and q4_0 in proportion.
 * vLLM / NInfer: auto and bf16 0, fp8 and int8 1, k8v4 1.5, nvfp4 2. A type of unknown size: 2.
 */
export function kvPrecision(kv: string): number {
  const other = OTHER_PRECISION[kv];
  if (other !== undefined) return other;
  const bits = llamaKvBits(kv);
  if (bits === undefined) return 2;
  if (bits >= 16) return 0;
  // f16 → q8_0: 0 → 1; q8_0 → q4_0: 1 → 2; below q4_0 the same slope (a quarter point per bit).
  if (bits >= 8.5) return (16 - bits) / 7.5;
  return 1 + (8.5 - bits) / 4;
}
