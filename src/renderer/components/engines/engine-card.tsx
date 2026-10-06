import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Card } from '../ui/card';
import { StatusDot, type StatusDotProps } from '../ui/status-dot';

export interface EngineCardProps {
  icon: ReactNode;
  title: string;
  description: string;
  badge?: ReactNode;
  status: { tone: StatusDotProps['tone']; text: string };
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** Common frame of the engine cards: identity and status on top, details, actions at the bottom. */
export function EngineCard({ icon, title, description, badge, status, children, footer, className }: EngineCardProps) {
  const id = useId();
  return (
    <Card role="region" aria-labelledby={id} className={cn('flex flex-col', className)}>
      <div className="flex items-start gap-4 p-card">
        <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text [&_svg]:size-5">
          {icon}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={id} className="text-md font-semibold">
              {title}
            </h2>
            {badge}
          </div>
          <p className="text-sm text-fg-2">{description}</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-2 text-sm text-fg-2">
          <StatusDot tone={status.tone} />
          {status.text}
        </span>
      </div>
      {children && <div className="flex flex-col gap-3 px-card pb-card">{children}</div>}
      {footer && <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border px-card py-3">{footer}</div>}
    </Card>
  );
}
