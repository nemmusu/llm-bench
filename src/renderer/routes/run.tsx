import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ChevronDown, CircleStop, Loader } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ActiveRun, ActiveRunResponse } from '../../contract/api';
import type { RunPhase } from '../../contract/events';
import { MIB_PER_GB, prettyEngineLabel } from '../components/bench/format';
import { initialLive, liveReducer, seedFromActive, type LiveState } from '../components/bench/live-state';
import { engineKindOfLabel, fullCaption, nowText } from '../components/bench/live-now';
import { LiveConfig, LivePoints } from '../components/bench/live-panels';
import { LoadLine } from '../components/bench/load-line';
import { LiveSpillBanner } from '../components/bench/spill';
import { finishedStages } from '../components/bench/load-progress';
import { TuneLive } from '../components/tune/tune-live';
import { stageText } from '../components/tune/tune-format';
import { useConfigLabel } from '../components/presets/config-label';
import { detailLine, displayPhase, phaseBands, phaseKey, phaseStates, relevantPhases, remainingSeconds, type TuneShape } from '../components/bench/phases';
import { readRunContext, type RunContext } from '../components/bench/run-context';
import { timelineOption } from '../components/charts/builders';
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
import { useApi, useServerEvents } from '../lib/api-context';
import { cn } from '../lib/cn';
import { apiErrorData, useActiveRun, useBenchSystem } from '../lib/queries-runs';
import { useSettings } from '../lib/settings';
import { liveCaption } from '../lib/speed-at';

/** A gauge scale that grows with the value: 1, 2 or 5 × 10ⁿ above it. */
export function niceMax(v: number | undefined, floor: number): number {
  const target = Math.max(floor, (v ?? 0) * 1.25);
  const p = 10 ** Math.floor(Math.log10(target));
  return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= target)!;
}

/** Live screen while a benchmark runs: phases, big gauges, telemetry, log and Cancel. */
export function RunPage() {
  const { runId } = useParams({ from: '/run/$runId' });
  const qc = useQueryClient();
  // Remount per run: the live state belongs to one run only.
  return <LiveRun key={runId} runId={runId} ctx={readRunContext(qc, runId)} />;
}

function LiveRun({ runId, ctx }: { runId: string; ctx: RunContext | undefined }) {
  const f = useI18n();
  const { t, number, integer, duration } = f;
  const api = useApi();
  const navigate = useNavigate();
  const { settings } = useSettings();
  const system = useBenchSystem();
  const active = useActiveRun(2000);
  const [live, setLive] = useState<LiveState>(() => initialLive());
  // What the core says about this run (start time, ETA, labels, scenario): all a reopened screen has.
  const [info, setInfo] = useState<ActiveRun | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [logOpen, setLogOpen] = useState(settings.expertMode);
  const logRef = useRef<HTMLPreElement>(null);

  const toResult = useCallback(() => void navigate({ to: '/results/$runId', params: { runId }, replace: true }), [navigate, runId]);

  useServerEvents((e) => {
    setLive((s) => liveReducer(s, e, runId));
    if (e.type === 'run.done' && e.runId === runId) toResult();
  });

  // The core is the source of truth: resume the phase after a reload, leave when the run is over.
  // prevActive starts undefined (not with the cached data): a warm cache at mount (another screen read
  // the active run first) must still seed the screen once.
  const activeRun = active.data?.active;
  const [prevActive, setPrevActive] = useState<ActiveRunResponse | undefined>(undefined);
  if (active.data !== prevActive) {
    setPrevActive(active.data);
    if (activeRun?.runId === runId) {
      setInfo(activeRun);
      setLive((s) => seedFromActive(s, activeRun));
    }
  }
  const over = active.data !== undefined && activeRun?.runId !== runId;
  useEffect(() => {
    if (over) toResult();
  }, [over, toResult]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live.log.length, logOpen]);

  const scenario = ctx?.plan?.scenario ?? ctx?.request.scenario ?? info?.scenario;
  // A tune run's shape: from its request, else (a reopened screen) from its live search.
  const asked = ctx?.request.tune;
  const shape: TuneShape = {
    goal: asked?.goal ?? live.tuning?.goal,
    budget: asked?.budget ?? live.tuning?.budget,
    usersMode: asked?.usersMode ?? live.tuning?.multi?.usersMode,
  };
  const phases = relevantPhases(scenario, ctx?.pre, { fidelity: asked?.fidelity === true || live.phase === 'fidelity', tune: shape });
  const words = (p: RunPhase) => phaseKey(p, scenario?.profile === 'tune' ? shape : undefined);
  const current: RunPhase = displayPhase(live.phase, live.detail);
  const tune = scenario?.profile === 'tune';
  const engineKind = ctx?.request.engine.kind ?? engineKindOfLabel(live.launch?.engineLabel ?? info?.engineLabel ?? '');
  const label = useConfigLabel();
  const stage = tune && live.tuneCurrent ? stageText(live.tuneCurrent, engineKind, label, f) : undefined;
  // A search's launch in progress: its measurement with the context full (where its speeds are read) says so.
  const fullAt = tune ? live.tuneCurrent?.contextSize : undefined;
  const nowLine = live.current ? nowText(live.current, f, fullAt) : undefined;
  const states = phaseStates(phases, current);
  const at = Math.max(0, phases.indexOf(current));
  const startedAt = ctx?.startedAt ?? (info ? Date.parse(info.startedAt) : undefined);
  const elapsedSec = startedAt === undefined ? 0 : Math.max(0, (now - startedAt) / 1000);
  // A run that spills is far slower than its plan said: the time left comes from its own progress.
  const planned = live.spill ? undefined : (ctx?.plan?.estimatedSeconds ?? info?.estimatedSeconds);
  const left = remainingSeconds(elapsedSec, live.progress, planned, live.remaining, now);
  const detail = detailLine(live.phase, live.detail, scenario);

  const gpu = system.data?.gpus[0];
  const last = live.samples[live.samples.length - 1];
  const totalGb = (last?.memTotalMiB ?? gpu?.memoryTotalMiB ?? 0) / MIB_PER_GB;
  const powerMax = gpu?.powerLimitW ?? niceMax(last?.powerW ?? undefined, 300);
  const t0 = live.samples[0]?.t ?? 0;
  const endSec = ((last?.t ?? t0) - t0) / 1000;
  const bands = phaseBands(
    live.marks.map((m) => ({ t: Math.max(0, (m.t - t0) / 1000), label: m.phase })),
    endSec,
  ).map((b) => ({ start: b.start, end: b.end, label: t(`${words(b.phase)}.label`) }));

  const samples = live.samples;
  const build = useCallback(
    (tk: ChartTokens) =>
      timelineOption(
        tk,
        samples.map((s) => (s.t - t0) / 1000),
        [
          { name: t('metrics.util.label'), unit: '%', values: samples.map((s) => s.utilPct), format: (v) => `${integer(v)} %`, max: 100 },
          {
            name: t('metrics.vram.label'),
            unit: 'GB',
            values: samples.map((s) => (s.memUsedMiB === null ? null : s.memUsedMiB / MIB_PER_GB)),
            format: (v) => `${number(v, 1)} GB`,
            ...(totalGb ? { max: Math.ceil(totalGb) } : {}),
          },
          { name: t('metrics.power.label'), unit: 'W', values: samples.map((s) => s.powerW), format: (v) => `${integer(v)} W`, max: powerMax },
        ],
        bands,
        { xMax: Math.max(10, endSec), rowHeight: 56 },
      ),
    [samples, t0, bands, endSec, t, number, integer, totalGb, powerMax],
  );

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.post(`/api/runs/${encodeURIComponent(runId)}/cancel`);
      toast(t('run.cancelling'));
    } catch (e) {
      setCancelling(false);
      toast.error(t(`errors.${apiErrorData(e).code}.title`));
    }
  };

  const dash = (v: number | undefined, fmt: (n: number) => string) => (v === undefined ? '–' : fmt(v));
  // A speed not measured yet (or not yet on this tune launch) says so under its dash.
  const waiting = (v: number | undefined) => (v === undefined ? t('run.gaugeWaiting') : undefined);
  // Under a speed: what it was measured on ("prompt da 4.096 token", "contesto riempito a 32.768 token").
  return (
    <Page
      width="wide"
      // A dashboard: the whole window (a big screen shows the tables and cards side by side).
      className="max-w-none"
      eyebrow={
        <span className="inline-flex items-center gap-2 text-sm font-medium text-accent-text">
          <StatusDot tone="accent" pulse />
          {t('run.phaseOf', { n: at + 1, total: phases.length })}
        </span>
      }
      title={t('run.title')}
      subtitle={
        ctx
          ? t('run.subtitle', { model: ctx.modelLabel, engine: ctx.engineLabel, profile: t(`benchmark.profiles.${ctx.request.profile}`) })
          : info
            ? t('run.subtitle', { model: info.modelName, engine: prettyEngineLabel(info.engineLabel), profile: t(`benchmark.profiles.${info.profile}`) })
            : t('run.subtitleResumed')
      }
      actions={
        <Button variant="danger-outline" onClick={() => setConfirmOpen(true)} disabled={cancelling}>
          {cancelling ? <Loader aria-hidden className="animate-spin" /> : <CircleStop aria-hidden />}
          {cancelling ? t('run.cancelling') : t('run.cancel')}
        </Button>
      }
    >
      {/* Columns follow the room the page has (the sidebar takes part of the window), not the window. */}
      <div className="@container flex flex-col gap-section">
        {/* The moment the engine spills, before everything else: the numbers below will be far too low. */}
        {live.spill && <LiveSpillBanner spill={live.spill} onCancel={() => setConfirmOpen(true)} cancelling={cancelling} />}
        <Card className="overflow-hidden">
          <div className="px-card pt-6 pb-5">
            <Stepper
              label={t('run.phasesLabel')}
              steps={phases.map((p) => ({ id: p, label: t(`${words(p)}.label`), state: states[p]! }))}
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
                <p className="text-md font-medium text-fg">{t(`${words(current)}.status`)}</p>
                {stage && <p className="text-sm font-medium text-accent-text">{stage}</p>}
                {nowLine ? (
                  <p className="text-sm text-fg-2 tabular-nums">{nowLine}</p>
                ) : (
                  detail && <p className="text-sm text-fg-3 tabular-nums">{t(detail.key, { ...detail.params, ...('tokens' in detail.params ? { tokens: integer(detail.params.tokens) } : {}) })}</p>
                )}
              </div>
            </div>
            {live.load && <LoadLine progress={live.load.current} engineKind={engineKind} stages={finishedStages(live.load)} className="pl-8" />}
            <div className="flex items-center gap-4">
              <Progress value={live.progress * 100} label={t('run.progress')} valueText={`${integer(live.progress * 100)}%`} className="flex-1" />
              <span className="w-10 text-right text-sm font-semibold tabular-nums">{integer(live.progress * 100)}%</span>
            </div>
            <div className="flex justify-between text-xs text-fg-3 tabular-nums">
              <span>{t('run.elapsed', { time: duration(elapsedSec * 1000) })}</span>
              <span>{left === undefined ? t('run.etaUnknown') : t('run.eta', { time: duration(left * 1000) })}</span>
            </div>
          </div>
        </Card>

        <section aria-label={t('run.live')}>
          <Card className="grid grid-cols-2 gap-y-6 px-card py-6 @xl:grid-cols-3 @4xl:grid-cols-5">
            <RadialGauge
              size={156}
              value={live.decodeTps ?? 0}
              max={niceMax(live.decodeTps, 50)}
              label={t('metrics.decode.label')}
              help={t('metrics.decode.help')}
              unit="tok/s"
              caption={waiting(live.decodeTps) ?? fullCaption(live.decodeAt, fullAt, f) ?? liveCaption(live.decodeAt, f)}
              format={() => dash(live.decodeTps, (v) => number(v, 1))}
            />
            <RadialGauge
              size={156}
              value={live.prefillTps ?? 0}
              max={niceMax(live.prefillTps, 1000)}
              label={t('metrics.prefill.label')}
              help={t('metrics.prefill.help')}
              unit="tok/s"
              caption={waiting(live.prefillTps) ?? fullCaption(live.prefillAt, fullAt, f) ?? liveCaption(live.prefillAt, f)}
              format={() => dash(live.prefillTps, integer)}
            />
            <RadialGauge
              size={156}
              value={(last?.memUsedMiB ?? 0) / MIB_PER_GB}
              max={totalGb || 1}
              label={t('metrics.vram.label')}
              help={t('metrics.vram.help')}
              unit="GB"
              caption={totalGb ? `GB ${t('common.of')} ${number(totalGb, 1)}` : undefined}
              format={() => dash(last?.memUsedMiB ?? undefined, (v) => number(v / MIB_PER_GB, 1))}
              warnAt={0.85}
              dangerAt={0.95}
            />
            <RadialGauge
              size={156}
              value={last?.tempC ?? 0}
              max={100}
              label={t('metrics.temp.label')}
              help={t('metrics.temp.help')}
              unit="°C"
              format={() => dash(last?.tempC ?? undefined, integer)}
              warnAt={0.8}
              dangerAt={0.88}
            />
            <RadialGauge
              size={156}
              value={last?.powerW ?? 0}
              max={powerMax}
              label={t('metrics.power.label')}
              help={t('metrics.power.help')}
              unit="W"
              caption={`W ${t('common.of')} ${integer(powerMax)}`}
              format={() => dash(last?.powerW ?? undefined, integer)}
            />
          </Card>
        </section>

        {tune && <TuneLive tuning={live.tuning} current={live.tuneCurrent} engineKind={engineKind} />}

        <div className="grid items-start gap-section @7xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
          <LivePoints points={live.points} current={live.current} scenario={scenario} tune={tune} fullAt={fullAt} />
          <LiveConfig launch={live.launch} engineKind={engineKind} />
        </div>

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
              .filter((_, i) => i % 4 === 0)
              .map((s) => {
                const x = (s.t - t0) / 1000;
                return [
                  duration(x * 1000),
                  bands.find((b) => x >= b.start && x <= b.end)?.label ?? '',
                  s.utilPct === null ? '–' : integer(s.utilPct),
                  s.memUsedMiB === null ? '–' : number(s.memUsedMiB / MIB_PER_GB, 1),
                  s.powerW === null ? '–' : integer(s.powerW),
                ];
              }),
          }}
        >
          {samples.length ? (
            <EChart build={build} height={34 + 3 * 56 + 2 * 40 + 32} label={t('run.telemetry')} />
          ) : (
            <p className="py-10 text-center text-sm text-fg-3">{t('run.telemetryWaiting')}</p>
          )}
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
                  <Badge size="sm">{t('run.logLines', { n: live.log.length })}</Badge>
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
                {live.log.length ? live.log.join('\n') : t('run.logEmpty')}
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
        onConfirm={() => void cancel()}
      />
    </Page>
  );
}
