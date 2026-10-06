import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Copy, GitCompareArrows } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { RunResult } from '../../contract/results';
import { ErrorCard } from '../components/bench/error-card';
import { ExportMenu } from '../components/bench/export-menu';
import { engineLabelOf, modelLabelOf, shortGpuName } from '../components/bench/format';
import { rerunOf } from '../components/bench/rerun';
import { Details } from '../components/bench/result-details';
import { Launch } from '../components/bench/result-launch';
import { Overview } from '../components/bench/result-overview';
import { saveDraft } from '../components/bench/run-context';
import { copyText } from '../components/bench/servers';
import { useStartFlow } from '../components/bench/start-flow';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { useI18n } from '../i18n';
import { apiErrorData, useBenchLocalModels, useBenchSystem, useRun } from '../lib/queries-runs';
import { useSettings } from '../lib/settings';

const statusTone = { completed: 'success', failed: 'danger', cancelled: 'neutral' } as const;

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
  const { update } = useSettings();
  const local = useBenchLocalModels();
  const system = useBenchSystem();
  const flow = useStartFlow();
  const [tab, setTab] = useState('overview');
  const rerun = local.data ? rerunOf(run, local.data, system.data?.paths.enginesDir) : undefined;
  const modelLabel = modelLabelOf(run.model);
  const engineLabel = engineLabelOf(run.engine);

  const doRerun = (allowSharedGpu = false) => {
    if (!rerun) return;
    if (rerun.modelMissing) {
      toast.error(t('result.launch.modelMissing'));
      return;
    }
    flow.start({ ...rerun.request, allowSharedGpu }, { needs: [], modelLabel, engineLabel });
  };
  // The launch tab only offers this once the library is loaded (rerun known) and the model is there.
  // The run's exact parameters: the core only fills in what they leave unset.
  const serve = () => flow.serve({ engine: rerun!.request.engine, model: rerun!.request.model, params: run.launch.params }, { modelLabel, engineLabel });
  // The launch tab only enables this once the library is loaded (rerun known).
  const useSettingsHere = () => {
    saveDraft(qc, rerun!.draft);
    if (rerun!.needsExpert) update({ expertMode: true });
    toast.success(t('result.launch.appliedToast'));
    void navigate({ to: '/' });
  };

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
        <span className="flex flex-wrap items-center gap-x-2 text-sm text-fg-2">
          <span>{engineLabel}</span>
          <span aria-hidden className="text-fg-3">·</span>
          <span>{gpu ? shortGpuName(gpu.name) : '–'}</span>
          <span aria-hidden className="text-fg-3">·</span>
          <span>{dateTime(run.createdAt)}</span>
          <span aria-hidden className="text-fg-3">·</span>
          <span>{t(`benchmark.profiles.${run.scenario.profile}`)}</span>
        </span>
      }
      actions={
        <>
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
          <Overview run={run} onRerun={() => doRerun()} {...(errorCard ? { errorCard } : {})} />
        </TabsContent>
        <TabsContent value="details">
          <Details run={run} />
        </TabsContent>
        <TabsContent value="launch">
          <Launch run={run} rerun={rerun} onRerun={() => doRerun()} onUseSettings={useSettingsHere} onServe={serve} />
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
    </Page>
  );
}
