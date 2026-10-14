/**
 * The Python environments LLM Bench creates with uv for vLLM and SGLang on Linux
 * (enginesDir/vllm-venv, enginesDir/sglang-venv): what is there, and their removal from the engine's card.
 * A Python environment of the user's own (Settings: vllmPath / sglangPath) is theirs: never removed.
 */
import { z } from 'zod';

export const NATIVE_ENV_KINDS = ['vllm-native', 'sglang-native'] as const;
export type NativeEnvKind = (typeof NATIVE_ENV_KINDS)[number];

export const nativeEnvPlanSchema = z.object({
  kind: z.enum(NATIVE_ENV_KINDS),
  /** Linux only (vLLM and SGLang have no Windows build). */
  supported: z.boolean(),
  /** LLM Bench's environment folder is there (also after an install that stopped half-way). */
  installed: z.boolean(),
  /** The folder the removal deletes, with everything in it (Python, the engine, PyTorch…). */
  folder: z.string(),
  /** What it holds on disk (0 when it is not there). */
  sizeBytes: z.number().nonnegative(),
  /** How many files it holds. */
  files: z.number().int().nonnegative(),
  /** The user's own Python environment chosen in Settings: theirs, never removed from here. */
  own: z.string().optional(),
  /** A benchmark, a server or an install of this engine is running: the removal is refused now. */
  busy: z.boolean(),
});
export type NativeEnvPlan = z.infer<typeof nativeEnvPlanSchema>;

/** GET (the plan) and DELETE (the removal) of an engine's environment. */
export const nativeEnvPath = (kind: NativeEnvKind): string => `/api/engines/${kind}/environment`;
