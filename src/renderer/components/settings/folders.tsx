import { FolderOpen, FolderPlus, X } from 'lucide-react';
import { useId } from 'react';
import { useI18n } from '../../i18n';
import { useRescan, useSaveFoldersAndRescan, useSystemInfo } from '../../lib/queries-library';
import { useSettings } from '../../lib/settings';
import { useAddModelFolder } from '../library/add-folder';
import { ErrorCallout } from '../library/error-callout';
import { Button, IconButton } from '../ui/button';
import { PathText } from '../ui/path-text';
import { Switch } from '../ui/switch';
import { Row, Section } from './section';

/** Results folder (may be shared), models folder, extra folders and the known locations switch. */
export function FoldersSection() {
  const { t } = useI18n();
  const { settings, update } = useSettings();
  const system = useSystemInfo();
  const save = useSaveFoldersAndRescan();
  const rescan = useRescan();
  const addExtra = useAddModelFolder(save, rescan);
  const knownId = useId();
  const pick = (title: string) => window.gpubench?.pickFolder({ title }) ?? Promise.resolve(null);

  const pickResults = async () => {
    const dir = await pick(t('settings.resultsDir'));
    if (dir) update({ resultsDir: dir });
  };
  const pickModels = async () => {
    const dir = await pick(t('settings.modelsDir'));
    if (dir) save.mutate({ modelsDir: dir });
  };

  return (
    <Section title={t('settings.folders.title')} hint={t('settings.folders.hint')}>
      <Row
        label={t('settings.resultsDir')}
        hint={
          <>
            <span className="block font-mono">
              <PathText path={settings.resultsDir || system.data?.paths.resultsDir || t('settings.defaultFolder')} />
            </span>
            <span className="mt-1 block">{t('settings.resultsDirHint')}</span>
          </>
        }
        control={
          <Button size="sm" onClick={() => void pickResults()} aria-label={`${t('settings.browseFolder')} ${t('settings.resultsDir')}`}>
            <FolderOpen aria-hidden />
            {t('settings.browseFolder')}
          </Button>
        }
      />
      <Row
        label={t('settings.modelsDir')}
        hint={
          <>
            <span className="block font-mono">
              <PathText path={settings.modelsDir || system.data?.paths.modelsDir || t('settings.defaultFolder')} />
            </span>
            <span className="mt-1 block">{t('settings.folders.modelsHint')}</span>
          </>
        }
        control={
          <Button size="sm" onClick={() => void pickModels()} aria-label={`${t('settings.browseFolder')} ${t('settings.modelsDir')}`}>
            <FolderOpen aria-hidden />
            {t('settings.browseFolder')}
          </Button>
        }
      />
      <div className="flex flex-col gap-2 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{t('settings.extraDirs')}</span>
            <span className="text-xs text-fg-3">{t('settings.folders.extraHint')}</span>
          </div>
          <Button size="sm" onClick={() => void addExtra(t('settings.folders.addExtra'))}>
            <FolderPlus aria-hidden />
            {t('settings.folders.addExtra')}
          </Button>
        </div>
        {settings.extraModelDirs.length > 0 && (
          <ul className="flex flex-col gap-1" aria-label={t('settings.extraDirs')}>
            {settings.extraModelDirs.map((d) => (
              <li key={d} className="flex items-center justify-between gap-2 rounded-md bg-surface-2 py-1 pr-1 pl-3">
                <span className="truncate font-mono text-xs text-fg" title={d}>
                  {d}
                </span>
                <IconButton
                  size="sm"
                  label={t('settings.folders.remove', { dir: d })}
                  icon={<X />}
                  onClick={() => save.mutate({ extraModelDirs: settings.extraModelDirs.filter((x) => x !== d) })}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <Row
        label={t('settings.folders.known')}
        hint={t('settings.folders.knownHint')}
        htmlFor={knownId}
        control={<Switch id={knownId} checked={settings.scanKnownLocations} onCheckedChange={(on) => save.mutate({ scanKnownLocations: on })} />}
      />
      {(save.isError || rescan.isError) && <ErrorCallout error={save.error ?? rescan.error} className="mt-3" />}
    </Section>
  );
}
