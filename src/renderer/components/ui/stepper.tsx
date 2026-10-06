import { Check, Minus } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type StepState = 'done' | 'current' | 'pending' | 'skipped';

export interface StepItem {
  id: string;
  label: string;
  state: StepState;
  icon?: ReactNode;
}

export interface StepperProps {
  steps: readonly StepItem[];
  /** Accessible name of the list, e.g. "Test phases". */
  label: string;
  /** Screen-reader text for each state, e.g. { done: "Completed", … }. */
  stateLabels: Record<StepState, string>;
  className?: string;
  size?: 'sm' | 'md';
}

/** Horizontal progress through ordered phases; the current one has aria-current="step". */
export function Stepper({ steps, label, stateLabels, className, size = 'md' }: StepperProps) {
  const dot = size === 'sm' ? 'size-6' : 'size-7';
  return (
    <ol aria-label={label} className={cn('flex w-full items-start', className)}>
      {steps.map((s, i) => {
        const prevDone = i > 0 && (steps[i - 1]!.state === 'done' || steps[i - 1]!.state === 'skipped');
        return (
          <li
            key={s.id}
            aria-current={s.state === 'current' ? 'step' : undefined}
            className="relative flex min-w-0 flex-1 flex-col items-center gap-2 text-center"
          >
            {i > 0 && (
              <span
                aria-hidden
                className={cn(
                  'absolute top-[13px] right-[calc(50%+18px)] left-[calc(-50%+18px)] h-0.5 rounded-full',
                  size === 'sm' && 'top-[11px]',
                  prevDone ? 'bg-accent' : 'bg-border-strong',
                )}
              />
            )}
            <span
              aria-hidden
              className={cn(
                'relative z-10 grid shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors [&_svg]:size-3.5',
                dot,
                s.state === 'done' && 'bg-accent-solid text-accent-fg',
                s.state === 'current' && 'bg-surface text-accent-text ring-2 ring-accent shadow-[0_0_0_5px_var(--accent-soft)]',
                s.state === 'pending' && 'bg-surface text-fg-3 ring-1 ring-border-strong',
                s.state === 'skipped' && 'bg-surface-3 text-fg-3',
              )}
            >
              {s.state === 'done' ? (
                <Check strokeWidth={3} />
              ) : s.state === 'skipped' ? (
                <Minus strokeWidth={3} />
              ) : s.state === 'current' ? (
                <span className="relative grid size-2.5 place-items-center">
                  <span className="absolute inset-0 rounded-full bg-accent animate-ping-soft" />
                  <span className="size-2.5 rounded-full bg-accent" />
                </span>
              ) : (
                (s.icon ?? i + 1)
              )}
            </span>
            <span
              className={cn(
                'px-1 text-xs leading-4 font-medium text-balance',
                s.state === 'current' ? 'text-fg' : s.state === 'done' ? 'text-fg-2' : 'text-fg-3',
              )}
            >
              {s.label}
              <span className="sr-only">: {stateLabels[s.state]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
