/**
 * The comparison itself: one column per item (its card on top: model, engine, configuration in words,
 * date, "Usa questo preset" / "Avvia il server così"), one row per measurement with the best value
 * marked and the others' distance in words, every speed at the same measured context ("Confronta a"),
 * the charts with every item on them, and "Cosa cambia tra loro".
 */
import { ChevronDown, Plus, Share2, X, Zap } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useCallback, useMemo, useState } from 'react';
import { gpuKeyOf, modelKeyOf, type ConfigEntry } from '../../../contract/configs';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { sameRef, type CompareRef } from '../../lib/compare-selection';
import { useConfigs } from '../../lib/queries-configs';
import { axisName, tooltipHead, tokensK, usersWords } from '../../lib/speed-at';
import { shortGpuName } from '../bench/format';
import { SheetDialog } from '../bench/sheet-dialog';
import { SpillBadge } from '../bench/spill';
import { ChartCard } from '../charts/chart-card';
import { depthLinesOption } from '../charts/depth-lines';
import { EChart } from '../charts/echart';
import type { ChartTokens } from '../charts/echarts';
import { configLabelOf, launchLabelOf } from '../presets/config-label';
import { PresetActions } from '../presets/preset-actions';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { Card } from '../ui/card';
import { HelpTip } from '../ui/help-tip';
import { SegmentedControl } from '../ui/segmented-control';
import { Select } from '../ui/select';
import { Switch } from '../ui/switch';
import { refOfConfig, rankConfigs } from './best-config';
import { speedSeries, usersLinesOption, usersSeries } from './compare-charts';
import { DIFF_GROUPS, diffRows } from './compare-diff';
import { compareRows, defaultDepth, depthChoices, engineName, itemName, itemShortName, leadSentences, LETTERS, ROW_GROUPS, usersChoice, type CompareItem, type CompareRow, type UsersChoice } from './compare-model';

/** The item colors, in order (the same as the chart lines). */
export const ITEM_COLORS = ['border-chart-1', 'border-chart-2', 'border-chart-3', 'border-chart-4'] as const;

/** "A" framed in the item's color (the letter in the text color: readable on every chart color, both themes). */
export function ItemMark({ index, className }: { index: number; className?: string }) {
  return (
    <span aria-hidden className={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-md border-2 bg-surface text-2xs font-bold text-fg', ITEM_COLORS[index], className)}>
      {LETTERS[index]}
    </span>
  );
}

export interface ComparisonProps {
  items: readonly CompareItem[];
  /** "Confronta a" from the address, when it is one of the choices. */
  at: number | undefined;
  onDepth: (depth: number) => void;
  /** A new list of items (one removed, or another configuration of the same model). */
  onItems: (refs: CompareRef[]) => void;
  onAdd: () => void;
}

/** Another configuration of the same model on the same card, for one column ("Configurazione"). */
function ConfigPicker({ item, depth, onPick }: { item: CompareItem; depth: number | undefined; onPick: (ref: CompareRef) => void }) {
  const f = useI18n();
  const { t } = f;
  const gpu = item.run.hardware.gpus[0];
  const res = useConfigs({ gpu: gpuKeyOf({ hostId: item.run.hardware.hostId, gpuUuid: gpu?.uuid, gpuName: gpu?.name }), model: modelKeyOf(item.run.model) });
  const ranked = useMemo(() => rankConfigs(res.data?.configs ?? []), [res.data]);
  const current = ranked.configs.find((e) => e.sources.some((s) => sameRef({ runId: s.runId, ...(s.combo === undefined ? {} : { combo: s.combo }) }, item.ref)));
  if (!current || ranked.configs.length < 2) return null;
  // The context is always said, so the words are never empty.
  const words = (e: ConfigEntry) => configLabelOf(e.engineKind, e.params, f, { tags: e.tags }).text;
  return (
    <Select
      aria-label={t('compare.card.pickConfig', { name: item.run.model.displayName })}
      value={current.id}
      onValueChange={(id) => onPick(refOfConfig(ranked.configs.find((e) => e.id === id)!, depth))}
      className="h-8 w-full text-xs [&>span]:truncate"
      options={ranked.configs.map((e, i) => ({
        value: e.id,
        label: i === 0 ? t('compare.card.fastestConfig', { config: words(e) }) : words(e),
        text: words(e),
      }))}
    />
  );
}

/** The card on top of an item's column. */
function ItemCard({ item, index, depth, onRemove, onPick }: { item: CompareItem; index: number; depth: number | undefined; onRemove: () => void; onPick: (ref: CompareRef) => void }) {
  const f = useI18n();
  const { t, dateTime } = f;
  const run = item.run;
  const gpu = run.hardware.gpus[0];
  const config = launchLabelOf(item.params, run.engine.kind, f, { blockCount: run.model.facts?.blockCount, tags: item.combo?.tags }).text;
  return (
    <div className="flex h-full min-w-0 flex-col gap-2 text-left font-normal">
      <div className="flex items-start gap-2">
        <ItemMark index={index} className="mt-0.5" />
        <span className="min-w-0 flex-1 text-sm leading-5 font-semibold break-words text-fg">{run.model.displayName}</span>
        <IconButton size="sm" label={t('compare.card.remove', { name: itemName(item, index) })} icon={<X />} className="-mt-1 -mr-1 size-7" onClick={onRemove} />
      </div>
      <dl className="flex flex-col gap-1 text-xs leading-4 text-fg-2">
        <div>
          <dt className="sr-only">{t('compare.card.engine')}</dt>
          <dd className="flex flex-wrap items-center gap-1">
            <span className="font-medium text-fg">{engineName(run.engine, f)}</span>
            {run.engine.customEngine && (
              <Badge tone="outline" size="sm">
                {t('compare.card.custom')}
              </Badge>
            )}
          </dd>
        </div>
        <div>
          <dt className="sr-only">{t('compare.card.config')}</dt>
          <dd>
            {[run.model.quant && !run.model.displayName.includes(run.model.quant) ? run.model.quant : undefined, config].filter(Boolean).join(' · ')}
            {item.comboIndex !== undefined && <span className="text-fg-3"> · {t('compare.card.combo', { n: item.comboIndex + 1 })}</span>}
          </dd>
        </div>
        <div>
          <dt className="sr-only">{t('compare.card.when')}</dt>
          <dd className="text-fg-3">
            {[dateTime(run.createdAt), t(`benchmark.profiles.${run.scenario.profile}`), gpu ? shortGpuName(gpu.name) : undefined].filter(Boolean).join(' · ')}
          </dd>
        </div>
      </dl>
      {item.spill && <SpillBadge className="self-start" />}
      <div className="mt-auto flex flex-col gap-2 pt-1">
        <ConfigPicker item={item} depth={depth} onPick={onPick} />
        {run.status === 'completed' && <PresetActions run={run} combo={item.comboIndex} at={depth} layout="compact" />}
      </div>
    </div>
  );
}

/** A value cell: the number, then how far it is from the best (or that it is the best). */
function ValueCell({ row, i }: { row: CompareRow; i: number }) {
  const { t } = useI18n();
  const v = row.values[i];
  // Every measured item with the same number: nothing to point out.
  const allSame = row.best.length > 1 && row.best.length === row.values.filter((x) => x !== undefined).length;
  const best = row.best.includes(i) && !allSame;
  const words = row.words[i];
  const reread = row.reread?.[i];
  if (v === undefined) {
    return (
      <td className="border-b border-border px-3 py-2.5 align-top text-sm text-fg-3 italic">
        {t('compare.notMeasured')}
      </td>
    );
  }
  const bestKey = row.kind === 'speed' ? 'compare.best.speed' : row.kind === 'time' ? 'compare.best.time' : row.higherIsBetter ? 'compare.best.more' : 'compare.best.less';
  return (
    <td className="border-b border-border px-3 py-2.5 align-top">
      <span className="flex flex-col items-start gap-0.5">
        <span className={cn('rounded-sm text-sm font-semibold text-fg tabular-nums', best && 'bg-success-soft px-1.5 py-0.5 text-success-text')}>
          {row.format(v)}
          {reread && <span className="font-normal"> · {t('longConversations.compare.reread')}</span>}
        </span>
        {allSame ? (
          <span className="text-xs text-fg-3">{t('compare.same')}</span>
        ) : best ? (
          <span className="text-xs font-medium text-success-text">{t(row.best.length > 1 ? 'compare.best.tie' : bestKey)}</span>
        ) : (
          words && <span className="text-xs text-fg-3">{words.text}</span>
        )}
      </span>
    </td>
  );
}

function GroupRows({ group, rows, n }: { group: string; rows: readonly CompareRow[]; n: number }) {
  const { t } = useI18n();
  if (!rows.length) return null;
  return (
    <tbody>
      <tr>
        <th scope="colgroup" colSpan={n + 1} className="sticky left-0 bg-surface-2/70 px-card py-1.5 text-left text-2xs font-semibold tracking-wide text-fg-3 uppercase">
          {t(`compare.groups.${group as 'speed'}`)}
        </th>
      </tr>
      {rows.map((r) => (
        <tr key={r.id} className="hover:bg-surface-2/40">
          <th scope="row" className="sticky left-0 z-10 border-b border-border bg-surface px-3 py-2.5 pl-card text-left align-top font-normal">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-fg">{r.label}</span>
              {r.context && <span className="text-xs text-fg-3">{r.context}</span>}
            </span>
          </th>
          {r.values.map((_, i) => (
            <ValueCell key={i} row={r} i={i} />
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/** "Cosa cambia tra loro": closed at first, only the differences unless asked. */
function DiffSection({ items }: { items: readonly CompareItem[] }) {
  const f = useI18n();
  const { t } = f;
  const [open, setOpen] = useState(false);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const rows = diffRows(items, f);
  const differing = rows.filter((r) => r.differs).length;
  const shown = onlyDiff ? rows.filter((r) => r.differs) : rows;
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} asChild>
      <Card className="overflow-hidden">
        <Collapsible.Trigger asChild>
          <button type="button" className="flex w-full items-center justify-between gap-3 px-card py-3.5 text-left hover:bg-surface-2/60 focus-ring">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-md font-semibold">{t('compare.diff.title')}</span>
              <Badge size="sm" tone={differing ? 'warning' : 'neutral'}>
                {differing === 1 ? t('compare.diff.countOne') : t('compare.diff.count', { n: differing })}
              </Badge>
            </span>
            <ChevronDown aria-hidden className={cn('size-4 text-fg-3 transition-transform', open && 'rotate-180')} />
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div className="flex items-center justify-between gap-3 border-t border-border px-card py-2.5">
            <p className="text-sm text-fg-2">{t('compare.diff.body')}</p>
            <label className="flex shrink-0 items-center gap-2 text-sm font-medium text-fg">
              <Switch checked={onlyDiff} onCheckedChange={setOnlyDiff} />
              {t('compare.diff.onlyDiff')}
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <caption className="sr-only">{t('compare.diff.title')}</caption>
              <thead>
                <tr>
                  <th scope="col" className="h-9 border-b border-border px-3 pl-card text-left text-xs font-medium text-fg-3">
                    {t('compare.diff.setting')}
                  </th>
                  {items.map((it, i) => (
                    <th key={i} scope="col" className="h-9 border-b border-border px-3 text-left text-xs font-medium text-fg-3">
                      <span className="inline-flex items-center gap-1.5">
                        <ItemMark index={i} />
                        <span className="sr-only">{itemName(it, i)}</span>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              {DIFF_GROUPS.map((g) => {
                const list = shown.filter((d) => d.group === g);
                if (!list.length) return null;
                return (
                  <tbody key={g}>
                    <tr>
                      <th scope="colgroup" colSpan={items.length + 1} className="bg-surface-2/60 px-card py-1.5 text-left text-2xs font-semibold tracking-wide text-fg-3 uppercase">
                        {t(`compare.diff.groups.${g}`)}
                      </th>
                    </tr>
                    {list.map((d) => (
                      <tr key={`${g}-${d.label}`} className={cn(d.differs && 'bg-warning-soft/60')}>
                        <th scope="row" className="border-b border-border px-3 py-2 pl-card text-left font-medium">
                          {d.label}
                          {d.differs && <span className="sr-only"> ({t('compare.diff.differs')})</span>}
                        </th>
                        {d.values.map((v, i) => (
                          <td key={i} className={cn('border-b border-border px-3 py-2 font-mono text-xs break-all', d.differs ? 'font-semibold text-fg' : 'text-fg-2')}>
                            {v}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                );
              })}
            </table>
            {shown.length === 0 && <p className="px-card py-6 text-center text-sm text-fg-3">{t('compare.diff.none')}</p>}
          </div>
        </Collapsible.Content>
      </Card>
    </Collapsible.Root>
  );
}

/** Speed as the context fills up, one line per item; the compared depth marked. */
function SpeedChart({ items, names, depth }: { items: readonly CompareItem[]; names: readonly string[]; depth: number | undefined }) {
  const f = useI18n();
  const { t, number, integer } = f;
  const [metric, setMetric] = useState<'decode' | 'prefill'>('decode');
  const data = useMemo(() => speedSeries(items, names, metric), [items, names, metric]);
  const fmt = useCallback((v: number) => (metric === 'decode' ? `${number(v, 1)} tok/s` : `${integer(v)} tok/s`), [metric, number, integer]);
  const title = t('compare.charts.speed');
  const build = useCallback(
    (tk: ChartTokens) =>
      depthLinesOption(tk, data.depths, data.series, {
        format: fmt,
        axis: integer,
        depthLabel: (d) => tokensK(d, f),
        xName: axisName('depth', f),
        tooltipHead: (d) => tooltipHead(d, 'depth', f),
        connectNulls: true,
        ...(depth === undefined ? {} : { marker: depth }),
      }),
    [data, fmt, integer, f, depth],
  );
  const label = t(metric === 'decode' ? 'compare.charts.write' : 'compare.charts.read');
  return (
    <ChartCard
      title={title}
      help={t('compare.charts.speedHelp')}
      controls={
        <SegmentedControl
          size="sm"
          label={t('compare.charts.metric')}
          value={metric}
          onValueChange={setMetric}
          options={[
            { value: 'decode', label: t('compare.charts.write') },
            { value: 'prefill', label: t('compare.charts.read') },
          ]}
        />
      }
      table={{
        columns: [axisName('depth', f), ...names.map((n) => `${n} · ${label} (tok/s)`)],
        numeric: [0, ...names.map((_, i) => i + 1)],
        rows: data.depths.map((d, k) => [integer(d), ...data.series.map((s) => (s.values[k] === null ? '–' : fmt(s.values[k]!).replace(' tok/s', '')))]),
      }}
    >
      <EChart build={build} height={280} label={title} />
    </ChartCard>
  );
}

/** What every user gets as users are added, for the items that measured the same users with the same prompt. */
function UsersChart({ items, names, choice }: { items: readonly CompareItem[]; names: readonly string[]; choice: UsersChoice }) {
  const f = useI18n();
  const { t, number, integer } = f;
  const [metric, setMetric] = useState<'perUser' | 'total'>('perUser');
  const data = useMemo(() => usersSeries(items, names, choice, metric), [items, names, choice, metric]);
  const fmt = useCallback((v: number) => (metric === 'perUser' ? `${number(v, 1)} tok/s` : `${integer(v)} tok/s`), [metric, number, integer]);
  const title = t('compare.charts.users');
  const build = useCallback(
    (tk: ChartTokens) => usersLinesOption(tk, data.levels, data.series, { format: fmt, axis: integer, head: (n) => usersWords(n, choice.prompt, f), xName: t('compare.charts.usersAxis') }),
    [data, fmt, integer, choice.prompt, f, t],
  );
  const label = t(metric === 'perUser' ? 'compare.charts.perUser' : 'compare.charts.total');
  return (
    <ChartCard
      title={title}
      help={choice.prompt === undefined ? t('compare.charts.usersHelp') : t('compare.charts.usersHelpPrompt', { tokens: integer(choice.prompt) })}
      controls={
        <SegmentedControl
          size="sm"
          label={t('compare.charts.metric')}
          value={metric}
          onValueChange={setMetric}
          options={[
            { value: 'perUser', label: t('compare.charts.perUser') },
            { value: 'total', label: t('compare.charts.total') },
          ]}
        />
      }
      table={{
        columns: [t('compare.charts.usersAxis'), ...data.series.map((s) => `${s.name} · ${label} (tok/s)`)],
        numeric: [0, ...data.series.map((_, i) => i + 1)],
        rows: data.levels.map((l, k) => [String(l), ...data.series.map((s) => (s.values[k] === null ? '–' : fmt(s.values[k]!).replace(' tok/s', '')))]),
      }}
    >
      <EChart build={build} height={280} label={title} />
    </ChartCard>
  );
}

export function Comparison({ items, at, onDepth, onItems, onAdd }: ComparisonProps) {
  const f = useI18n();
  const { t } = f;
  const [sheet, setSheet] = useState(false);
  const choices = useMemo(() => depthChoices(items), [items]);
  const depth = at !== undefined && choices.some((c) => c.depth === at) ? at : defaultDepth(choices);
  const rows = useMemo(() => compareRows(items, depth, f), [items, depth, f]);
  const lead = leadSentences(items, rows, f);
  const names = useMemo(() => items.map((it, i) => itemName(it, i)), [items]);
  // Chart legends: the letter and the model, short (the cards above say the rest).
  const short = useMemo(() => items.map((it, i) => itemShortName(it, i)), [items]);
  const users = usersChoice(items);
  const refs = items.map((it) => it.ref);
  const replace = (i: number, ref: CompareRef) => onItems(refs.map((r, k) => (k === i ? ref : r)));
  const n = items.length;
  const depthOption = (c: (typeof choices)[number]) => {
    const missing = items.flatMap((it, i) => (it.points.some((p) => p.depth === c.depth) ? [] : [LETTERS[i]!]));
    return {
      value: String(c.depth),
      label: tokensK(c.depth, f),
      text: tokensK(c.depth, f),
      description: missing.length ? t('compare.depth.missing', { items: missing.join(', ') }) : t('compare.depth.all'),
    };
  };

  return (
    <div className="flex flex-col gap-section">
      <Card className="flex flex-col gap-3 p-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="flex items-center gap-1.5 text-md font-semibold tracking-[-0.01em]">
              <Zap aria-hidden className="size-4 text-accent" />
              {t('compare.lead.title')}
            </h2>
            <p className="text-sm text-fg-2">{t('compare.lead.body')}</p>
          </div>
          <div className="flex items-center gap-2">
            <span aria-hidden className="text-sm font-medium text-fg">
              {t('compare.depth.label')}
            </span>
            {depth === undefined ? (
              <span className="text-sm text-fg-3">{t('compare.depth.none')}</span>
            ) : (
              <Select aria-label={t('compare.depth.label')} value={String(depth)} onValueChange={(v) => onDepth(Number(v))} className="w-32" options={choices.map(depthOption)} />
            )}
            <HelpTip term={t('compare.depth.label')}>{t('compare.depth.help')}</HelpTip>
          </div>
        </div>
        {lead.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {lead.map((s) => (
              <li key={s} className="text-md leading-6 text-fg">
                {s}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-3">{t('compare.lead.none')}</p>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div role="region" aria-label={t('compare.table')} tabIndex={0} className="overflow-x-auto focus-ring">
          <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-0 text-sm">
            <caption className="sr-only">{t('compare.table')}</caption>
            <colgroup>
              <col className="w-[220px]" />
              {items.map((_, i) => (
                <col key={i} className="min-w-[180px]" />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-10 border-b border-border bg-surface px-3 py-3 pl-card text-left align-bottom text-xs font-medium text-fg-3">
                  {t('compare.measure')}
                </th>
                {items.map((it, i) => (
                  <th key={i} scope="col" aria-label={names[i]} className="border-b border-l border-border px-3 py-3 align-top">
                    <ItemCard item={it} index={i} depth={depth} onRemove={() => onItems(refs.filter((_, k) => k !== i))} onPick={(ref) => replace(i, ref)} />
                  </th>
                ))}
              </tr>
            </thead>
            {ROW_GROUPS.map((g) => (
              <GroupRows key={g} group={g} rows={rows.filter((r) => r.group === g)} n={n} />
            ))}
          </table>
        </div>
      </Card>

      <div className={cn('grid gap-section', users && 'xl:grid-cols-2')}>
        {items.some((it) => it.points.length > 0) && <SpeedChart items={items} names={short} depth={depth} />}
        {users && <UsersChart items={items} names={short} choice={users} />}
      </div>

      <DiffSection items={items} />

      <div className="flex flex-wrap gap-2">
        {n < 4 && (
          <Button onClick={onAdd}>
            <Plus aria-hidden />
            {t('compare.add')}
          </Button>
        )}
        <Button onClick={() => setSheet(true)}>
          <Share2 aria-hidden />
          {t('sheet.open')}
        </Button>
      </div>
      <SheetDialog open={sheet} onOpenChange={setSheet} compare={{ items, depth, names }} />
    </div>
  );
}
