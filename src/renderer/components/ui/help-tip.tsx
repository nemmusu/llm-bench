import { CircleQuestionMark } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { Tooltip } from './tooltip';

export interface HelpTipProps {
  /** The term being explained, used in the accessible name ("What is “Generation”?"). */
  term: string;
  /** Plain-language explanation. */
  children: ReactNode;
  className?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * A small "?" next to a metric. Opens on hover, focus or click (beginners click), so the
 * explanation is reachable with mouse, keyboard and touch.
 */
export function HelpTip({ term, children, className, side = 'top' }: HelpTipProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Tooltip content={children} open={open} onOpenChange={setOpen} side={side} className="max-w-80 text-sm leading-5">
      <button
        type="button"
        aria-label={t('common.whatIsThis', { name: term })}
        onClick={() => setOpen(true)}
        className={cn(
          'inline-grid size-5 shrink-0 place-items-center rounded-full text-fg-3 transition-colors hover:bg-surface-3 hover:text-fg focus-ring',
          className,
        )}
      >
        <CircleQuestionMark aria-hidden className="size-3.5" />
      </button>
    </Tooltip>
  );
}
