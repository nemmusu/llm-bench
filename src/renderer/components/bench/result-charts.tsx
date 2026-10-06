import { useCallback, useMemo, useState } from 'react';
import type { LatencyPoint, RunResult } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { barOption, concurrencyOption, timelineOption } from '../charts/builders';
import { ChartCard } from '../charts/chart-card';
import { EChart } from '../charts/echart';
import type { ChartTokens } from '../charts/echarts';
import { SegmentedControl } from '../ui/segmented-control';
import { MIB_PER_GB, prefillStat } from './format';
import { phaseBands } from './phases';

/** Generation / prompt-reading speed per prompt length. */
export function PromptChart({ points }: { points: readonly LatencyPoint[] }) {
  const { t, number, integer } = useI18n();
  const [metric, setMetric] = useState<'decode' | 'prefill'>('decode');
  const build = useCallback(
    (tk: ChartTokens) => {
      const fmt = (v: number) => (metric === 'decode' ? `${number(v, 1)} tok/s` : `${integer(v)} tok/s`);
      return barOption(
        tk,
        points.map((p) => integer(p.promptTokens)),
        points.map((p) => (metric === 'decode' ? p.decodeTps : prefillStat(p)).median),
        { name: t(`metrics.${metric}.label`), format: fmt, xName: t('result.promptTokens'), axis: integer },
      );
    },
    [points, metric, t, number, integer],
  );
  return (
    <ChartCard
      title={t('result.chartByPrompt')}
      help={t('result.chartByPromptHelp')}
      controls={
        <SegmentedControl
          size="sm"
          label={t('result.chartByPrompt')}
          value={metric}
          onValueChange={setMetric}
          options={[
            { value: 'decode', label: t('metrics.decode.label') },
            { value: 'prefill', label: t('metrics.prefill.label') },
          ]}
        />
      }
      table={{
        columns: [t('result.promptTokens'), `${t('metrics.decode.label')} (tok/s)`, `${t('metrics.prefill.label')} (tok/s)`, `${t('metrics.ttft.label')} (ms)`],
        numeric: [0, 1, 2, 3],
        rows: points.map((p) => [integer(p.promptTokens), number(p.decodeTps.median, 1), integer(prefillStat(p).median), integer(p.ttftMs.median)]),
      }}
    >
      <EChart build={build} height={260} label={t('result.chartByPrompt')} />
    </ChartCard>
  );
}

/** Total vs per-user throughput as users are added. */
export function ConcurrencyChart({ run }: { run: Pick<RunResult, 'metrics'> }) {
  const { t, integer } = useI18n();
  const c = run.metrics.concurrency;
  const build = useCallback(
    (tk: ChartTokens) =>
      concurrencyOption(
        tk,
        c.map((p) => p.level),
        c.map((p) => p.aggregateTps),
        c.map((p) => p.perRequestDecodeTpsP50),
        { aggregateName: t('result.aggregate'), perUserName: t('result.perUser'), format: (v) => `${integer(v)} tok/s`, xName: t('result.users'), axis: integer },
      ),
    [c, t, integer],
  );
  return (
    <ChartCard
      title={t('result.chartConcurrency')}
      help={t('result.chartConcurrencyHelp')}
      table={{
        columns: [t('result.users'), `${t('result.aggregate')} (tok/s)`, `${t('result.perUser')} (tok/s)`, `${t('result.details.ttftP95')} (ms)`],
        numeric: [0, 1, 2, 3],
        rows: c.map((p) => [p.level, integer(p.aggregateTps), integer(p.perRequestDecodeTpsP50), integer(p.ttftP95Ms)]),
      }}
    >
      <EChart build={build} height={260} label={t('result.chartConcurrency')} />
    </ChartCard>
  );
}

/** GPU utilization, memory and power over the whole run, with the phases as bands. */
export function TimelineChart({ telemetry, totalMiB, powerLimitW }: { telemetry: NonNullable<RunResult['telemetry']>; totalMiB: number | undefined; powerLimitW: number | undefined }) {
  const { t, number, integer, duration } = useI18n();
  const tel = telemetry;
  // Only rendered with at least one sample.
  const end = tel.t[tel.t.length - 1]! / 1000;
  const bands = useMemo(
    () =>
      phaseBands(
        tel.marks.map((m) => ({ t: m.t / 1000, label: m.label })),
        end,
      ).map((b) => ({ start: b.start, end: b.end, label: t(`phases.${b.phase}.label`) })),
    [tel, end, t],
  );
  const powerMax = powerLimitW ?? Math.max(100, ...tel.powerW.map((v) => v ?? 0));
  const build = useCallback(
    (tk: ChartTokens) =>
      timelineOption(
        tk,
        tel.t.map((x) => x / 1000),
        [
          { name: t('metrics.util.label'), unit: '%', values: tel.utilPct, format: (v) => `${integer(v)} %`, max: 100 },
          {
            name: t('metrics.vram.label'),
            unit: 'GB',
            values: tel.memUsedMiB.map((v) => (v === null ? null : v / MIB_PER_GB)),
            format: (v) => `${number(v, 1)} GB`,
            ...(totalMiB ? { max: Math.ceil(totalMiB / MIB_PER_GB) } : {}),
          },
          { name: t('metrics.power.label'), unit: 'W', values: tel.powerW, format: (v) => `${integer(v)} W`, max: powerMax },
        ],
        bands,
      ),
    [tel, bands, t, number, integer, totalMiB, powerMax],
  );
  const val = (v: number | null | undefined, fmt: (n: number) => string) => (v === null || v === undefined ? '–' : fmt(v));
  return (
    <ChartCard
      title={t('result.chartTimeline')}
      help={t('result.chartTimelineHelp')}
      table={{
        columns: [t('chart.time'), t('chart.phase'), `${t('metrics.util.label')} (%)`, `${t('metrics.vram.label')} (GB)`, `${t('metrics.power.label')} (W)`, `${t('metrics.temp.label')} (°C)`],
        numeric: [2, 3, 4, 5],
        rows: tel.t
          .map((x, i) => [x, i] as const)
          .filter(([, i]) => i % 4 === 0)
          .map(([x, i]) => [
            duration(x),
            bands.find((b) => x / 1000 >= b.start && x / 1000 <= b.end)?.label ?? '',
            val(tel.utilPct[i], integer),
            val(tel.memUsedMiB[i], (v) => number(v / MIB_PER_GB, 1)),
            val(tel.powerW[i], integer),
            val(tel.tempC[i], integer),
          ]),
      }}
    >
      <EChart build={build} height={34 + 3 * 64 + 2 * 40 + 32} label={t('result.chartTimeline')} />
    </ChartCard>
  );
}
