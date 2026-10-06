import { Activity, Zap } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useGpuSnapshot, useMainGpu } from '../../lib/queries-library';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card';
import { RadialGauge } from '../ui/radial-gauge';
import { Skeleton } from '../ui/skeleton';
import { StatusDot } from '../ui/status-dot';

/** "Your GPU" card with live VRAM, temperature, power and utilization (real readings, every second). */
export function GpuCard() {
  const { t, number, integer } = useI18n();
  const gpu = useMainGpu();
  const sample = useGpuSnapshot(1000).data?.[0];
  const totalGb = (gpu?.memoryTotalMiB ?? sample?.memTotalMiB ?? 1) / 1024;
  const usedGb = (sample?.memUsedMiB ?? 0) / 1024;
  const dash = (v: number | null | undefined, fmt: (n: number) => string) => (v === null || v === undefined ? '–' : fmt(v));
  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-0.5">
          <CardTitle>{t('benchmark.gpu.title')}</CardTitle>
          {gpu ? (
            <CardDescription className="truncate">
              {gpu.name.replace('NVIDIA GeForce ', '')} ·{' '}
              {t('benchmark.gpu.detail', { vram: `${integer(totalGb)} GB`, driver: gpu.driverVersion ?? '–' })}
            </CardDescription>
          ) : (
            <Skeleton className="h-4 w-40" />
          )}
        </div>
        <Badge tone="success" size="sm">
          <StatusDot tone="success" pulse />
          {t('benchmark.gpu.live')}
        </Badge>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 pt-4">
        <RadialGauge
          size={124}
          value={usedGb}
          max={totalGb}
          label={t('metrics.vram.label')}
          help={t('metrics.vram.help')}
          unit="GB"
          caption={`${t('common.of')} ${number(totalGb, 1)} GB`}
          format={(v) => number(v, 1)}
          warnAt={0.85}
          dangerAt={0.95}
        />
        <RadialGauge
          size={124}
          value={sample?.tempC ?? 0}
          max={100}
          label={t('metrics.temp.label')}
          help={t('metrics.temp.help')}
          unit="°C"
          format={(v) => integer(v)}
          warnAt={0.8}
          dangerAt={0.88}
        />
      </CardContent>
      <CardFooter className="justify-between text-xs tabular-nums">
        <span className="inline-flex items-center gap-1.5">
          <Zap aria-hidden className="size-3.5 text-fg-3" />
          {t('metrics.power.label')} <b className="font-semibold text-fg">{dash(sample?.powerW, (w) => `${integer(w)} W`)}</b>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Activity aria-hidden className="size-3.5 text-fg-3" />
          {t('metrics.util.label')} <b className="font-semibold text-fg">{dash(sample?.utilPct, (u) => `${integer(u)}%`)}</b>
        </span>
      </CardFooter>
    </Card>
  );
}
