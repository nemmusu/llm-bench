import { z } from 'zod';

export const ENGINE_KINDS = ['llamacpp-native', 'llamacpp-docker', 'vllm-docker', 'vllm-native', 'external'] as const;
export const engineKindSchema = z.enum(ENGINE_KINDS);
export type EngineKind = z.infer<typeof engineKindSchema>;

/** API flavour spoken by the server under test. */
export const apiFlavorSchema = z.enum(['llamacpp', 'vllm', 'openai']);
export type ApiFlavor = z.infer<typeof apiFlavorSchema>;

/**
 * User-facing launch parameters. Beginners never see most of these: defaults come from
 * the planner. `undefined` means "let GPU Bench decide".
 */
export const launchParamsSchema = z.object({
  contextSize: z.number().int().positive().optional(),
  gpuLayers: z.number().int().min(0).optional(),
  flashAttention: z.enum(['auto', 'on', 'off']).optional(),
  kvCacheType: z.enum(['f16', 'q8_0', 'q4_0', 'auto']).optional(),
  batchSize: z.number().int().positive().optional(),
  ubatchSize: z.number().int().positive().optional(),
  threads: z.number().int().positive().optional(),
  parallel: z.number().int().positive().optional(),
  /** vLLM only. */
  gpuMemoryUtilization: z.number().min(0.1).max(0.99).optional(),
  maxModelLen: z.number().int().positive().optional(),
  dtype: z.string().optional(),
  quantization: z.string().optional(),
  /** Extra raw CLI arguments appended verbatim (expert mode). */
  extraArgs: z.array(z.string()).default([]),
  /** Extra environment variables (expert mode). */
  env: z.record(z.string(), z.string()).default({}),
});
export type LaunchParams = z.infer<typeof launchParamsSchema>;

export const engineConfigSchema = z.object({
  kind: engineKindSchema,
  /** llamacpp-native: path to a custom llama-server executable; otherwise the managed build is used. */
  executable: z.string().optional(),
  /** llamacpp-native managed build tag, e.g. "b11438". */
  build: z.string().optional(),
  /** Docker engines: image reference, e.g. "vllm/vllm-openai:v0.12.0". */
  image: z.string().optional(),
  /** external: base URL of an OpenAI-compatible server. */
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  flavor: apiFlavorSchema.optional(),
  /** vllm-native: path to the `vllm` executable or venv. */
  vllmPath: z.string().optional(),
});
export type EngineConfig = z.infer<typeof engineConfigSchema>;

export const engineStatusSchema = z.object({
  kind: engineKindSchema,
  available: z.boolean(),
  installed: z.boolean(),
  version: z.string().optional(),
  variant: z.string().optional(),
  location: z.string().optional(),
  /** Why the engine cannot be used right now (error codes, see errors.ts). */
  problems: z.array(z.string()).default([]),
  supported: z.boolean().default(true),
});
export type EngineStatus = z.infer<typeof engineStatusSchema>;
