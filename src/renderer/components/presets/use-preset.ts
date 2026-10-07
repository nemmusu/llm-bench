/**
 * The one implementation behind "Usa questo preset" / "Usa queste impostazioni" (copy engine, model
 * and launch params to the Benchmark page) and "Avvia il server così" (start the engine exactly
 * like that, downloading the model first when it is not on the PC any more).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { RunResult } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { useBenchLocalModels, useBenchSystem } from '../../lib/queries-runs';
import { useSettings } from '../../lib/settings';
import { engineLabelOf, modelLabelOf } from '../bench/format';
import { presetOf, type Preset, type PresetOptions } from '../bench/rerun';
import { saveDraft } from '../bench/run-context';
import { useStartFlow } from '../bench/start-flow';

export interface UsePreset {
  /** Undefined until the library is loaded (the model may have to be downloaded first). */
  preset: Preset | undefined;
  /** Copies the preset to the Benchmark page (expert mode on when its settings need it) and opens it. */
  apply: () => void;
  /** "Avvia il server così": the confirmation, downloads, then the server. */
  serve: () => void;
  /** The start flow's dialogs: render them once. */
  ui: ReactNode;
}

export function usePreset(run: RunResult, opts: PresetOptions = {}): UsePreset {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { update } = useSettings();
  const local = useBenchLocalModels();
  const system = useBenchSystem();
  const flow = useStartFlow();
  const enginesDir = system.data?.paths.enginesDir;
  const { combo, at } = opts;
  const preset = useMemo(() => (local.data ? presetOf(run, local.data, enginesDir, { combo, at }) : undefined), [run, local.data, enginesDir, combo, at]);
  // Both actions are only offered once the preset is known.
  const apply = () => {
    saveDraft(qc, preset!.draft);
    if (preset!.needsExpert) update({ expertMode: true });
    toast.success(t('result.launch.appliedToast'));
    void navigate({ to: '/' });
  };
  const serve = () => flow.serve(preset!.serve, { modelLabel: modelLabelOf(run.model), engineLabel: engineLabelOf(run.engine) });
  return { preset, apply, serve, ui: flow.ui };
}
