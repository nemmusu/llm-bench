/**
 * The key answers of a "Trova le impostazioni migliori" run, as ready launch settings ("Preparati da LLM
 * Bench" on the Benchmark page and in "Avvia un server"; the tune result page can read the same):
 *
 *   'max-context'    the recommended combination: the largest context, the fastest there;
 *   'fastest-write'  the combination whose generation (decode) peaked, and the depth it peaked at;
 *   'fastest-read'   the same for reading the prompt (prefill: the engine's own rate when it reports one);
 *   'best-quality'   the most precise KV cache that loaded (f16 / bf16, else 8-bit, else 4-bit), at its
 *                    largest context (the fastest of those when several did).
 *
 * Each pick names its combination's exact launch params (what was measured: the depth of a peak is said,
 * the launch stays the combination's own). Picks of the same combination come as one, with every id.
 */
import type { LaunchParams } from './engines';
import { fullContextPoint, nominalDepth, type LatencyPoint, type TuneKvType, type Tuning } from './results';

export const TUNE_PICK_IDS = ['max-context', 'fastest-write', 'fastest-read', 'best-quality'] as const;
export type TunePickId = (typeof TUNE_PICK_IDS)[number];

export interface TunePick {
  /** What it answers (several when one combination is the answer to more than one question). */
  ids: TunePickId[];
  /** Index in Tuning.combinations. */
  combination: number;
  params: LaunchParams;
  kvType: TuneKvType;
  /** The combination's largest context (its launch). */
  maxContext: number;
  /** "Più utenti": the users at once and the context each one had (TuneCombination.perUserContext). */
  users?: number;
  perUserContext?: number;
  /** 'fastest-write' / 'fastest-read': the depth of the peak, and the speeds there (tokens/s). */
  depth?: number;
  decodeTps?: number;
  prefillTps?: number;
}

/** Precision rank of a KV type: 0 = full (f16, bf16, the model's own), 1 = 8-bit, 2 = mixed 8/4-bit, 3 = 4-bit or below (a fork's own turbo types too). */
export const KV_PRECISION: Readonly<Record<string, number>> = { f16: 0, bf16: 0, auto: 0, q8_0: 1, int8: 1, fp8: 1, k8v4: 2, rk8v4: 2, q4_0: 3, nvfp4: 3 };
const precisionOf = (kv: TuneKvType): number => KV_PRECISION[kv] ?? 3;

const prefillOf = (p: LatencyPoint): number => (p.prefillTpsEngine ?? p.prefillTps).median;

export function tunePicks(t: Tuning): TunePick[] {
  const ok = t.combinations.map((c, i) => ({ c, i })).filter(({ c }) => c.outcome === 'ok');
  if (ok.length === 0) return [];
  const picks: (Omit<TunePick, 'ids'> & { id: TunePickId })[] = [];
  // A "Più utenti" search measured its users at this level (the most that fit, or those asked).
  const users = t.multi ? (t.multi.fittingUsers ?? t.multi.users) : undefined;
  const base = (i: number) => {
    const c = t.combinations[i]!;
    const each = users !== undefined && c.perUserContext !== undefined ? { users, perUserContext: c.perUserContext } : {};
    return { combination: i, params: c.params, kvType: c.kvType, maxContext: c.maxContext, ...each };
  };
  if (t.recommended !== undefined && t.combinations[t.recommended]?.outcome === 'ok') {
    const full = fullContextPoint(t.combinations[t.recommended]!);
    picks.push({ id: 'max-context', ...base(t.recommended), ...(full ? { decodeTps: full.decodeTps.median, prefillTps: prefillOf(full) } : {}) });
  }
  const peak = (id: 'fastest-write' | 'fastest-read', speed: (p: LatencyPoint) => number) => {
    let best: { i: number; p: LatencyPoint } | undefined;
    for (const { c, i } of ok) for (const p of c.sweep) if (!best || speed(p) > speed(best.p)) best = { i, p };
    if (best) picks.push({ id, ...base(best.i), depth: nominalDepth(best.p.promptTokens), decodeTps: best.p.decodeTps.median, prefillTps: prefillOf(best.p) });
  };
  peak('fastest-write', (p) => p.decodeTps.median);
  peak('fastest-read', prefillOf);
  const quality = [...ok].sort((a, b) => {
    const rank = precisionOf(a.c.kvType) - precisionOf(b.c.kvType);
    if (rank !== 0) return rank;
    if (a.c.maxContext !== b.c.maxContext) return b.c.maxContext - a.c.maxContext;
    return (fullContextPoint(b.c)?.decodeTps.median ?? 0) - (fullContextPoint(a.c)?.decodeTps.median ?? 0);
  })[0]!;
  const qFull = fullContextPoint(quality.c);
  picks.push({ id: 'best-quality', ...base(quality.i), ...(qFull ? { decodeTps: qFull.decodeTps.median, prefillTps: prefillOf(qFull) } : {}) });
  // One entry per combination: the first answer's numbers, every answer's id.
  const out: TunePick[] = [];
  for (const { id, ...p } of picks) {
    const same = out.find((o) => o.combination === p.combination);
    if (same) same.ids.push(id);
    else out.push({ ids: [id], ...p });
  }
  return out;
}
