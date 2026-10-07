import { useNavigate, useSearch } from '@tanstack/react-router';
import { Download, FolderPlus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { ModelCatalog, type CatalogView } from '../components/library/catalog';
import { type EngineFormat } from '../components/library/curated-list';
import { ErrorCallout } from '../components/library/error-callout';
import { LocalModels } from '../components/library/local-models';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { useI18n } from '../i18n';
import { isDownloadActive, useDownloadJobs, useDownloadsPanel, useLibraryModels, useRescan, useSaveFoldersAndRescan } from '../lib/queries-library';
import { useSettings } from '../lib/settings';

export type ModelsTab = 'local' | 'download';

/** Library on disk, and a catalog of Hugging Face models (recommended ones first); downloads open in the side panel. */
export function ModelsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const search = useSearch({ from: '/models' });
  const { settings } = useSettings();
  const local = useLibraryModels();
  const rescan = useRescan();
  const saveFolders = useSaveFoldersAndRescan();
  const jobs = useDownloadJobs();
  const [, setPanel] = useDownloadsPanel();
  const [format, setFormat] = useState<EngineFormat>('gguf');
  const tab: ModelsTab = search.tab ?? 'local';
  const setTab = (v: string) => void navigate({ to: '/models', search: v === 'download' ? { tab: 'download' } : {}, replace: true });
  const view: CatalogView = search.view ?? 'hub';
  const setView = (v: CatalogView) => void navigate({ to: '/models', search: { tab: 'download', ...(v === 'hub' ? {} : { view: v }) }, replace: true });
  const active = (jobs.data ?? []).filter(isDownloadActive).length;

  const addFolder = async () => {
    const dir = await window.gpubench?.pickFolder({ title: t('models.addFolder') });
    if (dir && !settings.extraModelDirs.includes(dir)) saveFolders.mutate({ extraModelDirs: [...settings.extraModelDirs, dir] });
  };

  return (
    <Page
      width="wide"
      title={t('models.title')}
      subtitle={t('models.subtitle')}
      actions={
        <>
          <Button onClick={() => setPanel(true)}>
            <Download aria-hidden />
            {t('models.downloadsButton')}
            {active > 0 && (
              <Badge tone="accent" size="sm">
                {active}
              </Badge>
            )}
          </Button>
          <Button onClick={() => void addFolder()}>
            <FolderPlus aria-hidden />
            {t('models.addFolder')}
          </Button>
          <Button onClick={() => rescan.mutate()} disabled={rescan.isPending || saveFolders.isPending}>
            <RefreshCw aria-hidden className={rescan.isPending || saveFolders.isPending ? 'animate-spin' : undefined} />
            {t('models.rescan')}
          </Button>
        </>
      }
    >
      {(rescan.isError || saveFolders.isError) && <ErrorCallout error={rescan.error ?? saveFolders.error} className="mb-4" />}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="local">
            {t('models.tabs.local')}
            <Badge size="sm">{local.data?.length ?? 0}</Badge>
          </TabsTrigger>
          <TabsTrigger value="download">{t('models.tabs.download')}</TabsTrigger>
        </TabsList>
        <TabsContent value="local">
          {/* Nothing on the PC yet: the verified suggestions are the easy first pick. */}
          <LocalModels onDownload={() => setView('curated')} />
        </TabsContent>
        <TabsContent value="download">
          <ModelCatalog format={format} onFormatChange={setFormat} view={view} onViewChange={setView} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
