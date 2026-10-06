/** The headline numbers of a run, picked once for the result page, the compare page and the exports. */
import type { ConcurrencyPoint, RunResult, Stat } from '../../../contract/results';
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

export function kpisOf(run: Pick<RunResult, 'metrics'>): Kpis {
  const m = run.metrics;
  const p = headlinePoint(m.latency);
  const vram = vramFigure(m.vram);
  const conc = peakConcurrency(run);
  const out: Kpis = {};
  if (p) {
    out.promptTokens = p.promptTokens;
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

/** Plain-language key for the speed sentence: faster than reading, or about as fast. */
export function sentenceKey(wordsPerSec: number): 'result.sentence' | 'result.sentenceSlow' {
  return wordsPerSec > READING_WORDS_PER_SEC * 3 ? 'result.sentence' : 'result.sentenceSlow';
}
