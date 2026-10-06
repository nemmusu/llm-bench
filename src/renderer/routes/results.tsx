import { Link, useNavigate } from '@tanstack/react-router';
import { CircleCheck, GitCompareArrows, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { RunSummary } from '../../contract/results';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { columnHelper, DataTable } from '../components/ui/data-table';
import { EmptyState } from '../components/ui/empty-state';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Sparkline } from '../components/ui/sparkline';
import { useI18n } from '../i18n';
import { useRuns } from '../lib/queries';
import { sparkFor } from '../mock/runs';

const col = columnHelper<RunSummary>();
const statusTone = { completed: 'success', failed: 'danger', cancelled: 'neutral' } as const;
const THIS_HOST = 'a1f4c9e27b';

/** History of every saved run, filterable and sortable. */
export function ResultsPage() {
  const { t, number, integer, dateTime } = useI18n();
  const navigate = useNavigate();
  const runs = useRuns();
  const [q, setQ] = useState('');
  const [gpu, setGpu] = useState('all');
  const [engine, setEngine] = useState('all');
  const all = runs.data ?? [];
  const gpus = [...new Set(all.map((r) => r.gpuName))];
  const engines = [...new Set(all.map((r) => r.engineKind))];
  const data = useMemo(
    () =>
      all.filter(
        (r) =>
          (!q || `${r.modelName} ${r.quant ?? ''}`.toLowerCase().includes(q.toLowerCase())) &&
          (gpu === 'all' || r.gpuName === gpu) &&
          (engine === 'all' || r.engineKind === engine),
      ),
    [all, q, gpu, engine],
  );

  const columns = useMemo(
    () => [
      col.accessor('createdAt', {
        header: t('results.columns.date'),
        cell: (c) => (
          <span className="flex flex-col leading-5">
            <span className="text-fg-2 tabular-nums">{dateTime(c.getValue())}</span>
            <span className="text-xs text-fg-3">{t(`benchmark.profiles.${c.row.original.profile}`)}</span>
          </span>
        ),
      }),
      col.accessor('modelName', {
        header: t('results.columns.model'),
        cell: (c) => (
          <span className="flex flex-col leading-5">
            <Link
              to="/results/$runId"
              params={{ runId: c.row.original.id }}
              onClick={(e) => e.stopPropagation()}
              className="self-start rounded-xs font-medium text-fg hover:text-accent-text focus-ring"
            >
              {c.getValue()} <span className="font-normal text-fg-3">{c.row.original.quant}</span>
            </Link>
            <span className="text-xs text-fg-3">{c.row.original.engineLabel}</span>
          </span>
        ),
      }),
      col.accessor('gpuName', {
        header: t('results.columns.gpu'),
        cell: (c) => (
          <span className="inline-flex items-center gap-2 text-fg-2">
            {c.getValue().replace('NVIDIA GeForce ', '')}
            {c.row.original.hostId !== THIS_HOST && (
              <Badge tone="outline" size="sm">
                {t('results.otherPc')}
              </Badge>
            )}
          </span>
        ),
      }),
      // Missing measurements (failed or cancelled runs) always sort last.
      col.accessor('decodeTps', {
        header: t('results.columns.decode'),
        meta: { numeric: true },
        sortUndefined: 'last',
        cell: (c) => {
          const v = c.getValue();
          return v === undefined ? (
            <span className="text-fg-3">–</span>
          ) : (
            <span className="inline-flex items-center justify-end gap-3">
              <Sparkline values={sparkFor(c.row.original)} width={44} height={18} endDot={false} />
              <span className="w-12 font-semibold">{number(v, 1)}</span>
            </span>
          );
        },
      }),
      col.accessor('prefillTps', {
        header: t('results.columns.prefill'),
        meta: { numeric: true },
        sortUndefined: 'last',
        cell: (c) => {
          const v = c.getValue();
          return v === undefined ? '–' : integer(v);
        },
      }),
      col.accessor('vramPeakMiB', {
        header: t('results.columns.vram'),
        meta: { numeric: true },
        sortUndefined: 'last',
        cell: (c) => {
          const v = c.getValue();
          return v === undefined ? '–' : `${number(v / 1024, 1)} GB`;
        },
      }),
      col.accessor('score', {
        header: t('results.columns.score'),
        meta: { numeric: true },
        sortUndefined: 'last',
        cell: (c) => {
          const v = c.getValue();
          return v === undefined ? <span className="text-fg-3">–</span> : <b className="font-semibold">{integer(v)}</b>;
        },
      }),
      col.accessor('status', {
        header: t('results.columns.status'),
        // Completed is the norm: a quiet check. Only failures and cancellations get a badge.
        cell: (c) =>
          c.getValue() === 'completed' ? (
            <span className="inline-flex text-success-text">
              <CircleCheck aria-hidden className="size-4" />
              <span className="sr-only">{t('result.status.completed')}</span>
            </span>
          ) : (
            <Badge tone={statusTone[c.getValue()]} size="sm" dot>
              {t(`result.status.${c.getValue()}`)}
            </Badge>
          ),
      }),
    ],
    [t, number, integer, dateTime],
  );

  return (
    <Page
      title={t('results.title')}
      subtitle={t('results.subtitle')}
      width="wide"
      actions={
        <Button asChild>
          <Link to="/compare">
            <GitCompareArrows aria-hidden />
            {t('common.compare')}
          </Link>
        </Button>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-72">
          <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('results.searchPlaceholder')} aria-label={t('common.search')} className="pl-9" />
        </div>
        <Select
          aria-label={t('results.filterGpu')}
          value={gpu}
          onValueChange={setGpu}
          className="w-56"
          options={[{ value: 'all', label: t('results.allGpus') }, ...gpus.map((g) => ({ value: g, label: g.replace('NVIDIA GeForce ', '') }))]}
        />
        <Select
          aria-label={t('results.filterEngine')}
          value={engine}
          onValueChange={setEngine}
          className="w-52"
          options={[{ value: 'all', label: t('results.allEngines') }, ...engines.map((e) => ({ value: e, label: t(`benchmark.engines.${e}`) }))]}
        />
        <span className="ml-auto text-sm text-fg-3 tabular-nums">{t('results.count', { n: data.length })}</span>
      </div>
      <Card className="overflow-hidden">
        {runs.isPending ? (
          <div className="flex flex-col gap-2 p-card">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : all.length === 0 ? (
          <EmptyState
            title={t('results.emptyTitle')}
            description={t('results.emptyBody')}
            action={
              <Button variant="primary" asChild>
                <Link to="/">{t('results.emptyAction')}</Link>
              </Button>
            }
          />
        ) : (
          <DataTable
            caption={t('results.title')}
            columns={columns}
            data={data}
            getRowId={(r) => r.id}
            initialSorting={[{ id: 'createdAt', desc: true }]}
            onRowClick={(r) => void navigate({ to: '/results/$runId', params: { runId: r.id } })}
          />
        )}
      </Card>
    </Page>
  );
}
