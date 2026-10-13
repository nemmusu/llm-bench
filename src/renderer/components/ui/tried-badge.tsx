import { BadgeCheck, HardDrive } from 'lucide-react';
import { useI18n } from '../../i18n';
import { speedAt, type ContextBasis } from '../../lib/speed-at';
import { Badge } from './badge';
import { Tooltip } from './tooltip';

export type TriedBadgeProps = {
  /** "Tried · 142 tok/s" instead of the long form. */
  short?: boolean;
  /** Measured with the version of the file an update replaced ("provato con la versione precedente"). */
  previous?: boolean | undefined;
  size?: 'sm' | 'md';
  className?: string;
} & (
  | {
      /** Generation speed measured on this GPU. */
      tps: number;
      /** When it was measured (ISO). */
      date?: string;
      /** What it was measured on (RunSummary.decodeTokens / speedBasis): said in the tooltip. */
      tokens?: number | undefined;
      basis?: ContextBasis | undefined;
      spilled?: false;
    }
  | {
      /** Only runs that spilled to shared memory exist on this GPU: their speed does not count. */
      spilled: true;
      /** When the newest of them ran (ISO). */
      date: string;
      tps?: undefined;
      tokens?: undefined;
      basis?: undefined;
    }
);

/** "Already measured on this GPU" marker, shown before downloading or choosing a model. */
export function TriedBadge({ tps, spilled, date, tokens, basis, short, previous, size = 'md', className }: TriedBadgeProps) {
  const f = useI18n();
  const { t, number, date: fmtDate } = f;
  if (spilled) {
    return (
      <Tooltip content={t('tried.spillTooltip', { date: fmtDate(date) })}>
        <Badge tone="warning" size={size} className={className}>
          <HardDrive aria-hidden />
          {previous ? t('tried.previousSpill') : short ? t('tried.spillShort') : t('tried.spill')}
        </Badge>
      </Tooltip>
    );
  }
  const value = number(tps, 0);
  // The previous version of the file: a calmer badge that says so.
  const text = previous ? (short ? t('tried.previousShort', { tps: value }) : t('tried.previous', { tps: value })) : short ? t('tried.short', { tps: value }) : t('tried.value', { tps: value });
  const badge = (
    <Badge tone={previous ? 'outline' : 'accent'} size={size} className={className}>
      <BadgeCheck aria-hidden />
      {text}
    </Badge>
  );
  if (!date) return badge;
  // "46,0 tok/s · scrittura con 512 token già nel contesto": what the number was measured on, when known.
  const speed = tokens === undefined ? t('tried.speed', { tps: value }) : speedAt(tps, { kind: 'write', tokens, basis }, f);
  return <Tooltip content={t(previous ? 'tried.previousTooltip' : 'tried.tooltip', { date: fmtDate(date), speed })}>{badge}</Tooltip>;
}

/** The badge of a "tried here" summary: the speed of the best run, or that only runs spilling to shared memory exist. */
export function TriedHereBadge({
  tried,
  short,
  size,
  previous,
}: {
  tried: { tps?: number | undefined; date: string; spilled?: boolean | undefined; tokens?: number | undefined; basis?: ContextBasis | undefined };
  short: boolean;
  size: 'sm' | 'md';
  previous?: boolean;
}) {
  return tried.tps !== undefined ? (
    <TriedBadge tps={tried.tps} date={tried.date} tokens={tried.tokens} basis={tried.basis} short={short} size={size} previous={previous} />
  ) : (
    <TriedBadge spilled date={tried.date} short={short} size={size} previous={previous} />
  );
}
