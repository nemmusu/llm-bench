import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { useMoreAtEnd } from '../../lib/use-more-at-end';

export interface DataTableColumnMeta {
  /** Right-align and use tabular figures (numbers). */
  numeric?: boolean;
  /** Extra classes for header and cells of this column. */
  className?: string;
  /**
   * Stays in sight at the right edge while the rest scrolls sideways (a row's actions). While columns
   * hide under it, a shadow and a fade beside it say there is more.
   */
  stickyEnd?: boolean;
  /**
   * Takes the room the other columns leave, its text cut with "…" instead of widening the table (long
   * names). Give it a min width in `className`: kept when the table scrolls on a narrow window.
   */
  fill?: boolean;
}

/** The sticky end column: opaque; a shadow and a fade on its left edge only while columns hide under it. */
const STICKY_END = cn(
  'sticky right-0 bg-surface group-hover:bg-surface-2',
  "before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-10 before:bg-linear-to-l before:from-surface before:to-transparent before:opacity-0 before:content-[''] group-hover:before:from-surface-2",
  'group-data-[more=end]/table:shadow-[-12px_0_12px_-12px_rgb(0_0_0/0.25)] group-data-[more=end]/table:before:opacity-100 dark:group-data-[more=end]/table:shadow-[-12px_0_12px_-12px_rgb(0_0_0/0.8)]',
);
const FILL = 'w-full max-w-0';

export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
  columnMeta: {} as DataTableColumnMeta,
});

export type DataTableFeatures = typeof dataTableFeatures;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- columns hold heterogeneous value types
export type DataTableColumn<T extends RowData> = ColumnDef<DataTableFeatures, T, any>;

/** Typed column builder for {@link DataTable}. */
export function columnHelper<T extends RowData>() {
  return createColumnHelper<DataTableFeatures, T>();
}

export interface DataTableProps<T extends RowData> {
  columns: DataTableColumn<T>[];
  data: T[];
  /** Visually hidden caption: tells screen readers what the table is. */
  caption: string;
  initialSorting?: SortingState;
  /** Row activation (click or Enter on the row's first link/button stays the keyboard path). */
  onRowClick?: (row: T) => void;
  className?: string;
  /** Stable row id (defaults to index). */
  getRowId?: (row: T, index: number) => string;
}

/** Sortable, dense, accessible table built on TanStack Table. */
export function DataTable<T extends RowData>({ columns, data, caption, initialSorting = [], onRowClick, className, getRowId }: DataTableProps<T>) {
  const { t } = useI18n();
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    state: { sorting },
    onSortingChange: setSorting,
    // Clicking a header flips between ascending and descending; a table never loses its order.
    enableSortingRemoval: false,
    ...(getRowId ? { getRowId } : {}),
  });
  const rows = table.getRowModel().rows;
  const scroller = useRef<HTMLDivElement>(null);
  const more = useMoreAtEnd(scroller);

  return (
    <div ref={scroller} data-more={more ? 'end' : undefined} className={cn('group/table overflow-x-auto', className)}>
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const meta = header.column.columnDef.meta;
                const sorted = header.column.getIsSorted();
                const canSort = header.column.getCanSort();
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    className={cn(
                      'sticky top-0 z-[1] h-9 border-b border-border bg-surface px-3 text-xs font-medium whitespace-nowrap text-fg-3 first:pl-card last:pr-card',
                      meta?.numeric ? 'text-right' : 'text-left',
                      meta?.stickyEnd && STICKY_END,
                      meta?.fill && FILL,
                      meta?.className,
                    )}
                  >
                    {/* No column groups in LLM Bench tables, so there are no placeholder headers. */}
                    {canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        title={sorted === 'asc' ? t('table.sortDescending') : t('table.sortAscending')}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-xs hover:text-fg focus-ring',
                          meta?.numeric && 'flex-row-reverse',
                          sorted && 'text-fg',
                        )}
                      >
                        <table.FlexRender header={header} />
                        {sorted === 'asc' ? (
                          <ArrowUp aria-hidden className="size-3.5" />
                        ) : sorted === 'desc' ? (
                          <ArrowDown aria-hidden className="size-3.5" />
                        ) : (
                          <ChevronsUpDown aria-hidden className="size-3.5 opacity-50" />
                        )}
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-card py-8 text-center text-fg-3">
                {t('table.noRows')}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                className={cn('group transition-colors hover:bg-surface-2', onRowClick && 'cursor-pointer')}
              >
                {row.getAllCells().map((cell) => {
                  const meta = cell.column.columnDef.meta;
                  return (
                    <td
                      key={cell.id}
                      className={cn(
                        'h-row border-b border-border px-3 whitespace-nowrap text-fg first:pl-card last:pr-card group-last:border-b-0',
                        meta?.numeric && 'text-right tabular-nums',
                        meta?.stickyEnd && STICKY_END,
                        meta?.fill && FILL,
                        meta?.className,
                      )}
                    >
                      <table.FlexRender cell={cell} />
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
