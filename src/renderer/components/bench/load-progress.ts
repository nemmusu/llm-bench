/**
 * Engine start, followed stage by stage (run.load events): what it is doing now and how long each
 * stage took, so people learn where the loading time goes. Pure.
 */
import type { LoadProgress, LoadStage } from '../../../contract/events';
import type { EngineKind } from '../../../contract/engines';
import type { Formatters } from '../../i18n';

export interface LoadSpan {
  stage: LoadStage;
  startMs: number;
  /** Set once the next stage began (or the engine got ready). */
  endMs?: number;
}

export interface LoadTrack {
  current: LoadProgress;
  /** Stages of this engine start, in order ('ready' is not one: it ends the last). */
  spans: LoadSpan[];
}

/**
 * Folds one progress update into the track. A new engine start (after 'ready', or a clock that went
 * back) begins a new track; time before the first recognised log line counts as "starting".
 */
export function trackLoad(prev: LoadTrack | undefined, p: LoadProgress): LoadTrack {
  const fresh = !prev || prev.current.stage === 'ready' || p.elapsedMs < prev.current.elapsedMs;
  if (fresh) {
    // Joined when already ready (screen reopened): the stages are not known.
    if (p.stage === 'ready') return { current: p, spans: [] };
    if (p.stage === 'starting' || p.elapsedMs === 0) return { current: p, spans: [{ stage: p.stage, startMs: 0 }] };
    return { current: p, spans: [{ stage: 'starting', startMs: 0, endMs: p.elapsedMs }, { stage: p.stage, startMs: p.elapsedMs }] };
  }
  const spans = [...prev.spans];
  const last = spans[spans.length - 1]!;
  if (last.stage !== p.stage) {
    spans[spans.length - 1] = { ...last, endMs: p.elapsedMs };
    if (p.stage !== 'ready') spans.push({ stage: p.stage, startMs: p.elapsedMs });
  }
  return { current: p, spans };
}

/** Durations of the stages already finished. */
export function finishedStages(track: LoadTrack): { stage: LoadStage; ms: number }[] {
  return track.spans.flatMap((s) => (s.endMs === undefined ? [] : [{ stage: s.stage, ms: s.endMs - s.startMs }]));
}

/** "vLLM", "llama.cpp" (no name for an external server). */
export function engineName(kind: EngineKind): string | undefined {
  if (kind === 'vllm-docker' || kind === 'vllm-native') return 'vLLM';
  if (kind === 'external') return undefined;
  return 'llama.cpp';
}

/** "0:18", "2:05". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Short duration for the stage list: "0,4 s", "12 s", "1 min 05 s". */
export function shortDuration(ms: number, f: Pick<Formatters, 'number' | 'duration'>): string {
  const s = ms / 1000;
  if (s < 10) return `${f.number(s, 1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  return f.duration(ms);
}

/** "Caricamento pesi · 3 di 7 parti (43%)": the stage in words with its counts. */
export function stageProgressText(p: LoadProgress, kind: EngineKind, f: Pick<Formatters, 't' | 'integer'>): string {
  const { t, integer } = f;
  const parts = [t(`load.stages.${p.stage}`)];
  if (p.done !== undefined && p.total !== undefined && p.total > 0) {
    const unit = p.stage === 'cuda-graphs' ? 'graphs' : p.stage === 'weights' ? (engineName(kind) === 'vLLM' ? 'shards' : 'layers') : 'steps';
    parts.push(t(`load.units.${unit}`, { done: integer(p.done), total: integer(p.total) }));
  }
  const pct = p.fraction === undefined ? '' : ` (${integer(p.fraction * 100)}%)`;
  return parts.join(' · ') + pct;
}
