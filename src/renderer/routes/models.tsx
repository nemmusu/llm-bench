import { useNavigate } from '@tanstack/react-router';
import { Download, FolderPlus, Gauge, HardDrive, Pause, RefreshCw, Search } from 'lucide-react';
import { useState } from 'react';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { EmptyState } from '../components/ui/empty-state';
import { FitBadge } from '../components/ui/fit-badge';
import { Input } from '../components/ui/input';
import { Progress } from '../components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { TriedBadge } from '../components/ui/tried-badge';
import { useI18n } from '../i18n';
import { useDownloads, useLocalModels, useRecommendedModels } from '../lib/queries';
import { useSettings } from '../lib/settings';
import { findChoice, type ModelChoice } from '../mock/models';

function ModelRow({ m, path, origin, action }: { m: ModelChoice; path?: string; origin?: string; action: React.ReactNode }) {
  const { t, bytes, number } = useI18n();
  return (
    <li className="flex items-center gap-4 px-card py-4">
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-3 text-fg-2">
        {m.local ? <HardDrive className="size-5" /> : <Download className="size-5" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-fg">{m.name}</span>
          <span className="text-sm text-fg-3">
            {m.quant} · {t('models.params', { n: number(m.paramsB, 1) })} · {bytes(m.sizeBytes)}
          </span>
        </p>
        {path && (
          <p className="truncate font-mono text-xs text-fg-3">
            {path}
            {origin && <span className="ml-2 font-sans">· {origin}</span>}
          </p>
        )}
        <div className="mt-0.5 flex flex-wrap gap-1.5">
          <FitBadge level={m.fit} size="sm" />
          {m.tried && <TriedBadge tps={m.tried.tps} date={m.tried.date} size="sm" />}
        </div>
      </div>
      {action}
    </li>
  );
}

/** Library on disk, curated recommendations, Hugging Face search and downloads. */
export function ModelsPage() {
  const { t, bytes, duration } = useI18n();
  const navigate = useNavigate();
  const { update } = useSettings();
  const local = useLocalModels();
  const recommended = useRecommendedModels();
  const downloads = useDownloads();
  const [q, setQ] = useState('');
  const bench = (id: string) => {
    update({ lastModelId: id });
    void navigate({ to: '/' });
  };
  return (
    <Page
      title={t('models.title')}
      subtitle={t('models.subtitle')}
      actions={
        <>
          <Button>
            <FolderPlus aria-hidden />
            {t('models.addFolder')}
          </Button>
          <Button>
            <RefreshCw aria-hidden />
            {t('models.rescan')}
          </Button>
        </>
      }
    >
      <Tabs defaultValue="local">
        <TabsList>
          <TabsTrigger value="local">
            {t('models.tabs.local')}
            <Badge size="sm">{local.data?.length ?? 0}</Badge>
          </TabsTrigger>
          <TabsTrigger value="recommended">{t('models.tabs.recommended')}</TabsTrigger>
          <TabsTrigger value="search">{t('models.tabs.search')}</TabsTrigger>
          <TabsTrigger value="downloads">
            {t('models.tabs.downloads')}
            {(downloads.data?.length ?? 0) > 0 && <Badge tone="accent" size="sm">{downloads.data?.length}</Badge>}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="local">
          <Card>
            <ul className="divide-y divide-border">
              {(local.data ?? []).map((lm) => (
                <ModelRow
                  key={lm.id}
                  m={findChoice(lm.id)}
                  path={lm.paths[0]}
                  origin={t(`models.origin.${lm.origin}`)}
                  action={
                    <Button variant="secondary" onClick={() => bench(lm.id)}>
                      <Gauge aria-hidden />
                      {t('models.benchmark')}
                    </Button>
                  }
                />
              ))}
            </ul>
          </Card>
        </TabsContent>
        <TabsContent value="recommended">
          <Card>
            <ul className="divide-y divide-border">
              {(recommended.data ?? [])
                .filter((m) => !m.local)
                .map((m) => (
                  <ModelRow
                    key={m.id}
                    m={m}
                    path={m.repo}
                    action={
                      <Button variant="secondary">
                        <Download aria-hidden />
                        {t('common.download')} · {bytes(m.sizeBytes)}
                      </Button>
                    }
                  />
                ))}
            </ul>
          </Card>
        </TabsContent>
        <TabsContent value="search">
          <div className="relative mb-4 max-w-xl">
            <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('models.searchPlaceholder')} aria-label={t('common.search')} className="h-11 pl-9 text-md" />
          </div>
          <Card>
            <EmptyState illustration="search" title={t('models.searchEmptyTitle')} description={t('models.searchEmptyBody')} />
          </Card>
        </TabsContent>
        <TabsContent value="downloads">
          <Card>
            {(downloads.data ?? []).length === 0 ? (
              <EmptyState illustration="downloads" title={t('models.downloadsEmptyTitle')} description={t('models.downloadsEmptyBody')} />
            ) : (
              <ul className="divide-y divide-border">
                {(downloads.data ?? []).map((d) => {
                  const pct = ((d.bytesDone ?? 0) / (d.bytesTotal ?? 1)) * 100;
                  return (
                    <li key={d.id} className="flex flex-col gap-3 px-card py-4">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex flex-col">
                          <span className="font-semibold">{d.label}</span>
                          <span className="font-mono text-xs text-fg-3">{d.repo}</span>
                        </div>
                        <Button variant="secondary" size="sm">
                          <Pause aria-hidden />
                          {t('models.pause')}
                        </Button>
                      </div>
                      <Progress value={pct} label={d.label} valueText={`${Math.round(pct)}%`} />
                      <div className="flex justify-between text-xs text-fg-3 tabular-nums">
                        <span>
                          {bytes(d.bytesDone)} / {bytes(d.bytesTotal ?? 0)} · {t('models.speed', { speed: bytes(d.bytesPerSec ?? 0) })}
                        </span>
                        <span>{t('models.remaining', { time: duration((d.etaSec ?? 0) * 1000) })}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </Page>
  );
}
