import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Copy, GitCompareArrows } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { configParamsOf } from '../../contract/configs';
import type { StartRunRequest } from '../../contract/api';
import { launchParamsSchema, type LaunchParams } from '../../contract/engines';
import type { RunResult } from '../../contract/results';
import { saveDraft } from '../components/bench/run-context';
import { recommendedIndex } from '../components/tune/tune-logic';
import { ErrorCard } from '../components/bench/error-card';
import { ExportMenu } from '../components/bench/export-menu';
import { engineLabelOf, modelLabelOf, shortGpuName } from '../components/bench/format';
import { Details } from '../components/bench/result-details';
import { Launch } from '../components/bench/result-launch';
import { Overview } from '../components/bench/result-overview';
import { copyText } from '../components/bench/servers';
import { useStartFlow } from '../components/bench/start-flow';
import { configLabelOf } from '../components/presets/config-label';
import { PresetActions } from '../components/presets/preset-actions';
import { usePreset } from '../components/presets/use-preset';
import { TuneOverview, type TunedRun } from '../components/tune/tune-result';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { useI18n } from '../i18n';
import { apiErrorData, useRun } from '../lib/queries-runs';

const statusTone = { completed: 'success', failed: 'danger', cancelled: 'neutral' } as const;

/**
 * The configuration the run measured (a tune run: its recommended combination, partly measured or
 * not), in configuration words. A tune run that measured nothing has no configuration to show: its
 * own launch record is only one of its launches.
 */
function ConfigLine({ run, combo }: { run: RunResult; combo: number | undefined }) {
  const f = useI18n();
  const combination = combo === undefined ? undefined : run.tuning?.combinations[combo];
  const launch = combination ? { params: combination.params, argv: combination.command.argv } : run.tuning ? undefined : run.launch;
  const label = launch
    ? configLabelOf(
        run.engine.kind,
        configParamsOf({
          engineKind: run.engine.kind,
          params: launch.params,
          argv: launch.argv,
          image: run.engine.image,
          blockCount: run.model.facts?.blockCount,
          modelContext: run.model.facts?.contextLength,
        }),
        f,
        { tags: combination?.tags },
      ).text
    : '';
  return (
    <span className="block text-sm text-fg-2">
      <span className="font-medium text-fg">{engineLabelOf(run.engine)}</span>
      {label && <span>{` · ${label}`}</span>}
    </span>
  );
}

/** One benchmark explained: score, plain-language sentence, KPIs, charts, launch command, log. */
export function ResultPage() {
  const { runId } = useParams({ from: '/results/$runId' });
  const { t } = useI18n();
  const query = useRun(runId);

  if (query.isError) {
    return (
      <Page title={t('result.notFoundTitle')} eyebrow={<BackLink />}>
        <ErrorCard error={apiErrorData(query.error)} handlers={{ retry: () => void query.refetch() }} />
      </Page>
    );
  }
  if (!query.data) {
    return (
      <div role="status" className="mx-auto flex max-w-[1240px] flex-col gap-4 px-8 pt-8" aria-busy="true" aria-label={t('common.loading')}>
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  return <ResultView key={runId} run={query.data} />;
}

function BackLink() {
  const { t } = useI18n();
  return (
    <Link to="/results" className="inline-flex items-center gap-1.5 self-start rounded-xs text-sm text-fg-2 hover:text-fg focus-ring">
      <ArrowLeft aria-hidden className="size-4" />
      {t('result.back')}
    </Link>
  );
}

function ResultView({ run }: { run: RunResult }) {
  const f = useI18n();
  const { t, dateTime } = f;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const flow = useStartFlow();
  // "Usa queste impostazioni" / "Avvia solo il server così": the same preset logic as everywhere (presets/).
  const launch = usePreset(run);
  const [tab, setTab] = useState('overview');
  const rerun = launch.preset;
  const modelLabel = modelLabelOf(run.model);
  const engineLabel = engineLabelOf(run.engine);

  /** The run again, with `patch` on top of its request (when its model is still there). */
  const startAgain = (patch: Partial<StartRunRequest>) => {
    if (!rerun) return;
    if (rerun.modelMissing) {
      toast.error(t('result.launch.modelMissing'));
      return;
    }
    flow.start({ ...rerun.request, ...patch }, { needs: [], modelLabel, engineLabel });
  };
  const doRerun = (allowSharedGpu = false) => startAgain({ allowSharedGpu });

  /** After a "Ricontrollo rapido": the whole search again ("Veloce"), with the same question. */
  const fullSearch = () => {
    const m = run.tuning?.multi;
    startAgain({ profile: 'tune', tune: { budget: 'fast', fidelity: false, ...(m ? { goal: 'multi' as const, users: m.users, perUserContext: m.perUserContext } : {}) } });
  };

  /** A run that spilled: the Benchmark page with this model and "Trova le impostazioni migliori", nothing else carried over. */
  const findSettings = () => {
    if (!rerun) return;
    const { provenance: _from, ...draft } = rerun.draft;
    saveDraft(qc, { ...draft, profile: 'tune', params: launchParamsSchema.parse({}) });
    void navigate({ to: '/' });
  };

  /** A run that spilled: the same test with what would fit (the q4_0 cache, or the largest context that fits). */
  const retryWith = (patch: Partial<LaunchParams>) => startAgain({ params: { ...run.launch.params, ...patch } });

  const errorCard = run.error ? (
    <ErrorCard
      error={run.error}
      handlers={{ retry: () => doRerun(), continueAnyway: () => doRerun(true), openLog: () => setTab('log') }}
      extra={
        run.error.code !== 'CANCELLED' && (
          <Button size="sm" variant="ghost" onClick={() => setTab('log')}>
            {t('result.openLog')}
          </Button>
        )
      }
    />
  ) : undefined;
  const gpu = run.hardware.gpus[0];
  // A "Trova le impostazioni migliori" test is used through its recommended combination (partly measured
  // when time ran out); never through its own launch record. Nothing measured: no preset at all.
  const combo = run.tuning ? recommendedIndex(run.tuning) : undefined;
  const presets = run.status === 'completed' && (!run.tuning || combo !== undefined);

  return (
    <Page
      eyebrow={<BackLink />}
      title={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {run.model.displayName}
          {run.model.quant && !run.model.displayName.includes(run.model.quant) && <span className="font-normal text-fg-3">{run.model.quant}</span>}
          <Badge tone={statusTone[run.status]} dot className="translate-y-[1px]">
            {t(`result.status.${run.status}`)}
          </Badge>
        </span>
      }
      subtitle={
        <span className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-x-2 text-sm text-fg-2">
            <span>{gpu ? shortGpuName(gpu.name) : '–'}</span>
            <span aria-hidden className="text-fg-3">·</span>
            <span>{dateTime(run.createdAt)}</span>
            <span aria-hidden className="text-fg-3">·</span>
            <span>{t(`benchmark.profiles.${run.scenario.profile}`)}</span>
          </span>
          {/* How the engine ran, always in sight: engine · context · cache · what differs from the defaults. */}
          <ConfigLine run={run} combo={combo} />
        </span>
      }
      actions={
        <>
          {presets && <PresetActions run={run} combo={combo} />}
          <Button onClick={() => void navigate({ to: '/compare', search: { a: run.id } })}>
            <GitCompareArrows aria-hidden />
            {t('result.compareWith')}
          </Button>
          <ExportMenu run={run} />
        </>
      }
    >
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">{t('result.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="details">{t('result.tabs.details')}</TabsTrigger>
          <TabsTrigger value="launch">{t('result.tabs.launch')}</TabsTrigger>
          <TabsTrigger value="log">{t('result.tabs.log')}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          {run.tuning ? (
            <TuneOverview run={run as TunedRun} onFullSearch={fullSearch} {...(errorCard ? { errorCard } : {})} />
          ) : (
            <Overview run={run} onRerun={() => doRerun()} onFindSettings={findSettings} onRetry={retryWith} {...(errorCard ? { errorCard } : {})} />
          )}
        </TabsContent>
        <TabsContent value="details">
          <Details run={run} />
        </TabsContent>
        <TabsContent value="launch">
          <Launch run={run} rerun={rerun} onRerun={() => doRerun()} onUseSettings={launch.apply} onServe={launch.serve} />
        </TabsContent>
        <TabsContent value="log">
          <Card className="overflow-hidden">
            <CardHeader className="items-center pb-3">
              <CardTitle>{t('result.log.title')}</CardTitle>
              <Button size="sm" variant="ghost" disabled={!run.logExcerpt} onClick={() => void copyText(run.logExcerpt, t('common.copied'), t('common.copyFailed'))}>
                <Copy aria-hidden />
                {t('result.log.copy')}
              </Button>
            </CardHeader>
            <pre
              role="region"
              tabIndex={0}
              aria-label={t('result.log.title')}
              className="max-h-[480px] overflow-auto border-t border-border bg-surface-2 px-card py-3 font-mono text-[12px] leading-5 text-fg-2 focus-ring"
            >
              {run.logExcerpt || t('result.log.empty')}
            </pre>
          </Card>
        </TabsContent>
      </Tabs>
      {flow.ui}
      {launch.ui}
    </Page>
  );
}
