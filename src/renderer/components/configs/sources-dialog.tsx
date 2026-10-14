/** "n test": the tests behind a configuration, each with its own numbers where the table compares and a link to it. */
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { ConfigEntry, ConfigSource } from '../../../contract/configs';
import { useI18n } from '../../i18n';
import { notMeasuredAt } from '../../lib/speed-at';
import { MIB_PER_GB, summaryModelLabel } from '../bench/format';
import { configLabelOf } from '../presets/config-label';
import { tokensShort } from '../presets/format';
import { columnHelper, DataTable, type DataTableColumn } from '../ui/data-table';
import { Dialog, DialogContent } from '../ui/dialog';
import { AT_MAX, pointFor, type CompareAt } from './depths';
import { configEngineLabel } from './engine-label';
import { NUMERIC, UnitHeader } from './unit-header';

export interface SourcesDialogProps {
  entry: ConfigEntry | undefined;
  /** The "Confronta a" of the table: a depth, or each test at its own largest context with the context full. */
  at: CompareAt;
  onOpenChange: (open: boolean) => void;
}

export function SourcesDialog({ entry, at, onOpenChange }: SourcesDialogProps) {
  const f = useI18n();
  const { t, number, integer, dateTime } = f;
  const sources = useMemo(() => entry?.sources ?? [], [entry]);
  const columns = useMemo(() => {
    const col = columnHelper<ConfigSource>();
    const point = (s: ConfigSource) => pointFor(s, at);
    const any = (pick: (s: ConfigSource) => unknown) => sources.some((s) => pick(s) !== undefined);
    const dash = <span className="text-fg-3">–</span>;
    const numeric = (id: string, header: string, pick: (s: ConfigSource) => number | undefined, show: (v: number) => string, missing?: (s: ConfigSource) => string | undefined): DataTableColumn<ConfigSource> =>
      col.accessor(pick, {
        id,
        header: () => <UnitHeader text={header} />,
        meta: NUMERIC,
        sortUndefined: 'last',
        cell: (c) => {
          const v = c.getValue();
          if (v !== undefined) return show(v);
          const why = missing?.(c.row.original);
          return why ? <span className="text-xs text-fg-3 italic">{why}</span> : dash;
        },
      });
    // Contesto massimo: a test whose largest context was never filled says so.
    const notFull = (s: ConfigSource) => (at === AT_MAX && s.contextSize !== undefined ? notMeasuredAt(s.contextSize, f) : undefined);
    const list: DataTableColumn<ConfigSource>[] = [
      col.accessor('date', {
        header: t('configs.sources.test'),
        cell: (c) => {
          const s = c.row.original;
          return (
            <span className="flex flex-col leading-5">
              <Link to="/results/$runId" params={{ runId: s.runId }} className="self-start rounded-xs font-medium text-fg hover:text-accent-text focus-ring">
                {dateTime(c.getValue())}
              </Link>
              <span className="text-xs text-fg-3">
                {t(`benchmark.profiles.${s.profile}`)}
                {s.combo !== undefined ? ` · ${t('presets.combo', { n: s.combo + 1 })}` : ''}
              </span>
            </span>
          );
        },
      }),
      numeric(
        'decode',
        at === AT_MAX ? t('configs.sources.decodeAtMax') : t('configs.sources.decodeAt', { depth: tokensShort(at, f) }),
        (s) => point(s)?.decodeTps,
        (v) => number(v, 1),
        notFull,
      ),
    ];
    if (any((s) => point(s)?.prefillTps)) list.push(numeric('prefill', t('configs.columns.prefill'), (s) => point(s)?.prefillTps, integer));
    if (any((s) => point(s)?.ttftMs)) list.push(numeric('ttft', t('configs.columns.ttft'), (s) => point(s)?.ttftMs, integer));
    if (any((s) => s.contextSize)) list.push(numeric('context', t('configs.columns.context'), (s) => s.contextSize, integer));
    if (any((s) => s.vramPeakMiB)) list.push(numeric('vram', t('configs.columns.vram'), (s) => s.vramPeakMiB, (v) => number(v / MIB_PER_GB, 1)));
    if (any((s) => s.parallel)) {
      list.push(
        col.accessor((s) => s.parallel?.users, {
          id: 'parallel',
          header: () => <UnitHeader text={t('configs.columns.parallel')} />,
          meta: NUMERIC,
          sortUndefined: 'last',
          cell: (c) => {
            if (c.getValue() === undefined) return dash;
            const p = c.row.original.parallel!;
            const each = p.perUserTps !== undefined ? `${t('configs.perUser', { tps: integer(p.perUserTps) })} · ` : '';
            return (
              <span className="flex flex-col items-end leading-5">
                <span>{t('results.users', { n: p.users })}</span>
                <span className="text-xs text-fg-3">{`${each}${t('configs.total', { tps: integer(p.totalTps) })}`}</span>
              </span>
            );
          },
        }),
      );
    }
    return list;
  }, [sources, at, f, t, number, integer, dateTime]);

  const title = t('configs.sources.title');
  return (
    <Dialog open={entry !== undefined} onOpenChange={onOpenChange}>
      {entry && (
        <DialogContent
          size="xl"
          title={title}
          description={[
            summaryModelLabel({ modelName: entry.model.name, quant: entry.model.quant }),
            configEngineLabel(entry),
            configLabelOf(entry.engineKind, entry.params, f, { tags: entry.tags }).text,
          ].join(' · ')}
        >
          <div className="overflow-hidden rounded-lg border border-border">
            <DataTable caption={title} columns={columns} data={sources} getRowId={(s) => `${s.runId}:${s.combo ?? ''}`} initialSorting={[{ id: 'date', desc: true }]} />
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
