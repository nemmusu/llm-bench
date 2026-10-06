import { useCallback } from 'react';
import { sparkAreaOption } from '../components/charts/builders';
import { ChartCard } from '../components/charts/chart-card';
import { EChart } from '../components/charts/echart';
import type { ChartTokens } from '../components/charts/echarts';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Card, CardHeader, CardTitle } from '../components/ui/card';
import { HelpTip } from '../components/ui/help-tip';
import { StatTile } from '../components/ui/stat-tile';
import { StatusDot } from '../components/ui/status-dot';
import { useI18n } from '../i18n';
import { useSystem } from '../lib/queries';
import { useMockGpuLive } from '../mock/gpu-live';
import type { Sample } from '../mock/telemetry';

function LiveChart({ title, history, pick, format, max }: { title: string; history: Sample[]; pick: (s: Sample) => number; format: (v: number) => string; max?: number }) {
  const { t, duration } = useI18n();
  const build = useCallback(
    (tk: ChartTokens) =>
      sparkAreaOption(
        tk,
        history.map((s) => s.t),
        history.map(pick),
        { name: title, format, ...(max === undefined ? {} : { max }) },
      ),
    [history, pick, format, max, title],
  );
  const last = history[history.length - 1]?.t ?? 0;
  return (
    <ChartCard
      title={title}
      table={{
        columns: [t('chart.time'), title],
        numeric: [1],
        rows: history.filter((_, i) => i % 15 === 0).map((s) => [`-${duration((last - s.t) * 1000)}`, format(pick(s))]),
      }}
    >
      <EChart build={build} height={150} label={title} />
    </ChartCard>
  );
}

const pickUtil = (s: Sample) => s.utilPct;
const pickVram = (s: Sample) => s.memUsedMiB / 1024;
const pickPower = (s: Sample) => s.powerW;
const pickTemp = (s: Sample) => s.tempC;

/** Live GPU telemetry and who is using the GPU. */
export function MonitorPage() {
  const { t, number, integer } = useI18n();
  const system = useSystem();
  const { current, history } = useMockGpuLive();
  const gpu = system.data?.gpus[0];
  const fmtPct = useCallback((v: number) => `${integer(v)} %`, [integer]);
  const fmtGb = useCallback((v: number) => `${number(v, 1)} GB`, [number]);
  const fmtW = useCallback((v: number) => `${integer(v)} W`, [integer]);
  const fmtC = useCallback((v: number) => `${integer(v)} °C`, [integer]);
  return (
    <Page
      title={t('monitor.title')}
      subtitle={t('monitor.subtitle')}
      width="wide"
      actions={
        <Badge tone="success">
          <StatusDot tone="success" pulse />
          {gpu?.name ?? '–'}
        </Badge>
      }
    >
      <div className="flex flex-col gap-section">
        <section aria-label={t('run.live')} className="grid gap-4 sm:grid-cols-3 xl:grid-cols-6">
          <StatTile label={t('metrics.util.label')} help={t('metrics.util.help')} value={integer(current.utilPct)} unit="%" />
          <StatTile label={t('metrics.vram.label')} help={t('metrics.vram.help')} value={number(current.memUsedMiB / 1024, 1)} unit="GB" hint={`${t('common.of')} ${number((gpu?.memoryTotalMiB ?? 0) / 1024, 1)} GB`} />
          <StatTile label={t('metrics.power.label')} help={t('metrics.power.help')} value={integer(current.powerW)} unit="W" hint={`${t('common.of')} ${gpu?.powerLimitW ?? '–'} W`} />
          <StatTile label={t('metrics.temp.label')} help={t('metrics.temp.help')} value={integer(current.tempC)} unit="°C" />
          <StatTile label={t('metrics.clock.label')} help={t('metrics.clock.help')} value={integer(current.smClockMHz)} unit="MHz" />
          <StatTile label={t('monitor.pcie')} value={`${gpu?.pcieGenMax ?? '–'}.0`} unit={`x${gpu?.pcieWidthMax ?? '–'}`} />
        </section>
        <div className="grid gap-section lg:grid-cols-2">
          <LiveChart title={t('monitor.chartUtil')} history={history} pick={pickUtil} format={fmtPct} max={100} />
          <LiveChart title={t('monitor.chartVram')} history={history} pick={pickVram} format={fmtGb} max={32} />
          <LiveChart title={t('monitor.chartPower')} history={history} pick={pickPower} format={fmtW} max={600} />
          <LiveChart title={t('monitor.chartTemp')} history={history} pick={pickTemp} format={fmtC} max={100} />
        </div>
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-1.5">
              <CardTitle>{t('monitor.users')}</CardTitle>
              <HelpTip term={t('monitor.users')}>{t('monitor.usersHelp')}</HelpTip>
            </div>
          </CardHeader>
          <ul className="divide-y divide-border border-t border-border">
            {(system.data?.otherGpuUsers ?? []).map((u) => (
              <li key={u.pid} className="flex items-center gap-3 px-card py-3 text-sm">
                <span className="font-mono font-medium text-fg">{u.name}</span>
                <span className="text-fg-3 tabular-nums">PID {u.pid}</span>
                {u.knownLlm && (
                  <Badge tone="info" size="sm">
                    {t('monitor.knownLlm')}
                  </Badge>
                )}
                <span className="ml-auto text-xs text-fg-3">{t('monitor.notOurs')}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </Page>
  );
}
