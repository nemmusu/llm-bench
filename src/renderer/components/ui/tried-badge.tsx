import { BadgeCheck } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Badge } from './badge';
import { Tooltip } from './tooltip';

export interface TriedBadgeProps {
  /** Generation speed measured on this GPU. */
  tps: number;
  /** When it was measured (ISO). */
  date?: string;
  /** "Tried · 142 tok/s" instead of the long form. */
  short?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

/** "Already measured on this GPU" marker, shown before downloading or choosing a model. */
export function TriedBadge({ tps, date, short, size = 'md', className }: TriedBadgeProps) {
  const { t, number, date: fmtDate } = useI18n();
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
