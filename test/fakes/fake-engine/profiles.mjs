// Ready-made fake-engine profiles. A test selects one through the environment of the app/core:
//   FAKE_ENGINE_PROFILE = JSON.stringify(TUNE_PROFILE)
// (Playwright: launchApp({ env: { FAKE_ENGINE_PROFILE: JSON.stringify(TUNE_PROFILE) } }); the core's
// fake llama-server reads it at every launch.) FAKE_ENGINE_PROFILE can also be the path of a JSON file,
// read again at every launch: a test can change the "machine" between two runs (e.g. a slower engine
// build for "Ricontrollo rapido").

/**
 * "Trova le impostazioni migliori" against the seeded test model (a Qwen3-like GGUF trained on 40 960
 * tokens). Deterministic outcome of a 'fast' tune run with llama.cpp:
 *   - f16 holds 16K (32K and 40K run out of memory);
 *   - q8_0 holds 32K (40K spills to shared memory: loads, generation collapses → "spill");
 *   - q4_0 holds the whole 40K → the recommended combination;
 *   - -ub 2048 reads prompts ~1.6× faster than 512 and still fits → it wins the ubatch screening;
 *   - flash attention off (f16 only) slows down with depth → it loses;
 *   - generation slows down as the context fills (sweep curves go down).
 * VRAM need = 6000 + 600 × ctx/1K × (1 | 34/64 | 18/64) + 300 × ub/512 MiB, against 18 000 (+4 000 spill).
 * Fast enough for an E2E: loads in 0.3 s, a 40K prompt in ~0.2 s.
 */
export const TUNE_PROFILE = {
  loadMsCold: 400,
  loadMsWarm: 300,
  prefillTps: 200_000,
  decodeTps: 1500,
  tokensPerChunk: 4,
  memory: { totalMiB: 18_000, weightsMiB: 6000, kvMiBPer1k: 600, computeMiBPer512: 300, spillMiB: 4000 },
  speed: { depthSlowdown: 0.3, prefillDepthSlowdown: 0.5, faOffDepthFactor: 3, ubatchExponent: 0.35 },
};

/**
 * "Trova le impostazioni migliori" with a llama.cpp fork that has its own KV caches (turbo.mjs: its
 * --help lists turbo4, turbo3, turbo2, turbo1.5, turbo3_tcq), against the same seeded model (trained on
 * 40 960 tokens). The KV cache costs twice TUNE_PROFILE's, so upstream's types stop short:
 *   - f16 holds 8K, q8_0 16K, q4_0 32K (40K runs out of memory);
 *   - a fork type holds the whole 40K (turbo3: 6000 + 1200 × 40 × 3.125/16 + 300 = 15 675 MiB; turbo2
 *     13 575 MiB) → more context than q4_0.
 * VRAM need = 6000 + 1200 × ctx/1K × (bits per value / 16) + 300 × ub/512 MiB, against 18 000 (no spill:
 * over it, out of memory).
 */
export const TURBO_PROFILE = {
  ...TUNE_PROFILE,
  memory: { totalMiB: 18_000, weightsMiB: 6000, kvMiBPer1k: 1200, computeMiBPer512: 300 },
};

/**
 * "Più utenti" (tune.goal 'multi', users 4, perUserContext 8192 → llama-server -np 4 -c 32768) against
 * the same seeded model. Deterministic outcome of a 'fast' run with llama.cpp:
 *   - f16 does not hold 4 × 8K (6000 + 600 × 32 + 300 = 25 500 MiB > 18 000: out of memory);
 *   - q8_0 (16 500 MiB) and q4_0 (11 700 MiB) do;
 *   - the pool split per user (--no-kv-unified) generates 1.6× faster per user than the shared one
 *     (--kv-unified) → 'split' wins the layout screening;
 *   - --cache-reuse 256 changes nothing here (conversations re-send a plain prefix) → off is kept;
 *   - -ub 2048 reads the 8K prompts ~1.6× faster → lower TTFT p95 with 4 users waiting → it wins;
 *   - q4_0 generates at 0.7× the speed of q8_0 → q8_0, split, ub 2048 is the recommendation. (Not
 *     slower: under 0.4× of the reference's 1K probe a Windows launch counts as spilled, and the
 *     noise of a busy test machine must never get it there.)
 * Users 1…4 then run in this order on it; the conversations (4 × 3 messages) reuse each slot's cache.
 */
export const MULTI_PROFILE = {
  loadMsCold: 400,
  loadMsWarm: 300,
  // Reading 4 prompts of 8K one after the other dominates the time to first token: ubatch shows clearly.
  prefillTps: 50_000,
  decodeTps: 1500,
  tokensPerChunk: 4,
  memory: { totalMiB: 18_000, weightsMiB: 6000, kvMiBPer1k: 600, computeMiBPer512: 300 },
  speed: { depthSlowdown: 0.3, prefillDepthSlowdown: 0.5, ubatchExponent: 0.35, unifiedDecodeFactor: 0.6, kvDecodeFactor: { q4_0: 0.7 } },
};

/**
 * vLLM (`vllm serve`, Docker or native) for "Trova le impostazioni migliori", 'thorough':
 *   - 24 000 MiB card with 22 000 MiB free: --gpu-memory-utilization 0.95 is refused at start
 *     ("Free memory on device … less than desired GPU memory utilization"), 0.9 starts;
 *   - weights 15 000 MiB, 200 MiB of KV per 1K tokens (fp8: half): the pool at 0.9 holds ~25 900
 *     tokens (auto), ~51 800 (fp8);
 *   - capture sizes 1·2·4 instead of the default list free ~480 MiB more for the KV cache;
 *   - --block-size 32 generates 5 % faster than 16; fp8_e5m2 like fp8_e4m3 (a tie keeps e4m3);
 *   - /metrics exposes the prefix-cache counters (vllm:prefix_cache_queries_total / _hits_total).
 */
export const VLLM_TUNE_PROFILE = {
  loadMsCold: 400,
  loadMsWarm: 300,
  prefillTps: 100_000,
  decodeTps: 900,
  tokensPerChunk: 1,
  memory: { totalMiB: 24_000, freeMiB: 22_000, weightsMiB: 15_000, kvMiBPer1k: 200, computeMiBPer512: 0 },
  speed: { depthSlowdown: 0.2, ubatchExponent: 0.2, blockSizeDecodeFactor: { 32: 1.05 } },
  vllmHelp: 'all',
  vllmMetrics: 'counters',
};

/**
 * A Windows spill, as GPU Bench 0.3.0 met it on an RTX 5090 (a 27B Q4 model with -c 262144 -ngl all):
 * no error, the model loads, part of it goes to shared system memory and generation collapses to
 * 0.065× (3.5 against 53.7 tok/s; prompt reading 0.3×). Scaled to the spill test model of the E2E
 * (64 layers × 8 KV heads × 256 × 2 bytes: 256 KiB of KV per token, the VRAM estimate's own figure), on
 * a card with 31 000 MiB free:
 *   - the default context (Rapido: 1K) fits; up to ~118K it fits (so "Riprova con meno contesto" does);
 *   - 256K needs ~66 GB: it loads anyway and spills (spillMiB is "as much as Windows gives");
 *   - prompt reading slows with depth like the real card (1 810 → 875 tok/s from 1K to 256K).
 * Fast enough for an E2E: a Rapido that spills takes a few seconds.
 */
export const SPILL_PROFILE = {
  loadMsCold: 500,
  loadMsWarm: 400,
  prefillTps: 60_000,
  decodeTps: 1500,
  tokensPerChunk: 4,
  memory: { totalMiB: 31_000, weightsMiB: 300, kvMiBPer1k: 256, computeMiBPer512: 100, spillMiB: 1_000_000 },
  speed: { depthSlowdown: 0.125, prefillDepthSlowdown: 0.134, spillFactor: 0.065 },
};

/**
 * "Trova le impostazioni migliori" that runs out of time: TUNE_PROFILE, but every launch after the
 * first (the cold one: FAKE_ENGINE_COLD_MARKER) reads prompts at 1 500 tok/s instead of 200 000, so a
 * 16K prompt takes ~13 s. The search sets its time limit again with the first launch's speeds (fast:
 * the minimum, a minute), then its screenings run far slower than that: the limit ends it during the
 * first screenings and what was measured becomes combinations "misurate in parte". Generation stays as
 * fast (a slower one would read as a spill), and every request stays well within its deadline.
 */
export const TUNE_SLOW_PROFILE = { ...TUNE_PROFILE, warm: { prefillTps: 1500 } };

/**
 * "Trova le impostazioni migliori" meets the borderline spill of the bug report (RTX 5090 32 GB, a 27B
 * Q4 model, llama.cpp b11460, Veloce): f16 at 240K — the estimate rounded down to 8K — loads with the
 * card full but little shared memory (360 MiB: clean for the check after the load), then its first
 * request puts the compute buffers in shared memory (1 338 MiB) and never answers (99 % GPU, ~147 W).
 * Scaled to the E2E's test model (34 layers × 8 KV heads × 128: 136 KiB of f16 KV per token, so the
 * estimate puts f16 at ~244K on the fake 5090) with 31 000 MiB free:
 *   - f16 at 240K needs 33 040 MiB: it spills, borderline as above; 224K (30 864 MiB) fits;
 *   - q8_0 holds the whole 256K (18 896 MiB): q4_0 is not needed;
 *   - shared memory without a spill: 120 MiB + 1 MiB per 1K of context (124 at 4K, 360 at 240K), like the real card.
 * The per-process readings come from test/fakes/fake-nvidia-smi/fake-gpu-memory.mjs (GPUBENCH_GPU_MEMORY_MONITOR).
 * The search gives 240K up the moment the monitor reads 1 338 MiB, steps down and ends: f16 at 224K
 * ("Limite trovato: a 240K non entra più"), q8_0 at 256K.
 */
export const BORDERLINE_PROFILE = {
  loadMsCold: 400,
  loadMsWarm: 300,
  prefillTps: 400_000,
  decodeTps: 1500,
  tokensPerChunk: 4,
  spillStall: true,
  memory: {
    totalMiB: 31_000,
    weightsMiB: 300,
    kvMiBPer1k: 136,
    computeMiBPer512: 100,
    spillMiB: 1_000_000,
    sharedMiB: 120,
    sharedMiBPer1k: 1,
    spillShared: { loadMiB: 0, requestMiB: 978 },
  },
  speed: { depthSlowdown: 0.125, prefillDepthSlowdown: 0.134 },
};
