import { CircleCheck, CircleDashed, CircleX, TriangleAlert, Check } from 'lucide-react';
import type { FitLevel } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { Badge } from './badge';
import { Tooltip } from './tooltip';

const looks: Record<FitLevel, { tone: 'success' | 'warning' | 'danger'; Icon: typeof Check }> = {
  perfect: { tone: 'success', Icon: CircleCheck },
  good: { tone: 'success', Icon: Check },
  tight: { tone: 'warning', Icon: TriangleAlert },
  partial: { tone: 'warning', Icon: CircleDashed },
  no: { tone: 'danger', Icon: CircleX },
};

export interface FitBadgeProps {
  level: FitLevel;
  /** Extra line in the tooltip, e.g. "Estimate: 6.8 GB of 30.4 GB available". */
  detail?: string;
  size?: 'sm' | 'md';
  className?: string;
}

/** "Does it fit in VRAM?" verdict: icon + words + color, with a plain explanation on hover. */
export function FitBadge({ level, detail, size = 'md', className }: FitBadgeProps) {
  const { t } = useI18n();
  const { tone, Icon } = looks[level];
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-1">
          <span>{t(`fit.hint.${level}`)}</span>
          {detail && <span className="text-fg-3">{detail}</span>}
        </span>
      }
    >
      <Badge tone={tone} size={size} className={className} data-fit={level}>
        <Icon aria-hidden />
        {t(`fit.${level}`)}
      </Badge>
    </Tooltip>
  );
}
