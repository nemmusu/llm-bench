import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ModelIdentity } from '../../contract/models';
import type { Metrics, Profile } from '../../contract/results';

/** resources/score-reference.json: the reference the score is calibrated against (RTX 5090 = 1000). */
export const scoreReferenceSchema = z.object({
  version: z.number().int(),
  provisional: z.boolean().default(true),
  referenceModel: z.object({ repo: z.string(), file: z.string(), sha256: z.string().optional() }),
  /** Decode tok/s, C=1, 512-token prompt. */
  D_ref: z.number().positive(),
  /** Prefill tok/s at a 4096-token prompt. */
  P_ref: z.number().positive(),
  /** Warm load, seconds. */
  L_ref: z.number().positive(),
});
export type ScoreReference = z.infer<typeof scoreReferenceSchema>;

/** Reads the bundled reference; undefined when missing or invalid (runs are then simply not scored). */
export async function loadScoreReference(resourcesDir: string): Promise<ScoreReference | undefined> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(path.join(resourcesDir, 'score-reference.json'), 'utf8'));
    const parsed = scoreReferenceSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export interface ScoreInputs {
  /** Decode tok/s at C=1 with a 512-token prompt. */
  D: number;
  /** Prefill tok/s at 4096 tokens (or the largest prompt measured). */
  P: number;
  /** Warm load seconds. */
  L: number;
}

/** score = 1000 × (D/Dref)^0.5 × (P/Pref)^0.3 × (Lref/L)^0.2, rounded to an integer. */
export function computeScore(x: ScoreInputs, ref: ScoreReference): number {
  return Math.round(1000 * (x.D / ref.D_ref) ** 0.5 * (x.P / ref.P_ref) ** 0.3 * (ref.L_ref / x.L) ** 0.2);
}

const lower = (s: string | undefined): string | undefined => s?.toLowerCase();

/** sha256 when both sides know it, else the file name (and repo when known). */
export function isReferenceModel(model: ModelIdentity, ref: ScoreReference): boolean {
  const want = ref.referenceModel;
  if (want.sha256 && model.sha256) return lower(want.sha256) === lower(model.sha256);
  if (!model.file || lower(path.basename(model.file)) !== lower(want.file)) return false;
  return model.repo === undefined || lower(model.repo) === lower(want.repo);
}

/**
 * Score inputs from a run's metrics. Prefill uses the client-side rate (P/TTFT), measured the same
 * way on every engine, so scores stay comparable across engines.
 */
export function scoreInputs(metrics: Pick<Metrics, 'latency' | 'load'>): ScoreInputs | undefined {
  const d = metrics.latency.find((p) => p.promptTokens === 512)?.decodeTps.median;
  const largest = [...metrics.latency].sort((a, b) => b.promptTokens - a.promptTokens)[0];
  const p = (metrics.latency.find((x) => x.promptTokens === 4096) ?? largest)?.prefillTps.median;
  const warm = metrics.load.warmMs?.median;
  const positive = (v: number | undefined): v is number => v !== undefined && v > 0;
  if (!positive(d) || !positive(p) || !positive(warm)) return undefined;
  return { D: d, P: p, L: warm / 1000 };
}

/** Score of a run: only the standard profile on the reference model gets one. */
export function scoreRun(
  run: { profile: Profile; model: ModelIdentity; metrics: Pick<Metrics, 'latency' | 'load'> },
  ref: ScoreReference | undefined,
): { value: number; referenceVersion: number } | undefined {
  if (!ref || run.profile !== 'standard' || !isReferenceModel(run.model, ref)) return undefined;
  const inputs = scoreInputs(run.metrics);
  return inputs ? { value: computeScore(inputs, ref), referenceVersion: ref.version } : undefined;
}

/** (a − b) / b, e.g. 0.23 for "+23% vs b"; undefined when b is 0 or a value is not finite. */
export function relativeDelta(a: number, b: number): number | undefined {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return undefined;
  return (a - b) / b;
}
