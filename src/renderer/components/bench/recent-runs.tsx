import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { spilledRun } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { useRuns } from '../../lib/queries-runs';
import { contextShort } from '../../lib/speed-at';
import { Card, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { Sparkline } from '../ui/sparkline';
import { summaryModelLabel } from './format';
import { decodeHistory } from './history';
import { SpillBadge } from './spill';

/** The last few completed runs with their generation speed (Benchmark page). */
export function RecentRuns({ limit = 4 }: { limit?: number }) {
  const f = useI18n();
  const { t, number, relative } = f;
  const runs = useRuns();
  const all = runs.data ?? [];
  const items = all.filter((r) => r.status === 'completed').slice(0, limit);
  return (
    <Card>
      <CardHeader>
        {/* Every number below is a generation speed: said once, here. */}
        <div className="flex min-w-0 flex-col gap-0.5">
          <CardTitle>{t('benchmark.recent.title')}</CardTitle>
          <CardDescription className="text-xs text-fg-3">{t('benchmark.recent.subtitle')}</CardDescription>
        </div>
        <Link to="/results" className="inline-flex items-center gap-1 rounded-xs text-sm font-medium text-accent-text hover:underline focus-ring">
          {t('common.seeAll')}
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      </CardHeader>
      {runs.isPending ? (
        <div className="flex flex-col gap-2 px-card pt-3 pb-card">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="px-card pt-3 pb-card text-sm text-fg-3">{t('benchmark.recent.empty')}</p>
      ) : (
        <ul className="@container mt-2 flex flex-col px-2 pb-2">
          {items.map((r) => {
            const history = decodeHistory(r, all);
            const spill = spilledRun(r);
            return (
              <li key={r.id}>
                <Link
                  to="/results/$runId"
                  params={{ runId: r.id }}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-2 focus-ring"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium text-fg">{summaryModelLabel(r)}</span>
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-3">
                      <span className="truncate">
                        {r.engineLabel.split(' ')[0]} · {relative(r.createdAt)}
                      </span>
                      {/* Its speed is not the card's: said where the number is. */}
                      {spill && <SpillBadge className="shrink-0" />}
                    </span>
                  </div>
                  {/* The trend only where the name keeps its room (a wide card). */}
                  {history.length > 1 && (
                    <span className="hidden @sm:inline-flex">
                      <Sparkline values={history} width={56} height={22} endDot={false} />
                    </span>
                  )}
                  <span className="flex shrink-0 flex-col items-end">
                    <span className={cn('text-right text-sm font-semibold whitespace-nowrap tabular-nums', spill ? 'text-warning-text' : 'text-fg')}>
                      {r.decodeTps === undefined ? '–' : number(r.decodeTps, 1)}
                      <span className="ml-1 text-2xs font-medium text-fg-3">tok/s</span>
                    </span>
                    {/* What the speed was measured on: "a 512 token di contesto". */}
                    {r.decodeTps !== undefined && r.decodeTokens !== undefined && (
                      <span className="text-2xs whitespace-nowrap text-fg-3">{contextShort({ kind: 'write', tokens: r.decodeTokens, basis: r.speedBasis }, f)}</span>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
