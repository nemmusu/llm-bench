import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { HelpTip } from '../ui/help-tip';
import { ScrollX } from '../ui/scroll-x';

export interface MeasureColumn {
  /** Header with its unit, e.g. "Generazione (tok/s)". */
  label: string;
  numeric?: boolean;
  /** What the column means, behind a "?" next to its header. */
  help?: ReactNode;
  /** Long text (a configuration in words): the header and the cells wrap instead of widening the table. */
  wrap?: boolean;
}

export interface MeasureRow {
  key: string | number;
  /** The first cell is the row header. */
  cells: ReactNode[];
  /** The row being measured right now. */
  current?: boolean;
  /** Not measured yet (or not reached). */
  muted?: boolean;
}

/**
 * Dense table of measurements: units in the headers, the first column as row header, the row in
 * progress highlighted, rows still to come muted.
 */
export function MeasureTable({ caption, columns, rows, className, framed }: { caption: string; columns: readonly MeasureColumn[]; rows: readonly MeasureRow[]; className?: string; framed?: boolean }) {
  return (
    // Focusable so keyboard users can scroll a wide table.
    <ScrollX role="region" aria-label={caption} tabIndex={0} className={cn('focus-ring', framed && 'rounded-lg border border-border bg-surface', className)}>
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.label}
                scope="col"
                className={cn('h-9 border-b border-border px-3 text-xs font-medium text-fg-3 first:pl-card last:pr-card', c.wrap ? 'py-1.5' : 'whitespace-nowrap', c.numeric ? 'text-right' : 'text-left')}
              >
                {c.help ? (
                  <span className={cn('inline-flex items-center gap-1', c.numeric && 'justify-end')}>
                    {c.label}
                    <HelpTip term={c.label}>{c.help}</HelpTip>
                  </span>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} aria-current={r.current ? 'step' : undefined} className={cn(r.current && 'bg-accent-soft/60', r.muted && 'text-fg-3')}>
              {r.cells.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className={cn('h-row border-b border-border px-3 pl-card text-left font-medium', columns[0]?.wrap ? 'py-1.5' : 'whitespace-nowrap', r.current && 'shadow-[inset_3px_0_0_var(--accent)]')}>
                    {cell}
                  </th>
                ) : (
                  <td key={i} className={cn('h-row border-b border-border px-3 last:pr-card', columns[i]!.wrap ? 'py-1.5' : 'whitespace-nowrap', columns[i]!.numeric && 'text-right tabular-nums')}>
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollX>
  );
}
