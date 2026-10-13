/**
 * "Confronta" next to every run, configuration and combination, and the tray at the bottom of the
 * window with what was picked ("3 selezionati · Confronta"). The picks stay while moving between pages.
 */
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Check, GitCompareArrows, X } from 'lucide-react';
import type { MouseEvent } from 'react';
import { toast } from 'sonner';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { COMPARE_MAX, idsOf, oldestFirst, useCompareSelection, type CompareEntry, type CompareRef } from '../../lib/compare-selection';
import { Button, IconButton } from '../ui/button';

export interface CompareToggleProps {
  entry: CompareEntry;
  /** Other tests that stand for the same thing (a configuration's other tests): picked if any of them is. */
  also?: readonly CompareRef[];
  /** Only the icon (a dense table whose column header says "Confronta"); the name is in the tooltip. */
  compact?: boolean;
  className?: string;
}

/** "Confronta": adds the item to the comparison, or takes it away (pressed while it is in). */
export function CompareToggle({ entry, also = [], compact, className }: CompareToggleProps) {
  const { t } = useI18n();
  const sel = useCompareSelection();
  const picked = [entry, ...also].filter((r) => sel.has(r));
  const on = picked.length > 0;
  const name = [entry.label, entry.detail].filter(Boolean).join(' · ');
  const click = () => {
    if (on) {
      for (const r of picked) sel.remove(r);
      return;
    }
    if (sel.toggle(entry) === 'full') toast(t('compare.toggle.full', { n: COMPARE_MAX }));
  };
  const label = t('compare.toggle.label', { name });
  const onClick = (e: MouseEvent) => {
    // In a clickable row: the row must not open.
    e.stopPropagation();
    click();
  };
  const look = cn(on && 'border-accent bg-accent-soft text-accent-text hover:bg-accent-soft', className);
  if (compact) return <IconButton size="sm" variant="outline" label={label} aria-pressed={on} icon={on ? <Check /> : <GitCompareArrows />} onClick={onClick} className={look} />;
  return (
    <Button size="sm" variant="outline" aria-pressed={on} aria-label={label} onClick={onClick} className={look}>
      {on ? <Check aria-hidden /> : <GitCompareArrows aria-hidden />}
      {t('compare.toggle.text')}
    </Button>
  );
}

/** The picks at the bottom of every page but Confronta itself: remove one, empty, or compare. */
export function CompareTray() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const sel = useCompareSelection();
  const n = sel.items.length;
  if (!n || pathname.startsWith('/compare') || pathname.startsWith('/welcome')) return null;
  const go = () =>
    void navigate(n >= 2 ? { to: '/compare', search: { ids: idsOf(oldestFirst(sel.items)) } } : { to: '/compare', search: { view: 'runs' as const } });
  return (
    <div className="pointer-events-none sticky bottom-4 z-30 mt-2 flex justify-center px-6">
      <section
        aria-label={t('compare.tray.label')}
        className="pointer-events-auto flex max-w-full min-w-0 items-center gap-3 rounded-xl border border-border-strong bg-elevated py-2 pr-2 pl-4 shadow-lg"
      >
        <span className="text-sm font-semibold whitespace-nowrap text-fg tabular-nums">{t(n === 1 ? 'compare.tray.countOne' : 'compare.tray.count', { n })}</span>
        <ul className="flex min-w-0 items-center gap-1.5 overflow-x-auto" aria-label={t('compare.tray.items')}>
          {sel.items.map((e) => (
            <li key={`${e.runId}~${e.combo ?? ''}`} className="flex max-w-52 min-w-0 shrink-0 items-center gap-1 rounded-full bg-surface-2 py-0.5 pr-0.5 pl-2.5 text-xs text-fg-2">
              <span className="truncate" title={[e.label, e.detail].filter(Boolean).join(' · ')}>
                {e.label}
              </span>
              <IconButton size="sm" label={t('compare.tray.remove', { name: e.label })} icon={<X />} className="size-6" onClick={() => sel.remove(e)} />
            </li>
          ))}
        </ul>
        {n < 2 && <span className="hidden text-xs whitespace-nowrap text-fg-3 lg:inline">{t('compare.tray.oneMore')}</span>}
        <span className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={sel.clear}>
            {t('compare.tray.clear')}
          </Button>
          <Button size="sm" variant="primary" onClick={go}>
            <GitCompareArrows aria-hidden />
            {n >= 2 ? t('compare.tray.go') : t('compare.tray.pickMore')}
          </Button>
        </span>
      </section>
    </div>
  );
}
