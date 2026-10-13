import { Activity, Cpu, MemoryStick } from 'lucide-react';
import { useCallback } from 'react';
import type { SystemResponse } from '../../contract/api';
import type { GpuSample } from '../../contract/hardware';
import { agoLabel, sparkAreaOption } from '../components/charts/builders';
import { ChartCard } from '../components/charts/chart-card';
import { EChart } from '../components/charts/echart';
import type { ChartTokens } from '../components/charts/echarts';
import { ErrorCallout } from '../components/library/error-callout';
import { HISTORY_SECONDS, useGpuHistory } from '../components/monitor/use-gpu-history';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Callout } from '../components/ui/callout';
import { Card, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { EmptyState } from '../components/ui/empty-state';
import { StatTile } from '../components/ui/stat-tile';
import { StatusDot } from '../components/ui/status-dot';
import { useI18n } from '../i18n';
import { useSystemInfo } from '../lib/queries-library';

type Metric = 'utilPct' | 'memUsedMiB' | 'powerW' | 'tempC' | 'smClockMHz';

/**
 * Clock-event reasons that mean real slowing down (mirrors THROTTLE_REASONS in core/telemetry/
 * clock-reasons.ts); gpu_idle, reliability, sync_boost… are informational and not shown.
 */
export const THROTTLE_REASONS = ['sw_power_cap', 'hw_slowdown', 'sw_thermal_slowdown', 'hw_thermal_slowdown', 'hw_power_brake_slowdown', 'board_limit'] as const;

function LiveChart({ title, history, metric, scale = 1, format, max }: { title: string; history: GpuSample[]; metric: Metric; scale?: number; format: (v: number) => string; max?: number | undefined }) {
  const { t, integer } = useI18n();
  const last = history[history.length - 1]?.t ?? 0;
  const value = useCallback((s: GpuSample) => (s[metric] ?? 0) / scale, [metric, scale]);
  // A fixed three-minute axis: an empty point at the left edge, so the line grows in from the right.
  const build = useCallback(
    (tk: ChartTokens) =>
      sparkAreaOption(
        tk,
        [-HISTORY_SECONDS, ...history.map((s) => (s.t - last) / 1000)],
        [Number.NaN, ...history.map(value)],
        { name: title, format, axis: integer, ...(max === undefined ? {} : { max }) },
      ),
    [history, last, value, format, max, title, integer],
  );
  return (
    <ChartCard
      title={title}
      table={{
        columns: [t('chart.time'), title],
        numeric: [1],
        rows: history.filter((_, i) => (history.length - 1 - i) % 15 === 0).map((s) => [agoLabel((last - s.t) / 1000), format(value(s))]),
      }}
    >
      <EChart build={build} height={150} label={title} />
    </ChartCard>
  );
}

const KIND_TONE = { llm: 'info', vm: 'neutral', app: 'neutral', system: 'neutral' } as const;

function GpuUsers({ users }: { users: SystemResponse['otherGpuUsers'] | undefined }) {
  const { t, bytes } = useI18n();
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-1">
          <CardTitle>{t('monitor.users')}</CardTitle>
          <CardDescription>{t('monitor.usersWhy')}</CardDescription>
        </div>
      </CardHeader>
      {users && users.length > 0 ? (
        <ul className="divide-y divide-border border-t border-border" aria-label={t('monitor.users')}>
          {users.map((u) => {
            const kind = u.kind ?? (u.knownLlm ? 'llm' : 'app');
            return (
              <li key={u.pid} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-card py-3 text-sm">
                <span className="font-mono font-medium text-fg">{u.name}</span>
                <span className="text-fg-3 tabular-nums">PID {u.pid}</span>
                <Badge tone={KIND_TONE[kind]} size="sm">
                  {t(`monitor.kinds.${kind}`)}
                </Badge>
                <span className="text-xs text-fg-3">{t(`monitor.kindHelp.${kind}`)}</span>
                <span className="ml-auto font-medium text-fg tabular-nums">{u.memMiB === undefined ? t('monitor.memUnknown') : bytes(u.memMiB * 1024 * 1024)}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="border-t border-border px-card py-4 text-sm text-fg-2">{t('monitor.noUsers')}</p>
      )}
    </Card>
  );
}

const num = (v: number | null | undefined) => (v === null || v === undefined ? undefined : v);

/** Live GPU telemetry (one reading per second, three-minute charts) and who else is using the GPU. */
export function MonitorPage() {
  const { t, number, integer } = useI18n();
  const system = useSystemInfo(3000);
  const gpu = system.data?.gpus.find((g) => g.vendor === 'nvidia');
  const { current, history, unavailable, error } = useGpuHistory(gpu?.index ?? 0);
  const fmtPct = useCallback((v: number) => `${integer(v)} %`, [integer]);
  const fmtGb = useCallback((v: number) => `${number(v, 1)} GB`, [number]);
  const fmtW = useCallback((v: number) => `${integer(v)} W`, [integer]);
  const fmtC = useCallback((v: number) => `${integer(v)} °C`, [integer]);
  const fmtMhz = useCallback((v: number) => `${integer(v)} MHz`, [integer]);
  const dash = '–';
  const show = (v: number | null | undefined, f: (n: number) => string) => (num(v) === undefined ? dash : f(v as number));
  const totalMiB = num(current?.memTotalMiB) ?? gpu?.memoryTotalMiB;
  const throttle = THROTTLE_REASONS.filter((r) => current?.throttle.includes(r));

  return (
    <Page
      title={t('monitor.title')}
      subtitle={t('monitor.subtitle')}
      width="wide"
      actions={
        gpu && (
          <Badge tone={current ? 'success' : 'neutral'}>
            <StatusDot tone={current ? 'success' : 'neutral'} pulse={current !== undefined} />
            {gpu.name}
          </Badge>
        )
      }
    >
      {error ? <ErrorCallout error={error} className="mb-4" /> : null}
      {unavailable ? (
        <Card>
          <EmptyState illustration="results" title={t('monitor.unavailableTitle')} description={t('monitor.unavailableBody')} />
        </Card>
      ) : (
        <div className="flex flex-col gap-section">
          <section aria-label={t('monitor.live')} className="grid gap-4 sm:grid-cols-3 xl:grid-cols-6">
            <StatTile label={t('monitor.metrics.util')} help={t('metrics.util.help')} value={show(current?.utilPct, integer)} unit="%" />
            <StatTile
              label={t('monitor.metrics.vram')}
              help={t('metrics.vram.help')}
              value={show(current?.memUsedMiB, (v) => number(v / 1024, 1))}
              unit="GB"
              hint={totalMiB ? t('monitor.of', { total: `${number(totalMiB / 1024, 1)} GB` }) : undefined}
            />
            <StatTile
              label={t('monitor.metrics.power')}
              help={t('metrics.power.help')}
              value={show(current?.powerW, integer)}
              unit="W"
              hint={gpu?.powerLimitW ? t('monitor.of', { total: `${integer(gpu.powerLimitW)} W` }) : undefined}
            />
            <StatTile label={t('monitor.metrics.temp')} help={t('metrics.temp.help')} value={show(current?.tempC, integer)} unit="°C" />
            <StatTile
              label={t('monitor.metrics.clock')}
              help={t('metrics.clock.help')}
              value={show(current?.smClockMHz, integer)}
              unit="MHz"
              hint={num(current?.memClockMHz) === undefined ? undefined : t('monitor.memClock', { mhz: integer(current?.memClockMHz as number) })}
            />
            <StatTile
              label={t('monitor.pcie')}
              help={t('monitor.pcieHelp')}
              value={num(current?.pcieGen) === undefined ? dash : `${current?.pcieGen}.0`}
              unit={num(current?.pcieWidth) === undefined ? undefined : `x${current?.pcieWidth}`}
              hint={gpu?.pcieGenMax ? t('monitor.pcieMax', { gen: gpu.pcieGenMax, width: gpu.pcieWidthMax ?? dash }) : undefined}
            />
          </section>
          {throttle.length > 0 && (
            <Callout tone="warning" title={t('monitor.throttling')}>
              {throttle.map((r) => t(`monitor.reasons.${r}`)).join(' · ')}
            </Callout>
          )}
          <div className="flex items-center gap-2 text-sm text-fg-2">
            <Activity aria-hidden className="size-4 text-fg-3" />
            {t('monitor.lastMinutes', { n: HISTORY_SECONDS / 60 })}
          </div>
          <div className="grid gap-section lg:grid-cols-2">
            <LiveChart title={t('monitor.chartUtil')} history={history} metric="utilPct" format={fmtPct} max={100} />
            <LiveChart title={t('monitor.chartVram')} history={history} metric="memUsedMiB" scale={1024} format={fmtGb} max={totalMiB ? Math.ceil(totalMiB / 1024) : undefined} />
            <LiveChart title={t('monitor.chartPower')} history={history} metric="powerW" format={fmtW} max={gpu?.powerLimitW} />
            <LiveChart title={t('monitor.chartTemp')} history={history} metric="tempC" format={fmtC} max={100} />
            <LiveChart title={t('monitor.chartClock')} history={history} metric="smClockMHz" format={fmtMhz} />
            <Card className="flex flex-col justify-center gap-3 p-card text-sm text-fg-2">
              <p className="flex items-center gap-2 font-medium text-fg">
                <Cpu aria-hidden className="size-4 text-fg-3" />
                {system.data?.cpu.model ?? dash}
              </p>
              <p className="flex items-center gap-2">
                <MemoryStick aria-hidden className="size-4 text-fg-3" />
                {t('monitor.ram', { size: `${number((system.data?.ramBytes ?? 0) / 1024 ** 3, 0)} GB` })}
              </p>
              <p>{t('monitor.driver', { driver: gpu?.driverVersion ?? dash, cuda: gpu?.cudaVersion ?? dash })}</p>
            </Card>
          </div>
          <GpuUsers users={system.data?.otherGpuUsers} />
        </div>
      )}
    </Page>
  );
}
