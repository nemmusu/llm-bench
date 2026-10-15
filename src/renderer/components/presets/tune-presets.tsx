/**
 * "Preparati da LLM Bench": the key answers of the latest "Trova le impostazioni migliori" of this model
 * with this engine on this GPU (contract/tune-picks.ts), each one click from the launch settings —
 * the Benchmark's advanced parameters, or "Avvia un server". Said as made by LLM Bench from that search
 * (its date and the engine version it ran with, and when the engine here is another one now).
 */
import { Sparkles } from 'lucide-react';
import type { EngineKind, LaunchParams } from '../../../contract/engines';
import type { RunSummary } from '../../../contract/results';
import { tunePicks, type TunePick } from '../../../contract/tune-picks';
import { useI18n } from '../../i18n';
import { useRun, useTried } from '../../lib/queries-runs';
import { depthLabel, kvName } from '../tune/tune-format';
import { Button } from '../ui/button';

export interface TunePresets {
  run: Pick<RunSummary, 'id' | 'createdAt' | 'engineBuild'>;
  picks: TunePick[];
}

/** The latest completed tune of this model here with this engine kind, and its picks (undefined without one). */
export function useTunePresets(model: { weakKey: string; sha256?: string | undefined } | undefined, kind: EngineKind, gpuName: string | undefined): TunePresets | undefined {
  const tried = useTried(model ? { weakKey: model.weakKey, ...(model.sha256 ? { sha256: model.sha256 } : {}) } : undefined);
  const latest = newestTune(tried.data ?? [], kind, gpuName);
  const run = useRun(latest?.id);
  const tuning = run.data?.tuning;
  if (!latest || !tuning) return undefined;
  // A search with something found has at least one answer (the most precise KV type that loaded).
  return { run: latest, picks: tunePicks(tuning) };
}

/** The newest completed "Trova le impostazioni migliori" with something found, of this engine kind on this GPU. */
export function newestTune(runs: readonly RunSummary[], kind: EngineKind, gpuName: string | undefined): RunSummary | undefined {
  return runs
    .filter((r) => r.profile === 'tune' && r.status === 'completed' && r.engineKind === kind && r.gpuName === gpuName && (r.tunedCombinations ?? 0) > 0)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

export interface TunePresetListProps {
  presets: TunePresets;
  /** The engine version here now (its status), to say when the search ran with another one. */
  currentBuild?: string | undefined;
  onUse: (params: LaunchParams, pick: TunePick) => void;
}

export function TunePresetList({ presets, currentBuild, onUse }: TunePresetListProps) {
  const f = useI18n();
  const { t, number } = f;
  const { run } = presets;
  const other = currentBuild !== undefined && run.engineBuild !== undefined && run.engineBuild !== currentBuild;
  return (
    <section className="flex flex-col gap-3" aria-label={t('presets.tune.title')}>
      <div className="flex flex-col gap-0.5">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-fg">
          <Sparkles aria-hidden className="size-4 text-accent-text" />
          {t('presets.tune.title')}
        </h3>
        <p className="text-xs text-fg-3">
          {run.engineBuild ? t('presets.tune.fromBuild', { date: f.date(run.createdAt), build: run.engineBuild }) : t('presets.tune.from', { date: f.date(run.createdAt) })}
          {other && <span className="text-warning-text"> {t('presets.tune.otherBuild', { current: currentBuild })}</span>}
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {presets.picks.map((p) => {
          const name = p.ids.map((id) => t(`presets.tune.ids.${id}`)).join(' · ');
          const parts = [
            t('presets.tune.kv', { kv: kvName(p.kvType, f) }),
            // "Più utenti": how many and the context of each, not the launch's whole context.
            p.perUserContext !== undefined ? t('presets.tune.perUser', { n: p.users as number, ctx: depthLabel(p.perUserContext, f) }) : t('presets.tune.ctx', { ctx: depthLabel(p.maxContext, f) }),
            // The numbers are those of its first answer: a peak's (where it peaked), else with the context full.
            ...(p.depth !== undefined && p.ids[0] === 'fastest-read'
              ? [t('presets.tune.read', { tps: number(p.prefillTps as number, 0), depth: depthLabel(p.depth, f) })]
              : p.depth !== undefined
                ? [t('presets.tune.write', { tps: number(p.decodeTps as number, 1), depth: depthLabel(p.depth, f) })]
                : p.decodeTps !== undefined
                  ? [t('presets.tune.writeFull', { tps: number(p.decodeTps, 1) })]
                  : []),
          ];
          return (
            <li key={p.combination} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-fg">{name}</span>
                <span className="text-xs text-fg-2 tabular-nums">{parts.join(' · ')}</span>
              </span>
              <Button size="sm" onClick={() => onUse(p.params, p)} aria-label={t('presets.tune.useNamed', { name })}>
                {t('presets.tune.use')}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
