/** The search a tune request asks for: "Ricontrollo rapido", "Più utenti" or "Un utente, contesto massimo". */
import { MultiTuner } from './tune-multi';
import { RecheckTuner } from './tune-recheck';
import { Tuner, type TuneLab, type TunerDeps, type TunerInput } from './tuner';

export function createTuner(input: TunerInput, deps: TunerDeps): Tuner {
  if (input.budget === 'recheck' && input.recheck) return new RecheckTuner(input, deps);
  if (input.goal === 'multi' && input.multi) return new MultiTuner(input, deps);
  return new Tuner(input, deps);
}

/** A lab for searches that are only forecast, never run: nothing can be launched through it. */
export const FORECAST_ONLY: TuneLab = {
  prepare: () => Promise.reject(new Error('A forecast never launches the engine')),
};

/** How long the search for `input` is expected to take and its time limit, ms (the plan's duration). */
export function tuneTime(input: TunerInput): { estimateMs: number; limitMs: number } {
  return createTuner(input, { lab: FORECAST_ONLY, now: () => 0 }).time();
}
