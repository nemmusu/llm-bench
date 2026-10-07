import { ArrowDown, ArrowUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import type { RunResult, TuneCombination } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { SweepTable } from '../bench/context-sweep';
import { MIB_PER_GB, prefillStat } from '../bench/format';
import { PresetActions } from '../presets/preset-actions';
import { useConfigLabel } from '../presets/config-label';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { CodeBlock } from '../ui/code-block';
import { HelpTip } from '../ui/help-tip';
import { SegmentedControl } from '../ui/segmented-control';
import { comboText, depthLabel } from './tune-format';
import { TuneGlossary } from './tune-sections';
import { bestValues, defaultDir, sortRows, type RankRow, type SortDir, type SortKey } from './tune-logic';

export interface RankingProps {
  run: RunResult & { tuning: NonNullable<RunResult['tuning']> };
  rows: readonly RankRow[];
  depth: number;
  depths: readonly number[];
  onDepth: (depth: number) => void;
  recommended: number | undefined;
}

const COLS = 7;

/**
 * "Classifica": one row per measured combination, ranked by generation speed at the compared depth;
 * any column can sort; those that stop earlier sit greyed at the bottom. Every row opens its
 * measurements and the exact command, and has the preset actions.
 */
export function TuneRanking({ run, rows, depth, depths, onDepth, recommended }: RankingProps) {
  const f = useI18n();
  const { t, number, integer } = f;
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'rank', dir: 'asc' });
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const label = useConfigLabel();
  const best = bestValues(rows);
  const sorted = sortRows(rows, sort.key, sort.dir);
  const kind = run.engine.kind;
  const toggle = (i: number) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const by = (key: SortKey) => setSort((cur) => (cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultDir(key) }));
  const head = (key: SortKey, text: string, numeric = true) => {
    const active = sort.key === key;
    return (
      <th
        scope="col"
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
        className={cn('h-10 border-b border-border px-3 text-xs font-medium whitespace-nowrap text-fg-3 first:pl-card', numeric ? 'text-right' : 'text-left')}
      >
        <button
          type="button"
          onClick={() => by(key)}
          title={active && sort.dir === 'desc' ? t('table.sortAscending') : t('table.sortDescending')}
          className={cn('inline-flex items-center gap-1 rounded-xs hover:text-fg focus-ring', numeric && 'flex-row-reverse', active && 'text-fg')}
        >
          {text}
          {active ? sort.dir === 'asc' ? <ArrowUp aria-hidden className="size-3.5" /> : <ArrowDown aria-hidden className="size-3.5" /> : <ChevronsUpDown aria-hidden className="size-3.5 opacity-50" />}
        </button>
      </th>
    );
  };
  const cell = (on: boolean, children: ReactNode) => (
    <td className={cn('border-b border-border px-3 py-3 text-right align-top whitespace-nowrap tabular-nums', on && 'font-semibold text-success-text')}>
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

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-card pt-card">
        <div className="flex items-center gap-1.5">
          <h2 className="text-md font-semibold tracking-[-0.01em]">{t('tune.ranking.title')}</h2>
          <HelpTip term={t('tune.ranking.title')}>{t('tune.ranking.help')}</HelpTip>
        </div>
        {depths.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <span aria-hidden className="text-sm text-fg-2">
              {t('tune.ranking.compareAt')}
            </span>
            <SegmentedControl
              size="sm"
              label={t('tune.ranking.compareAt')}
              value={String(depth)}
              onValueChange={(v) => onDepth(Number(v))}
              className="flex-wrap"
              options={depths.map((d) => ({ value: String(d), label: depthLabel(d, f) }))}
            />
          </div>
        )}
      </div>
      <p className="px-card pt-1.5 text-sm text-fg-2">{t('tune.ranking.subtitle', { depth: depthLabel(depth, f) })}</p>
      <div role="region" aria-label={t('tune.ranking.caption', { depth: depthLabel(depth, f) })} tabIndex={0} className="mt-3 overflow-x-auto focus-ring">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">{t('tune.ranking.caption', { depth: depthLabel(depth, f) })}</caption>
          <thead>
            <tr>
              {head('rank', t('tune.columns.rank'), false)}
              <th scope="col" className="h-10 border-b border-border px-3 text-left text-xs font-medium text-fg-3">
                {t('tune.columns.settings')}
              </th>
              {head('maxContext', t('tune.columns.maxContext'))}
              {head('decode', t('tune.columns.decode'))}
              {head('prefill', t('tune.columns.prefill'))}
              {head('ttft', t('tune.columns.ttft'))}
              {head('vram', t('tune.columns.vram'))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const reaches = r.point !== undefined;
              const expanded = open.has(r.index);
              const text = comboText(r.combo, kind, label);
              return (
                <Fragment key={r.index}>
                  <tr className={cn('align-top', !reaches && 'text-fg-3')} aria-label={text}>
                    <td className="border-b border-border px-3 py-3 pl-card font-semibold tabular-nums">{r.rank ?? '–'}</td>
                    <th scope="row" className="min-w-72 border-b border-border px-3 py-3 text-left font-normal">
                      <span className="flex flex-col gap-2">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className={cn('font-medium', reaches ? 'text-fg' : 'text-fg-2')}>{text}</span>
                          {r.index === recommended && (
                            <Badge tone="accent" size="sm">
                              {t('tune.recommended')}
                            </Badge>
                          )}
                        </span>
                        <span className="flex flex-wrap items-center gap-2">
                          <PresetActions run={run} combo={r.index} />
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
                    <td className="border-b border-border px-3 py-3 text-right whitespace-nowrap tabular-nums" title={`${integer(r.combo.maxContext)} ${t('results.tokens')}`}>
                      {depthLabel(r.combo.maxContext, f)}
                    </td>
                    {r.point ? (
                      <>
                        {cell(best.decode.has(r.index), number(r.point.decodeTps.median, 1))}
                        {cell(best.prefill.has(r.index), integer(prefillStat(r.point).median))}
                        {cell(best.ttft.has(r.index), number(r.point.ttftMs.median / 1000, 2))}
                      </>
                    ) : (
                      <td colSpan={3} className="border-b border-border px-3 py-3 text-right text-sm whitespace-nowrap italic">
                        {t('tune.ranking.reachesOnly', { depth: depthLabel(r.combo.maxContext, f) })}
                      </td>
                    )}
                    <td className="border-b border-border px-3 py-3 pr-card text-right whitespace-nowrap tabular-nums">
                      {r.combo.vramPeakMiB === undefined ? '–' : number(r.combo.vramPeakMiB / MIB_PER_GB, 1)}
                    </td>
                  </tr>
                  {expanded && (
                    <tr id={`tune-measures-${r.index}`}>
                      <td colSpan={COLS} className="border-b border-border bg-surface-2/60 px-card py-4">
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
