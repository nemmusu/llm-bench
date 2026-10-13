import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { AppError, toAppErrorData, type ErrorCode } from '../../contract/errors';

const STATUS: Partial<Record<ErrorCode, ContentfulStatusCode>> = {
  VALIDATION: 400,
  MODEL_NOT_FOUND: 404,
  HF_NOT_FOUND: 404,
  HF_AUTH_REQUIRED: 401,
  HF_GATED: 403,
  HF_RATE_LIMITED: 429,
  GITHUB_RATE_LIMITED: 429,
  CANCELLED: 409,
  RUN_NOT_FOUND: 404,
  DOWNLOAD_NOT_FOUND: 404,
  RUN_IN_PROGRESS: 409,
  // The machine is not ready for this request (yet): 503 tells the UI it is not a bug.
  GPU_NOT_FOUND: 503,
  DRIVER_MISSING: 503,
  DOCKER_NOT_INSTALLED: 503,
  DOCKER_NOT_RUNNING: 503,
  DOCKER_NOT_RESPONDING: 503,
  DOCKER_NO_GPU: 503,
  DOCKER_PERMISSION: 503,
  DOCKER_UNSUPPORTED: 503,
};

export function statusFor(code: ErrorCode): ContentfulStatusCode {
  return STATUS[code] ?? 500;
}

/** Converts any thrown value into the API error response `{ error: AppErrorData }`. */
export function errorResponse(c: Context, e: unknown): Response {
  if (e instanceof z.ZodError) {
    const err = new AppError('VALIDATION', 'Invalid request', { detail: z.prettifyError(e) });
    return c.json({ error: err.toJSON() }, 400);
  }
  const data = toAppErrorData(e);
  return c.json({ error: data }, statusFor(data.code));
}

/** Parses a JSON body with a zod schema; throws ZodError (→ 400) or AppError for bad JSON. */
export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError('VALIDATION', 'Body is not valid JSON');
  }
  return schema.parse(raw);
}
