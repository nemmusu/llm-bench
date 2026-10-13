import { ArrowDown, ArrowUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import type { RunResult, TuneCombination } from '../../../contract/results';
import { useI18n, type Formatters, type MessageKey } from '../../i18n';
import { cn } from '../../lib/cn';
import { UsersTable } from '../bench/concurrency-users';
import { SweepTable } from '../bench/context-sweep';
import { MIB_PER_GB } from '../bench/format';
import { entryOfRun } from '../compare/compare-entries';
import { CompareToggle } from '../compare/compare-tray';
import { headerAt } from '../../lib/speed-at';
import { PresetActions } from '../presets/preset-actions';
import { useConfigLabel } from '../presets/config-label';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { CodeBlock } from '../ui/code-block';
import { HelpTip } from '../ui/help-tip';
import { SegmentedControl } from '../ui/segmented-control';
import { comboText, depthLabel } from './tune-format';
import { PartialBadge, TuneGlossary } from './tune-sections';
import { bestValues, CONTEXT_COLUMNS, reaches as reachesRow, sortRows, type MetricColumn, type RankRow, type SortDir } from './tune-logic';

type F = Pick<Formatters, 't' | 'number' | 'integer'>;

/** How a metric column looks: its header (with the unit) and its numbers. */
export interface ColumnView {
  column: MetricColumn;
  header: MessageKey;
  format: (v: number, f: F) => string;
  /** Tooltip of a cell (e.g. the exact token count behind "32K"). */
  title?: (v: number, f: F) => string;
}

/** The columns of a one-user search: largest context, generation, prompt reading, first token, peak VRAM. */
export const CONTEXT_VIEWS: readonly ColumnView[] = [
  { column: CONTEXT_COLUMNS[0]!, header: 'tune.columns.maxContext', format: (v, f) => depthLabel(v, f), title: (v, f) => `${f.integer(v)} ${f.t('results.tokens')}` },
  { column: CONTEXT_COLUMNS[1]!, header: 'tune.columns.decode', format: (v, f) => f.number(v, 1) },
  { column: CONTEXT_COLUMNS[2]!, header: 'tune.columns.prefill', format: (v, f) => f.integer(v) },
  { column: CONTEXT_COLUMNS[3]!, header: 'tune.columns.ttft', format: (v, f) => f.number(v / 1000, 2) },
  { column: CONTEXT_COLUMNS[4]!, header: 'tune.columns.vram', format: (v, f) => f.number(v / MIB_PER_GB, 1) },
];

export interface RankingProps {
  run: RunResult & { tuning: NonNullable<RunResult['tuning']> };
  rows: readonly RankRow[];
  /** The compared depth (goal "Un utente"); absent for goal "Più utenti". */
  depth?: number | undefined;
  depths: readonly number[];
  /** What the order means and how to read it (default: ranked by generation at the compared depth). */
  subtitle?: string;
  /** Accessible name of the table (default: the ranking at the compared depth). */
  caption?: string;
  /** A new compared depth (needed with more than one depth). */
  onDepth?: (depth: number) => void;
  recommended: number | undefined;
  /** The metric columns, in order (default: the one-user context search). */
  views?: readonly ColumnView[];
}

/**
 * "Classifica": one row per measured combination, ranked by generation speed at the compared depth;
 * any column can sort; those that stop earlier sit greyed at the bottom. Every row opens its
 * measurements and the exact command, and has the preset actions.
 */
export function TuneRanking({ run, rows, depth, depths, onDepth, recommended, views = CONTEXT_VIEWS, subtitle, caption }: RankingProps) {
  const f = useI18n();
  const { t } = f;
  const tableCaption = caption ?? t('tune.ranking.caption', { depth: depthLabel(depth as number, f) });
  // key undefined = the ranking's own order.
  const [sort, setSort] = useState<{ key: string | undefined; dir: SortDir }>({ key: undefined, dir: 'asc' });
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const label = useConfigLabel();
  const columns = views.map((v) => v.column);
  const best = bestValues(rows, columns);
  const sorted = sortRows(
    rows,
    columns.find((c) => c.key === sort.key),
    sort.dir,
  );
  const kind = run.engine.kind;
  const atDepth = views.filter((v) => v.column.atDepth).length;
  const toggle = (i: number) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const by = (key: string | undefined, first: SortDir) => setSort((cur) => (cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: first }));
  const head = (key: string | undefined, first: SortDir, text: string, numeric = true) => {
    const active = sort.key === key;
    return (
      <th
        key={key ?? 'rank'}
        scope="col"
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
        className={cn('h-10 border-b border-border px-3 align-bottom text-xs font-medium text-fg-3 first:pl-card', numeric ? 'text-right' : 'text-left')}
      >
        <button
          type="button"
          onClick={() => by(key, first)}
          title={active && sort.dir === 'desc' ? t('table.sortAscending') : t('table.sortDescending')}
          className={cn('inline-flex items-end gap-1 rounded-xs pb-2 hover:text-fg focus-ring', numeric && 'flex-row-reverse text-right', active && 'text-fg')}
        >
          {text}
          {active ? sort.dir === 'asc' ? <ArrowUp aria-hidden className="size-3.5" /> : <ArrowDown aria-hidden className="size-3.5" /> : <ChevronsUpDown aria-hidden className="size-3.5 opacity-50" />}
        </button>
      </th>
    );
  };
  const cell = (key: string, on: boolean, children: ReactNode, title?: string) => (
    <td key={key} title={title} className={cn('border-b border-border px-3 py-3 text-right align-top whitespace-nowrap tabular-nums last:pr-card', on && 'font-semibold text-success-text')}>
      {on ? (
        <span className="inline-flex items-center gap-1 rounded-sm bg-success-soft px-1.5 py-0.5" title={t('tune.ranking.bestHint')}>
          {children}
          <span className="sr-only"> ({t('tune.ranking.best')})</span>
        </span>
      ) : (
        children
      )}
    </td>
  );
  /** The metric cells of a row; the depth-bound ones become one "arriva solo a 32K" cell when it stops earlier. */
  const metrics = (r: RankRow) =>
    views.flatMap((v, k) => {
      if (v.column.atDepth && !r.point) {
        if (views.findIndex((w) => w.column.atDepth) !== k) return [];
        return [
          <td key="short" colSpan={atDepth} className="border-b border-border px-3 py-3 text-right text-sm whitespace-nowrap italic">
            {t('tune.ranking.reachesOnly', { depth: depthLabel(r.combo.maxContext, f) })}
          </td>,
        ];
      }
      const value = v.column.value(r);
      return [cell(v.column.key, best.get(v.column.key)?.has(r.index) === true, value === undefined ? '–' : v.format(value, f), value === undefined || !v.title ? undefined : v.title(value, f))];
    });

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-card pt-card">
        <div className="flex items-center gap-1.5">
          <h2 className="text-md font-semibold tracking-[-0.01em]">{t('tune.ranking.title')}</h2>
          <HelpTip term={t('tune.ranking.title')}>{t('tune.ranking.help')}</HelpTip>
        </div>
        {depth !== undefined && depths.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <span aria-hidden className="text-sm text-fg-2">
              {t('tune.ranking.compareAt')}
            </span>
            <SegmentedControl
              size="sm"
              label={t('tune.ranking.compareAt')}
              value={String(depth)}
              onValueChange={(v) => (onDepth as (depth: number) => void)(Number(v))}
              className="flex-wrap"
              options={depths.map((d) => ({ value: String(d), label: depthLabel(d, f) }))}
            />
          </div>
        )}
      </div>
      <p className="px-card pt-1.5 text-sm text-fg-2">{subtitle ?? t('tune.ranking.subtitle', { depth: depthLabel(depth as number, f) })}</p>
      <div role="region" aria-label={tableCaption} tabIndex={0} className="mt-3 overflow-x-auto focus-ring">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">{tableCaption}</caption>
          <thead>
            <tr>
              {head(undefined, 'asc', t('tune.columns.rank'), false)}
              <th scope="col" className="h-10 border-b border-border px-3 pb-2 text-left align-bottom text-xs font-medium text-fg-3">
                {t('tune.columns.settings')}
              </th>
              {views.map((v) => head(v.column.key, v.column.dir, v.column.atDepth && depth !== undefined ? headerAt(t(v.header), depth, f) : t(v.header)))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const reaches = reachesRow(r);
              const expanded = open.has(r.index);
              const text = comboText(r.combo, kind, label);
              return (
                <Fragment key={r.index}>
                  <tr className={cn('align-top', !reaches && 'text-fg-3')} aria-label={text}>
                    <td className="border-b border-border px-3 py-3 pl-card font-semibold whitespace-nowrap tabular-nums">
                      {r.tie && (
                        <span className="mr-0.5 font-normal text-fg-3" title={t('tune.ranking.tieHint')}>
                          ≈<span className="sr-only"> {t('tune.ranking.tie')}</span>
                        </span>
                      )}
                      {r.rank ?? '–'}
                    </td>
                    <th scope="row" className="border-b border-border px-3 py-3 text-left font-normal">
                      <span className="flex flex-col gap-2">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className={cn('font-medium', reaches ? 'text-fg' : 'text-fg-2')}>{text}</span>
                          {r.index === recommended && (
                            <Badge tone="accent" size="sm">
                              {t('tune.recommended')}
                            </Badge>
                          )}
                          {r.combo.partial && <PartialBadge why={r.combo.partial} />}
                        </span>
                        <span className="flex flex-wrap items-start gap-2">
                          <PresetActions run={run} combo={r.index} at={depth} layout="compact" />
                          <CompareToggle entry={entryOfRun(run, r.index, f)} />
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-expanded={expanded}
                            aria-controls={`tune-measures-${r.index}`}
                            onClick={() => toggle(r.index)}
                          >
                            <ChevronDown aria-hidden className={cn('transition-transform', expanded && 'rotate-180')} />
                            {t('tune.ranking.measures')}
                          </Button>
                        </span>
                      </span>
                    </th>
                    {metrics(r)}
                  </tr>
                  {expanded && (
                    <tr id={`tune-measures-${r.index}`}>
                      <td colSpan={views.length + 2} className="border-b border-border bg-surface-2/60 px-card py-4">
                        <Measures combo={r.combo} title={text} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2 px-card py-3">
        <p className="text-xs text-fg-3">{t('tune.ranking.footnote')}</p>
        <TuneGlossary />
      </div>
    </Card>
  );
}

/** Every depth a combination measured, with repetitions and spread, its memory and the exact command. */
export function Measures({ combo, title }: { combo: TuneCombination; title: string }) {
  const { t, number, integer, percent } = useI18n();
  if (combo.concurrency?.length) return <UsersMeasures combo={combo} title={title} />;
  const cvs = combo.sweep.map((p) => p.decodeTps.cv);
  const reps = combo.sweep.map((p) => p.decodeTps.n);
  return (
    <div className="flex flex-col gap-3">
      <SweepTable caption={t('tune.measures.caption', { settings: title })} points={combo.sweep} framed />
      <p className="text-xs text-fg-3 tabular-nums">
        {[
          combo.vramPeakMiB === undefined ? undefined : t('tune.measures.vram', { size: number(combo.vramPeakMiB / MIB_PER_GB, 1) }),
          t('tune.measures.maxContext', { n: integer(combo.maxContext) }),
          t('tune.measures.reps', { n: Math.min(...reps), cv: percent(Math.max(...cvs), 1) }),
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <CodeBlock commands={combo.command} label={t('tune.measures.command', { settings: title })} />
    </div>
  );
}

/** Goal "Più utenti": users 1 … N in order with what each one got, its memory and the exact command. */
function UsersMeasures({ combo, title }: { combo: TuneCombination; title: string }) {
  const { t, number, integer } = useI18n();
  const points = combo.concurrency as NonNullable<TuneCombination['concurrency']>;
  const n = Math.max(...points.map((p) => p.level));
  return (
    <div className="flex flex-col gap-3">
      <UsersTable caption={t('tune.users.measuresCaption', { settings: title })} points={points} framed />
      <p className="text-xs text-fg-3 tabular-nums">
        {[
          t('tune.users.measuresNote', { n }),
          combo.vramPeakMiB === undefined ? undefined : t('tune.measures.vram', { size: number(combo.vramPeakMiB / MIB_PER_GB, 1) }),
          t('tune.measures.maxContext', { n: integer(combo.maxContext) }),
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <CodeBlock commands={combo.command} label={t('tune.measures.command', { settings: title })} />
    </div>
  );
}
