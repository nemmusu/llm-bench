import { useNavigate, useParams } from '@tanstack/react-router';
import { ChevronDown, CircleStop, Loader } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { RUN_PHASES } from '../../contract/events';
import { timelineOption, type PhaseBand } from '../components/charts/builders';
import { ChartCard } from '../components/charts/chart-card';
import { EChart } from '../components/charts/echart';
import type { ChartTokens } from '../components/charts/echarts';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/dialog';
import { Progress } from '../components/ui/progress';
import { RadialGauge } from '../components/ui/radial-gauge';
import { StatusDot } from '../components/ui/status-dot';
import { Stepper } from '../components/ui/stepper';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { useMockLiveRun } from '../mock/live';
import { mockGpu, POWER_LIMIT_W } from '../mock/system';

/** Live screen while a benchmark runs: phases, big gauges, telemetry, log and Cancel. */
export function RunPage() {
  const { runId } = useParams({ from: '/run/$runId' });
  const { t, number, integer, duration } = useI18n();
  const navigate = useNavigate();
  const run = useMockLiveRun(runId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);
  const totalGb = mockGpu.memoryTotalMiB / 1024;
  const currentIndex = RUN_PHASES.indexOf(run.phase);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run.log.length, logOpen]);

  const { samples, schedule } = run;
  const bands: PhaseBand[] = schedule.map((s) => ({ start: s.start, end: s.end, label: t(`phases.${s.phase}.label`) }));
  const build = useCallback(
    (tk: ChartTokens) =>
      timelineOption(
        tk,
        samples.map((s) => s.t),
        [
          { name: t('metrics.util.label'), unit: '%', values: samples.map((s) => s.utilPct), format: (v) => `${integer(v)} %`, max: 100 },
          { name: t('metrics.vram.label'), unit: 'GB', values: samples.map((s) => s.memUsedMiB / 1024), format: (v) => `${number(v, 1)} GB`, max: Math.ceil(totalGb) },
          { name: t('metrics.power.label'), unit: 'W', values: samples.map((s) => s.powerW), format: (v) => `${integer(v)} W`, max: 600 },
        ],
        schedule.map((s) => ({ start: s.start, end: s.end, label: t(`phases.${s.phase}.label`) })),
        { xMax: schedule[schedule.length - 1]!.end, rowHeight: 56 },
      ),
    [samples, schedule, t, number, integer, totalGb],
  );

  const cancel = () => {
    toast(t('run.cancelled'));
    void navigate({ to: '/' });
  };

  const live = run.live;
  return (
    <Page
      width="wide"
      eyebrow={
        <span className="inline-flex items-center gap-2 text-sm font-medium text-accent-text">
          <StatusDot tone="accent" pulse />
          {t('run.phaseOf', { n: currentIndex + 1, total: RUN_PHASES.length })}
        </span>
      }
      title={t('run.title')}
      subtitle={t('run.subtitle', { model: run.modelName, engine: run.engineLabel, profile: t(`benchmark.profiles.${run.profile}`) })}
      actions={
        <Button variant="danger-outline" onClick={() => setConfirmOpen(true)}>
          <CircleStop aria-hidden />
          {t('run.cancel')}
        </Button>
      }
    >
      <div className="flex flex-col gap-section">
        <Card className="overflow-hidden">
          <div className="px-card pt-6 pb-5">
            <Stepper
              label={t('run.phasesLabel')}
              steps={RUN_PHASES.map((p) => ({ id: p, label: t(`phases.${p}.label`), state: run.phaseStates[p] }))}
              stateLabels={{
                done: t('phases.state.done'),
                current: t('phases.state.current'),
                pending: t('phases.state.pending'),
                skipped: t('phases.state.skipped'),
              }}
            />
          </div>
          <div className="flex flex-col gap-3 border-t border-border bg-surface-2/50 px-card py-4">
            <div className="flex items-start gap-3" aria-live="polite">
              <Loader aria-hidden className="mt-0.5 size-5 shrink-0 animate-spin text-accent [animation-duration:2.4s]" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="text-md font-medium text-fg">{t(`phases.${run.phase}.status`)}</p>
                <p className="text-sm text-fg-3 tabular-nums">
                  {t('run.detailRepetition', { n: run.repetition.n, total: run.repetition.total, tokens: run.repetition.tokens })}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <Progress value={run.progress * 100} label={t('run.progress')} valueText={`${integer(run.progress * 100)}%`} className="flex-1" />
              <span className="w-10 text-right text-sm font-semibold tabular-nums">{integer(run.progress * 100)}%</span>
            </div>
            <div className="flex justify-between text-xs text-fg-3 tabular-nums">
              <span>{t('run.elapsed', { time: duration(run.elapsedSec * 1000) })}</span>
              <span>{t('run.eta', { time: duration(run.etaSec * 1000) })}</span>
            </div>
          </div>
        </Card>

        <section aria-label={t('run.live')}>
          <Card className="grid grid-cols-2 gap-y-6 px-card py-6 sm:grid-cols-3 xl:grid-cols-5">
            <RadialGauge
              size={156}
              value={live.decodeTps}
              max={250}
              label={t('metrics.decode.label')}
              help={t('metrics.decode.help')}
              unit="tok/s"
              format={(v) => number(v, 1)}
            />
            <RadialGauge
              size={156}
              value={live.prefillTps}
              max={12000}
              label={t('metrics.prefill.label')}
              help={t('metrics.prefill.help')}
              unit="tok/s"
              format={(v) => integer(v)}
            />
            <RadialGauge
              size={156}
              value={live.vramGiB}
              max={totalGb}
              label={t('metrics.vram.label')}
              help={t('metrics.vram.help')}
              unit="GB"
              caption={`GB ${t('common.of')} ${number(totalGb, 1)}`}
              format={(v) => number(v, 1)}
              warnAt={0.85}
              dangerAt={0.95}
            />
            <RadialGauge
              size={156}
              value={live.tempC}
              max={100}
              label={t('metrics.temp.label')}
              help={t('metrics.temp.help')}
              unit="°C"
              format={(v) => integer(v)}
              warnAt={0.8}
              dangerAt={0.88}
            />
            <RadialGauge
              size={156}
              value={live.powerW}
              max={POWER_LIMIT_W}
              label={t('metrics.power.label')}
              help={t('metrics.power.help')}
              unit="W"
              caption={`W ${t('common.of')} ${integer(POWER_LIMIT_W)}`}
              format={(v) => integer(v)}
            />
          </Card>
        </section>

        <ChartCard
          title={t('run.telemetry')}
          help={t('run.telemetryHelp')}
          controls={
            <Badge tone="success" size="sm">
              <StatusDot tone="success" pulse />
              {t('benchmark.gpu.live')}
            </Badge>
          }
          table={{
            columns: [t('chart.time'), t('chart.phase'), `${t('metrics.util.label')} (%)`, `${t('metrics.vram.label')} (GB)`, `${t('metrics.power.label')} (W)`],
            numeric: [2, 3, 4],
            rows: samples
              .filter((_, i) => i % 5 === 0)
              .map((s) => [
                duration(s.t * 1000),
                bands.find((b) => s.t >= b.start && s.t < b.end)?.label ?? '',
                integer(s.utilPct),
                number(s.memUsedMiB / 1024, 1),
                integer(s.powerW),
              ]),
          }}
        >
          <EChart build={build} height={34 + 3 * 56 + 2 * 40 + 32} label={t('run.telemetry')} />
        </ChartCard>

        <Collapsible.Root open={logOpen} onOpenChange={setLogOpen}>
          <Card className="overflow-hidden">
            <Collapsible.Trigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-card py-3.5 text-left hover:bg-surface-2/60 focus-ring"
                aria-label={logOpen ? t('run.logHide') : t('run.logShow')}
              >
                <span className="flex items-center gap-2">
                  <span className="text-md font-semibold">{t('run.log')}</span>
                  <Badge size="sm">{t('run.logLines', { n: run.log.length })}</Badge>
                </span>
                <ChevronDown aria-hidden className={cn('size-4 text-fg-3 transition-transform', logOpen && 'rotate-180')} />
              </button>
            </Collapsible.Trigger>
            <Collapsible.Content>
              <pre
                ref={logRef}
                role="region"
                tabIndex={0}
                aria-label={t('run.log')}
                className="max-h-64 overflow-auto border-t border-border bg-surface-2 px-card py-3 font-mono text-[12px] leading-5 text-fg-2 focus-ring"
              >
                {run.log.join('\n')}
              </pre>
            </Collapsible.Content>
          </Card>
        </Collapsible.Root>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('run.cancelTitle')}
        description={t('run.cancelBody')}
        cancelLabel={t('run.cancelKeep')}
        confirmLabel={t('run.cancelConfirm')}
        onConfirm={cancel}
      />
    </Page>
  );
}
