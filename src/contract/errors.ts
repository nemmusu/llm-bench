import { z } from 'zod';

/**
 * Every failure the user can see has one of these codes. The renderer maps each
 * code to a human message and a "what to do" action in both languages
 * (`satisfies Record<ErrorCode, …>` keeps the catalog exhaustive).
 */
export const ERROR_CODES = [
  'INTERNAL',
  'VALIDATION',
  'CANCELLED',
  'NETWORK',
  'DISK_FULL',
  'GPU_NOT_FOUND',
  'DRIVER_MISSING',
  'DRIVER_TOO_OLD',
  'VRAM_BUSY',
  'ENGINE_NOT_INSTALLED',
  'ENGINE_INSTALL_FAILED',
  'ENGINE_START_FAILED',
  'ENGINE_EXITED',
  'ENGINE_TIMEOUT',
  'ENGINE_OOM',
  'ENGINE_NO_KERNEL_IMAGE',
  'ENGINE_BAD_FLAG',
  'ENGINE_PORT_IN_USE',
  'ENDPOINT_UNREACHABLE',
  'ENDPOINT_INVALID',
  'MODEL_NOT_FOUND',
  'MODEL_TOO_LARGE',
  'MODEL_INVALID',
  'HF_AUTH_REQUIRED',
  'HF_GATED',
  'HF_RATE_LIMITED',
  'HF_NOT_FOUND',
  'DOWNLOAD_FAILED',
  'DOWNLOAD_CHECKSUM',
  'DOCKER_NOT_INSTALLED',
  'DOCKER_NOT_RUNNING',
  /** Docker Desktop is there but its engine does not answer: "Riavvia Docker" (params reason: needs-deep, restart-failed, no-desktop-cli…). */
  'DOCKER_NOT_RESPONDING',
  'DOCKER_NO_GPU',
  'DOCKER_PERMISSION',
  'DOCKER_UNSUPPORTED',
  'DOCKER_PULL_FAILED',
  /** An image a container still uses cannot be removed; params image, reason: 'running' (a server or a test) | 'container' (a stopped container). */
  'DOCKER_IMAGE_IN_USE',
  /** An engine cannot be removed while a benchmark, a server or a build uses the engines; params engine (its name). */
  'ENGINE_IN_USE',
  'GITHUB_RATE_LIMITED',
  'RUN_NOT_FOUND',
  'RUN_IN_PROGRESS',
  'DOWNLOAD_NOT_FOUND',
  'DOCKER_INSTALL_FAILED',
  'DOCKER_VOLUME_FAILED',
  'ENGINE_MISSING_LIBRARY',
  'ENGINE_UPDATE_FAILED',
  /** The engine runs on one GPU model only (NInfer: an RTX 5090); params engine, gpu. */
  'ENGINE_GPU_UNSUPPORTED',
  /**
   * This build of the engine cannot read this model, on every launch: a weight layout or format it
   * does not know (NInfer "unknown tensor layout: gguf_blocks_v1"), an older or newer container
   * (.ninfer v2), an architecture it does not know (llama.cpp "unknown model architecture", vLLM /
   * SGLang "architectures … are not supported"). Params: engine (its name), reason ('layout' | 'format'
   * | 'container' | 'architecture'), value, build (commit / version, when known), template and variant
   * (a built-in custom-engine template that reads it, e.g. 'ninfer-all' / "NInfer-all"), command (NInfer's
   * own upgrade tool for an older container).
   */
  'ENGINE_MODEL_UNSUPPORTED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = z.enum(ERROR_CODES);

export const appErrorSchema = z.object({
  code: errorCodeSchema,
  /** Technical message (English), shown under "Dettagli" for experts. */
  message: z.string(),
  /** Free-form values interpolated into the localized message (e.g. pid, sizes). */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  detail: z.string().optional(),
});
export type AppErrorData = z.infer<typeof appErrorSchema>;

/** Error class used inside the core; serialized as {@link AppErrorData} over the API. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly params: Record<string, string | number | boolean> | undefined;
  readonly detail: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { params?: Record<string, string | number | boolean>; detail?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.params = opts.params;
    this.detail = opts.detail;
  }

  toJSON(): AppErrorData {
    const out: AppErrorData = { code: this.code, message: this.message };
    if (this.params) out.params = this.params;
    if (this.detail) out.detail = this.detail;
    return out;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Normalizes anything thrown into AppErrorData. */
export function toAppErrorData(e: unknown): AppErrorData {
  if (isAppError(e)) return e.toJSON();
  if (e instanceof Error) {
    if (e.name === 'AbortError') return { code: 'CANCELLED', message: e.message };
    return { code: 'INTERNAL', message: e.message };
  }
  return { code: 'INTERNAL', message: String(e) };
}
