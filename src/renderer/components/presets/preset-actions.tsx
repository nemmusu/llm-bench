/**
 * "Usa questo preset" and "Avvia il server così" for a run, or for one combination of a "Trova le
 * impostazioni migliori" run: the exact launch parameters that produced its numbers.
 *
 * Shared component: this is the minimal version the tune screens were built against; the presets
 * work owns the final one, with the same props.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Server, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import type { RunResult } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { useBenchLocalModels, useBenchSystem } from '../../lib/queries-runs';
import { useSettings } from '../../lib/settings';
import { engineLabelOf, modelLabelOf } from '../bench/format';
import { rerunOf } from '../bench/rerun';
import { saveDraft } from '../bench/run-context';
import { useStartFlow } from '../bench/start-flow';
import { Button } from '../ui/button';

export function PresetActions({ run, combo }: { run: RunResult; combo?: number }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { update } = useSettings();
  const local = useBenchLocalModels();
  const system = useBenchSystem();
  const flow = useStartFlow();
  const rerun = local.data ? rerunOf(run, local.data, system.data?.paths.enginesDir) : undefined;
  const params = (combo === undefined ? undefined : run.tuning?.combinations[combo]?.params) ?? run.launch.params;
  const canServe = rerun !== undefined && !rerun.modelMissing && run.engine.kind !== 'external';

  const use = () => {
    saveDraft(qc, { ...rerun!.draft, profile: 'standard', params });
    update({ expertMode: true });
    toast.success(t('tune.preset.applied'));
    void navigate({ to: '/' });
  };
  const serve = () =>
    flow.serve({ engine: rerun!.request.engine, model: rerun!.request.model, params }, { modelLabel: modelLabelOf(run.model), engineLabel: engineLabelOf(run.engine) });

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={use} disabled={!rerun}>
        <SlidersHorizontal aria-hidden />
        {t('tune.preset.use')}
      </Button>
      {canServe && (
        <Button size="sm" variant="outline" onClick={serve}>
          <Server aria-hidden />
          {t('tune.preset.serve')}
        </Button>
      )}
      {flow.ui}
    </span>
  );
}
