import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useRuns } from '../../lib/queries-runs';
import { Card, CardHeader, CardTitle } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { Sparkline } from '../ui/sparkline';
import { summaryModelLabel } from './format';
import { decodeHistory } from './history';

/** The last few completed runs with their generation speed (Benchmark page). */
export function RecentRuns({ limit = 4 }: { limit?: number }) {
  const { t, number, relative } = useI18n();
  const runs = useRuns();
  const all = runs.data ?? [];
  const items = all.filter((r) => r.status === 'completed').slice(0, limit);
  return (
    <Card>
      <CardHeader className="items-center">
        <CardTitle>{t('benchmark.recent.title')}</CardTitle>
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
        <ul className="mt-2 flex flex-col px-2 pb-2">
          {items.map((r) => {
            const history = decodeHistory(r, all);
            return (
              <li key={r.id}>
                <Link
                  to="/results/$runId"
                  params={{ runId: r.id }}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-2 focus-ring"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium text-fg">{summaryModelLabel(r)}</span>
                    <span className="truncate text-xs text-fg-3">
                      {r.engineLabel.split(' ')[0]} · {relative(r.createdAt)}
                    </span>
                  </div>
                  {history.length > 1 && <Sparkline values={history} width={56} height={22} endDot={false} />}
                  <span className="w-[74px] text-right text-sm font-semibold text-fg tabular-nums">
                    {r.decodeTps === undefined ? '–' : number(r.decodeTps, 1)}
                    <span className="ml-1 text-2xs font-medium text-fg-3">tok/s</span>
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
