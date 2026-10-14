import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { itemOf } from '../components/compare/compare-model';
import { entryOfRun, entryOfSummary } from '../components/compare/compare-entries';
import { CompareStart, type StartView } from '../components/compare/compare-start';
import { Comparison } from '../components/compare/compare-view';
import { ErrorCard } from '../components/bench/error-card';
import { AT_MAX, type CompareAt } from '../components/configs/depths';
import { Page } from '../components/shell/page';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { useI18n } from '../i18n';
import { COMPARE_MAX, idsOf, parseIds, sameRef, setCompareSelection, useCompareSelection, type CompareRef } from '../lib/compare-selection';
import { useRunsById } from '../lib/queries-compare';
import { apiErrorData, useRuns } from '../lib/queries-runs';

/**
 * /compare?ids=A,B~2,C&at=4096          two to four items (a run, or "run~combination"), compared at 4K
 * /compare?ids=A,B&at=max                each at its own largest context, with the context full
 * /compare?view=models | view=runs      the start screen: pick models, or tests
 * /compare?a=A&b=B                      older links: the same as ids=A,B
 */
export interface CompareSearch {
  ids?: string;
  at?: CompareAt;
  view?: StartView;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Router search validation: tokens checked and capped at four, a positive depth (or "max"), a known view. */
export function validateCompareSearch(search: Record<string, unknown>): CompareSearch {
  const ids = idsOf(parseIds(text(search.ids) ?? [text(search.a), text(search.b)].filter(Boolean).join(',')));
  const depth = Number(search.at);
  const at = search.at === AT_MAX ? AT_MAX : Number.isInteger(depth) && depth > 0 ? depth : undefined;
  const view = search.view === 'models' || search.view === 'runs' ? search.view : undefined;
  return { ...(ids ? { ids } : {}), ...(at === undefined ? {} : { at }), ...(view ? { view } : {}) };
}

/** Two to four items from the address: loaded, then compared. */
function CompareItems({ refs, at }: { refs: CompareRef[]; at: CompareAt | undefined }) {
  const f = useI18n();
  const { t } = f;
  const navigate = useNavigate();
  const ids = useMemo(() => [...new Set(refs.map((r) => r.runId))], [refs]);
  const { runs, failed } = useRunsById(ids);
  const items = useMemo(() => (runs.every(Boolean) ? refs.map((r) => itemOf(runs[ids.indexOf(r.runId)]!, r)) : undefined), [runs, refs, ids]);
  // The picks follow what is compared, so Risultati and the tray show the same items.
  useEffect(() => {
    if (items) setCompareSelection(items.map((it) => entryOfRun(it.run, it.comboIndex, f)));
  }, [items, f]);
  const go = (next: CompareRef[], where = at) =>
    void navigate({ to: '/compare', search: next.length >= 2 ? { ids: idsOf(next), ...(where === undefined ? {} : { at: where }) } : { view: 'runs' as const }, replace: true });
  if (failed) {
    const missing = ids[failed.index]!;
    return (
      <ErrorCard
        error={apiErrorData(failed.error)}
        extra={
          <Button size="sm" onClick={() => go(refs.filter((r) => r.runId !== missing))}>
            {t('compare.removeMissing')}
          </Button>
        }
      />
    );
  }
  if (!items) return <Skeleton className="h-96 w-full" />;
  const onItems = (next: CompareRef[]) => {
    // What stays picked when this page is left for the list (fewer than two): the items still in it.
    setCompareSelection(items.filter((it) => next.some((r) => sameRef(r, it.ref))).map((it) => entryOfRun(it.run, it.comboIndex, f)));
    go(next);
  };
  return <Comparison items={items} at={at} onDepth={(d) => go(refs, d)} onItems={onItems} onAdd={() => void navigate({ to: '/compare', search: { view: 'runs' } })} />;
}

/** Items in the address but not picked (an older "?a=" link, a single item): they join the picks. */
function useAdoptRefs(refs: CompareRef[]) {
  const f = useI18n();
  const runs = useRuns();
  const { items } = useCompareSelection();
  useEffect(() => {
    const add = refs
      .filter((r) => !items.some((e) => sameRef(e, r)))
      .flatMap((r) => (runs.data ?? []).filter((s) => s.id === r.runId).map((s) => ({ ...entryOfSummary(s, f), ...(r.combo === undefined ? {} : { combo: r.combo }) })))
      .slice(0, COMPARE_MAX - items.length);
    if (add.length) setCompareSelection([...items, ...add]);
  }, [runs.data, refs, items, f]);
}

function Start({ refs, view }: { refs: CompareRef[]; view: StartView | undefined }) {
  const navigate = useNavigate();
  const sel = useCompareSelection();
  useAdoptRefs(refs);
  // Something already picked: the tests to add to it; nothing yet: the models. Chosen once, not at every pick.
  const [initial] = useState<StartView>(() => (sel.items.length || refs.length ? 'runs' : 'models'));
  const shown = view ?? initial;
  return <CompareStart view={shown} onView={(v) => void navigate({ to: '/compare', search: { view: v }, replace: true })} />;
}

/** "Confronta": from two to four models or tests side by side, at the same measured context. */
export function ComparePage() {
  const { t } = useI18n();
  const search = useSearch({ from: '/compare' });
  const refs = useMemo(() => parseIds(search.ids), [search.ids]);
  const comparing = refs.length >= 2 && !search.view;
  return (
    <Page title={t('compare.title')} subtitle={comparing ? t('compare.subtitle', { n: refs.length }) : t('compare.startSubtitle')} width="wide">
      {comparing ? <CompareItems refs={refs} at={search.at} /> : <Start refs={refs} view={search.view} />}
    </Page>
  );
}
