import { useNavigate, useSearch } from '@tanstack/react-router';
import { Download, FolderPlus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { useAddModelFolder } from '../components/library/add-folder';
import { ModelCatalog } from '../components/library/catalog';
import { catalogState, rememberCatalog, searchOf, type CatalogState, type ModelsSearch } from '../components/library/catalog-search';
import { ErrorCallout } from '../components/library/error-callout';
import { LocalModels } from '../components/library/local-models';
import { Page } from '../components/shell/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { useI18n } from '../i18n';
import { isDownloadActive, useDownloadJobs, useDownloadsPanel, useLibraryModels, useRescan, useSaveFoldersAndRescan } from '../lib/queries-library';

export type ModelsTab = 'local' | 'download';

/** Library on disk, and a catalog of Hugging Face models (recommended ones first); downloads open in the side panel. */
export function ModelsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const search = useSearch({ from: '/models' });
  const local = useLibraryModels();
  const rescan = useRescan();
  const saveFolders = useSaveFoldersAndRescan();
  const addFolder = useAddModelFolder(saveFolders, rescan);
  const jobs = useDownloadJobs();
  const [, setPanel] = useDownloadsPanel();
  const tab: ModelsTab = search.tab ?? 'local';
  const state = catalogState(search);
  // The catalog's choices stay in the URL when switching tabs.
  const setTab = (v: string) => void navigate({ to: '/models', search: (prev: ModelsSearch) => ({ ...prev, tab: v === 'download' ? ('download' as const) : undefined }), replace: true });
  const update = useCallback(
    (patch: Partial<CatalogState>) => void navigate({ to: '/models', search: (prev: ModelsSearch) => searchOf({ ...catalogState(prev), ...patch }), replace: true }),
    [navigate],
  );
  useEffect(() => {
    if (tab === 'download') rememberCatalog(search);
  }, [tab, search]);
  const active = (jobs.data ?? []).filter(isDownloadActive).length;

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
          <Button onClick={() => void addFolder(t('models.addFolder'))}>
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
          <LocalModels onDownload={() => update({ view: 'curated' })} />
        </TabsContent>
        <TabsContent value="download">
          <ModelCatalog state={state} onChange={update} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
