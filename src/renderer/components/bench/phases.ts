/** Phase logic of the live screen: which phases a run has, their state, plain-language details. */
import { RUN_PHASES, type RunPhase } from '../../../contract/events';
import type { Scenario } from '../../../contract/results';
import type { StepState } from '../ui/stepper';

/** Steps done by the app before the run (inline install / download). */
export interface PreSteps {
  install?: boolean;
  download?: boolean;
}

/**
 * The phases this run goes through, in order. Without a scenario (screen reopened while a run
 * was already going) every measuring phase is listed.
 */
export function relevantPhases(scenario: Scenario | undefined, pre: PreSteps = {}, opts: { fidelity?: boolean } = {}): RunPhase[] {
  const has = new Set<RunPhase>(['prepare', 'cleanup']);
  if (pre.install) has.add('install');
  if (pre.download) has.add('download');
  if (!scenario) {
    for (const p of ['cold-load', 'warm-load', 'prefill', 'decode', 'context-sweep', 'concurrency', 'llama-bench'] as const) has.add(p);
  } else if (scenario.profile === 'tune') {
    // "Trova le impostazioni migliori": largest context per cache, one setting at a time, then the sweeps.
    for (const p of ['tune-capacity', 'tune-variants', 'context-sweep'] as const) has.add(p);
    if (opts.fidelity) has.add('fidelity');
  } else {
    for (const step of scenario.steps) {
      if (step.kind === 'load') has.add(step.cache === 'cold' ? 'cold-load' : 'warm-load');
      else if (step.kind === 'latency') {
        // The core reports long prompts (> 1024 tokens) as "reading the prompt", short ones as generation.
        if (step.promptTokens.some((p) => p > 1024)) has.add('prefill');
        if (step.promptTokens.some((p) => p <= 1024)) has.add('decode');
      } else if (step.kind === 'concurrency') has.add('concurrency');
      else if (step.kind === 'context-sweep') has.add('context-sweep');
      else has.add('llama-bench');
    }
  }
  // Install and download happen before the run itself: listed first, already done once it starts.
  const pre_ = (['install', 'download'] as const).filter((p) => has.has(p));
  return [...pre_, ...RUN_PHASES.filter((p) => has.has(p) && p !== 'install' && p !== 'download')];
}

/** llama-bench is reported as phase "decode" with detail "llama-bench". */
export function displayPhase(phase: RunPhase, detail?: string): RunPhase {
  return phase === 'decode' && detail === 'llama-bench' ? 'llama-bench' : phase;
}

/** done / current / pending for each listed phase; a phase missing from the list makes it current-less. */
export function phaseStates(phases: readonly RunPhase[], current: RunPhase): Record<string, StepState> {
  const at = phases.indexOf(current);
  const out: Record<string, StepState> = {};
  phases.forEach((p, i) => {
    out[p] = i < at ? 'done' : i === at ? 'current' : 'pending';
  });
  return out;
}

export type DetailLine =
  | { key: 'run.detail.loadRep'; params: { n: number; total: number } }
  | { key: 'run.detail.prompt'; params: { tokens: number } }
  | { key: 'run.detail.users'; params: { n: number } };

/** "Caricamento 2 di 3", "Testo da 4.096 token", "4 utenti insieme" from the run.phase detail. */
export function detailLine(phase: RunPhase, detail: string | undefined, scenario: Scenario | undefined): DetailLine | undefined {
  const n = Number(detail);
  if (!detail || !Number.isFinite(n)) return undefined;
  if (phase === 'cold-load' || phase === 'warm-load') {
    const cache = phase === 'cold-load' ? 'cold' : 'warm';
    const step = scenario?.steps.find((s) => s.kind === 'load' && s.cache === cache);
    return { key: 'run.detail.loadRep', params: { n, total: step?.kind === 'load' ? step.reps : n } };
  }
  if (phase === 'prefill' || phase === 'decode') return { key: 'run.detail.prompt', params: { tokens: n } };
  if (phase === 'concurrency') return { key: 'run.detail.users', params: { n } };
  return undefined;
}

/**
 * Seconds left: from the plan's estimate while it is plausible, otherwise extrapolated from the
 * progress. Undefined until there is enough to say something honest.
 */
export function remainingSeconds(elapsedSec: number, progress: number, estimatedSec?: number): number | undefined {
  if (progress >= 1) return 0;
  if (estimatedSec !== undefined && estimatedSec > elapsedSec) return estimatedSec - elapsedSec;
  // Early progress says little about the rest (loads are short, generation is long).
  if (progress < 0.1 || elapsedSec < 10) return undefined;
  return (elapsedSec * (1 - progress)) / progress;
}

/** Bands for the timeline chart from phase marks (seconds), keeping only real phase changes. */
export function phaseBands(marks: readonly { t: number; label: string }[], endSec: number): { phase: RunPhase; start: number; end: number }[] {
  const phases = marks
    .filter((m): m is { t: number; label: RunPhase } => (RUN_PHASES as readonly string[]).includes(m.label))
    .filter((m, i, all) => i === 0 || all[i - 1]!.label !== m.label);
  return phases.map((m, i) => ({ phase: m.label, start: m.t, end: phases[i + 1]?.t ?? Math.max(endSec, m.t) }));
}
