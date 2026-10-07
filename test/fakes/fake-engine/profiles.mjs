// Ready-made fake-engine profiles. A test selects one through the environment of the app/core:
//   FAKE_ENGINE_PROFILE = JSON.stringify(TUNE_PROFILE)
// (Playwright: launchApp({ env: { FAKE_ENGINE_PROFILE: JSON.stringify(TUNE_PROFILE) } }); the core's
// fake llama-server reads it at every launch.)

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
