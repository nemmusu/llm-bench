/** The search a tune request asks for: "Ricontrollo rapido", "Più utenti" or "Un utente, contesto massimo". */
import { MultiTuner } from './tune-multi';
import { RecheckTuner } from './tune-recheck';
import { Tuner, type TunerDeps, type TunerInput } from './tuner';

export function createTuner(input: TunerInput, deps: TunerDeps): Tuner {
  if (input.budget === 'recheck' && input.recheck) return new RecheckTuner(input, deps);
  if (input.goal === 'multi' && input.multi) return new MultiTuner(input, deps);
  return new Tuner(input, deps);
}
