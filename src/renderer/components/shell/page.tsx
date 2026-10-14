import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface PageProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right side of the header (primary page actions). */
  actions?: ReactNode;
  /** Small line above the title (back link, breadcrumb, status). */
  eyebrow?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Max content width; wide pages (tables, dashboards) use "wide". */
  width?: 'default' | 'wide' | 'narrow' | 'full';
}

/** "full": the whole window, for wide tables whose columns use every pixel of a large screen (Risultati, Confronta). */
const widths = { default: 'max-w-[1240px]', wide: 'max-w-[1440px]', narrow: 'max-w-[880px]', full: 'max-w-none' } as const;

/** Standard page frame: one h1, subtitle, actions, consistent gutters. */
export function Page({ title, subtitle, actions, eyebrow, children, className, width = 'default' }: PageProps) {
  return (
    <div className={cn('mx-auto w-full px-8 pt-7 pb-12 compact:px-6 compact:pt-5', widths[width], className)}>
      <header className="mb-section flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          {eyebrow}
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-fg">{title}</h1>
          {subtitle && <p className="text-md text-fg-2">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
