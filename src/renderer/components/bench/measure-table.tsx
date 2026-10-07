import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface MeasureColumn {
  /** Header with its unit, e.g. "Generazione (tok/s)". */
  label: string;
  numeric?: boolean;
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
    <div className={cn('overflow-x-auto', framed && 'rounded-lg border border-border bg-surface', className)}>
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.label}
                scope="col"
                className={cn('h-9 border-b border-border px-3 text-xs font-medium whitespace-nowrap text-fg-3 first:pl-card last:pr-card', c.numeric ? 'text-right' : 'text-left')}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} aria-current={r.current ? 'step' : undefined} className={cn(r.current && 'bg-accent-soft/60', r.muted && 'text-fg-3')}>
              {r.cells.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className={cn('h-row border-b border-border px-3 pl-card text-left font-medium whitespace-nowrap', r.current && 'shadow-[inset_3px_0_0_var(--accent)]')}>
                    {cell}
                  </th>
                ) : (
                  <td key={i} className={cn('h-row border-b border-border px-3 whitespace-nowrap last:pr-card', columns[i]!.numeric && 'text-right tabular-nums')}>
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
