import { ChartColumn, Table2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { HelpTip } from '../ui/help-tip';

export interface ChartTableData {
  columns: string[];
  rows: (string | number)[][];
  /** Indexes of numeric columns (right-aligned). */
  numeric?: number[];
}

export interface ChartCardProps {
  title: string;
  help?: ReactNode;
  /** Controls next to the title (e.g. a metric switch). */
  controls?: ReactNode;
  /** The same data as the chart, for the accessible "Show table" view. */
  table: ChartTableData;
  /** The chart itself. */
  children: ReactNode;
  className?: string;
  /** Legend or note under the chart. */
  footer?: ReactNode;
  headingLevel?: 2 | 3;
}

/** Chart container: title + "?" + controls, and a toggle between chart and data table. */
export function ChartCard({ title, help, controls, table, children, className, footer, headingLevel = 2 }: ChartCardProps) {
  const { t } = useI18n();
  const [asTable, setAsTable] = useState(false);
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <Card className={cn('flex min-w-0 flex-col', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-card pt-card">
        <div className="flex items-center gap-1.5">
          <Heading className="text-md font-semibold tracking-[-0.01em]">{title}</Heading>
          {help && <HelpTip term={title}>{help}</HelpTip>}
        </div>
        <div className="flex items-center gap-2">
          {controls}
          <Button variant="ghost" size="sm" onClick={() => setAsTable((v) => !v)}>
            {asTable ? <ChartColumn aria-hidden /> : <Table2 aria-hidden />}
            {asTable ? t('common.showChart') : t('common.showTable')}
          </Button>
        </div>
      </div>
      <div className="px-card pt-3 pb-card">
        {asTable ? <ChartTable title={title} data={table} /> : children}
        {footer && !asTable && <div className="mt-3">{footer}</div>}
      </div>
    </Card>
  );
}

function ChartTable({ title, data }: { title: string; data: ChartTableData }) {
  const { t } = useI18n();
  const numeric = new Set(data.numeric ?? []);
  return (
    // Focusable so keyboard users can scroll a long table.
    <div role="region" aria-label={t('chart.tableCaption', { title })} tabIndex={0} className="max-h-80 overflow-auto rounded-lg border border-border focus-ring">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{t('chart.tableCaption', { title })}</caption>
        <thead>
          <tr>
            {data.columns.map((c, i) => (
              <th
                key={c}
                scope="col"
                className={cn(
                  'sticky top-0 border-b border-border bg-surface-2 px-3 py-2 text-xs font-medium text-fg-3',
                  numeric.has(i) ? 'text-right' : 'text-left',
                )}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td
                  key={i}
                  className={cn('border-b border-border px-3 py-1.5', numeric.has(i) && 'text-right tabular-nums')}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Legend entry: a short line or square key in the series color, label in text tokens. */
export function LegendKey({ color, label, shape = 'line' }: { color: string; label: string; shape?: 'line' | 'square' }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-fg-2">
      <span
        aria-hidden
        className={shape === 'line' ? 'h-0.5 w-3.5 rounded-full' : 'size-2.5 rounded-xs'}
        style={{ background: color }}
      />
      {label}
    </span>
  );
}
