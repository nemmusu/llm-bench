import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './button';

export type CalloutTone = 'info' | 'warning' | 'danger' | 'success';

const tones: Record<CalloutTone, { box: string; icon: string; Icon: typeof Info }> = {
  info: { box: 'border-info/25 bg-info-soft', icon: 'text-info-text', Icon: Info },
  warning: { box: 'border-warning/30 bg-warning-soft', icon: 'text-warning-text', Icon: TriangleAlert },
  danger: { box: 'border-danger/30 bg-danger-soft', icon: 'text-danger-text', Icon: CircleAlert },
  success: { box: 'border-success/30 bg-success-soft', icon: 'text-success-text', Icon: CircleCheck },
};

export interface CalloutProps {
  tone?: CalloutTone;
  title: ReactNode;
  children?: ReactNode;
  /** The "what to do" button: every warning offers a way forward. */
  action?: { label: string; onClick: () => void };
  className?: string;
}

/** Inline message with icon + title (never color alone) and an optional action. */
export function Callout({ tone = 'info', title, children, action, className }: CalloutProps) {
  const { box, icon, Icon } = tones[tone];
  return (
    // Container query: the action sits on the right when there is room, under the text otherwise.
    <div role="note" className={cn('@container rounded-lg border', box, className)}>
      <div className="flex items-start gap-3 px-4 py-3">
        <Icon aria-hidden className={cn('mt-0.5 size-[18px] shrink-0', icon)} />
        <div className="flex min-w-0 flex-1 flex-col gap-2 @xl:flex-row @xl:items-start @xl:gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-sm font-semibold text-fg">{title}</p>
            {children && <div className="text-sm text-fg-2">{children}</div>}
          </div>
          {action && (
            <Button size="sm" variant="secondary" className="shrink-0 self-start" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
