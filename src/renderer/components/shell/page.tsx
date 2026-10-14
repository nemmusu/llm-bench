import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * How wide a page grows (the window's content panel, sidebar excluded):
 *   - "text": forms and settings, read top to bottom (lines stay short enough to read);
 *   - "default": pages of cards (engines, a model, starting a server): they fill a normal window and stop
 *     before a full-screen one turns them into long thin lines;
 *   - "wide": dashboards (a live run, monitor, models, servers): all of a full-screen window;
 *   - "full": wide tables whose columns use every pixel of a large screen (Risultati, Confronta), no limit.
 * "narrow" is the old name of "text".
 */
export type PageWidth = 'text' | 'default' | 'wide' | 'full' | 'narrow';

export interface PageProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right side of the header (primary page actions). */
  actions?: ReactNode;
  /** Small line above the title (back link, breadcrumb, status). */
  eyebrow?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Max content width (see {@link PageWidth}). */
  width?: PageWidth;
}

export const PAGE_WIDTHS: Record<PageWidth, string> = {
  text: 'max-w-[960px]',
  narrow: 'max-w-[960px]',
  default: 'max-w-[1600px]',
  wide: 'max-w-[2200px]',
  full: 'max-w-none',
};

/**
 * Standard page frame: one h1, subtitle, actions, consistent gutters. It is a size container named
 * "page": what is inside lays out on the room the page really has (the sidebar takes part of the
 * window) with `@4xl/page:`, `@5xl/page:`… rather than on the window's width (`lg:`, `xl:`).
 * {@link PageSplit} does it for a main column with side cards.
 */
export function Page({ title, subtitle, actions, eyebrow, children, className, width = 'default' }: PageProps) {
  return (
    <div className={cn('@container/page mx-auto w-full px-8 pt-7 pb-12 compact:px-6 compact:pt-5', PAGE_WIDTHS[width], className)}>
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

export interface PageSplitProps {
  /** The main column. */
  children: ReactNode;
  /** Side cards: at the right while the page has 64rem (1024 px) of content, below the main column when less. */
  aside: ReactNode;
  /** Width of the side column in px (default 320). */
  asideWidth?: number;
  className?: string;
}

/**
 * A main column and side cards: side by side when the page has room (64rem of content, a window of
 * about 1320 px with the sidebar open), the side cards below when it has not, so the main column is
 * never squeezed.
 */
export function PageSplit({ children, aside, asideWidth = 320, className }: PageSplitProps) {
  return (
    <div
      className={cn('grid grid-cols-1 items-start gap-section @5xl/page:grid-cols-[minmax(0,1fr)_var(--page-aside)]', className)}
      style={{ '--page-aside': `${asideWidth}px` } as CSSProperties}
    >
      <div className="flex min-w-0 flex-col gap-section">{children}</div>
      {/* Not an <aside>: a complementary landmark inside <main> is an axe violation. As tall as the main
          column, so a side card can follow the scroll (sticky). */}
      <div className="flex min-w-0 flex-col gap-section self-stretch">{aside}</div>
    </div>
  );
}
