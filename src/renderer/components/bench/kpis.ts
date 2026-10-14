/** The headline numbers of a run, picked once for the result page, the compare page and the exports. */
import { contextTokensOf, fullContextPoint, promptsCalibrated, type ConcurrencyPoint, type LatencyPoint, type RunResult, type Stat, type TuneCombination } from '../../../contract/results';
import { recommendedIndex } from '../tune/tune-logic';
import { headlinePoint, peakConcurrency, prefillStat, vramFigure, type VramFigure } from './format';

/** Average words per token (Italian/English prose) used for the plain-language sentence. */
export const WORDS_PER_TOKEN = 0.7;
/** Typical silent reading speed: ~240 words per minute. */
export const READING_WORDS_PER_SEC = 4;

export interface Kpis {
  promptTokens?: number;
  decode?: Stat;
  /** Engine-reported prefill when available (more precise), else client-side. */
  prefill?: Stat;
  ttft?: Stat;
  coldMs?: Stat;
  warmMs?: Stat;
  coldReadBytesPerSec?: number;
  vram?: VramFigure;
  vramEstimateMiB?: number;
  tokensPerJoule?: number;
  avgPowerW?: number;
  concurrency?: ConcurrencyPoint;
  score?: number;
  /** Generation speed in words per second, for the plain-language sentence. */
  wordsPerSec?: number;
}

/** `notes`: a run of calibrated text prompts says the tokens the engine counted (contextTokensOf). */
export function kpisOf(run: Pick<RunResult, 'metrics'> & { notes?: RunResult['notes'] }): Kpis {
  const m = run.metrics;
  const p = headlinePoint(m.latency);
  const vram = vramFigure(m.vram);
  const conc = peakConcurrency(run);
  const out: Kpis = {};
  if (p) {
    out.promptTokens = contextTokensOf(p, promptsCalibrated(run));
    out.decode = p.decodeTps;
    out.prefill = prefillStat(p);
    out.ttft = p.ttftMs;
    out.wordsPerSec = p.decodeTps.median * WORDS_PER_TOKEN;
  }
  if (m.load.coldMs) out.coldMs = m.load.coldMs;
  if (m.load.warmMs) out.warmMs = m.load.warmMs;
  if (m.load.coldReadBytesPerSec !== undefined) out.coldReadBytesPerSec = m.load.coldReadBytesPerSec;
  if (vram) out.vram = vram;
  if (m.vram.estimateMiB !== undefined) out.vramEstimateMiB = m.vram.estimateMiB;
  if (m.energy.tokensPerJoule !== undefined) out.tokensPerJoule = m.energy.tokensPerJoule;
  if (m.energy.avgPowerW !== undefined) out.avgPowerW = m.energy.avgPowerW;
  if (conc) out.concurrency = conc;
  if (m.score) out.score = m.score.value;
  return out;
}

/** The headline of a one-user "Trova le impostazioni migliori" run (see tuneHeadline). */
export interface TuneHeadline {
  /** Index of the combination in tuning.combinations. */
  index: number;
  combo: TuneCombination;
  point: LatencyPoint;
  /** Measured with its context full; false = the search stopped before filling it (its deepest point). */
  full: boolean;
}

/**
 * A one-user search's speeds, read where the search reads them: its recommended combination (or the
 * one at `index`) with its context full; a search that stopped before filling it gives its deepest
 * point, and says so. undefined for "Più utenti", a run without a search, or nothing measured.
 */
export function tuneHeadline(run: Pick<RunResult, 'tuning'>, index?: number): TuneHeadline | undefined {
  const t = run.tuning;
  if (!t || t.goal === 'multi') return undefined;
  const i = index ?? recommendedIndex(t);
  const combo = i === undefined ? undefined : t.combinations[i];
  if (!combo?.sweep.length) return undefined;
  const full = fullContextPoint(combo);
  const point = full ?? combo.sweep.reduce((a, b) => (b.promptTokens > a.promptTokens ? b : a));
  return { index: i!, combo, point, full: full !== undefined };
}

/** Plain-language key for the speed sentence: faster than reading, or about as fast. */
export function sentenceKey(wordsPerSec: number): 'result.sentence' | 'result.sentenceSlow' {
  return wordsPerSec > READING_WORDS_PER_SEC * 3 ? 'result.sentence' : 'result.sentenceSlow';
}
