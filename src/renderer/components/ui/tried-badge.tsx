import { BadgeCheck, HardDrive } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Badge } from './badge';
import { Tooltip } from './tooltip';

export type TriedBadgeProps = {
  /** "Tried · 142 tok/s" instead of the long form. */
  short?: boolean;
  size?: 'sm' | 'md';
  className?: string;
} & (
  | {
      /** Generation speed measured on this GPU. */
      tps: number;
      /** When it was measured (ISO). */
      date?: string;
      spilled?: false;
    }
  | {
      /** Only runs that spilled to shared memory exist on this GPU: their speed does not count. */
      spilled: true;
      /** When the newest of them ran (ISO). */
      date: string;
      tps?: undefined;
    }
);

/** "Already measured on this GPU" marker, shown before downloading or choosing a model. */
export function TriedBadge({ tps, spilled, date, short, size = 'md', className }: TriedBadgeProps) {
  const { t, number, date: fmtDate } = useI18n();
  if (spilled) {
    return (
      <Tooltip content={t('tried.spillTooltip', { date: fmtDate(date) })}>
        <Badge tone="warning" size={size} className={className}>
          <HardDrive aria-hidden />
          {short ? t('tried.spillShort') : t('tried.spill')}
        </Badge>
      </Tooltip>
    );
  }
  const value = number(tps, 0);
  const badge = (
    <Badge tone="accent" size={size} className={className}>
      <BadgeCheck aria-hidden />
      {short ? t('tried.short', { tps: value }) : t('tried.value', { tps: value })}
    </Badge>
  );
  if (!date) return badge;
  return <Tooltip content={t('tried.tooltip', { date: fmtDate(date), tps: value })}>{badge}</Tooltip>;
}

/** The badge of a "tried here" summary: the speed of the best run, or that only runs spilling to shared memory exist. */
export function TriedHereBadge({ tried, short, size }: { tried: { tps?: number | undefined; date: string; spilled?: boolean | undefined }; short: boolean; size: 'sm' | 'md' }) {
  return tried.tps !== undefined ? <TriedBadge tps={tried.tps} date={tried.date} short={short} size={size} /> : <TriedBadge spilled date={tried.date} short={short} size={size} />;
}
