import { toast } from 'sonner';
import { useI18n } from '../../i18n';
import type { useRescan, useSaveFoldersAndRescan } from '../../lib/queries-library';
import { useSettings } from '../../lib/settings';

/**
 * "Aggiungi cartella": a new folder is saved and scanned; one already in the list is scanned again
 * (the user just put models there). Either way a toast says what happened, with the folder.
 */
export function useAddModelFolder(save: ReturnType<typeof useSaveFoldersAndRescan>, rescan: ReturnType<typeof useRescan>): (title: string) => Promise<void> {
  const { t } = useI18n();
  const { settings } = useSettings();
  return async (title) => {
    const dir = await window.gpubench?.pickFolder({ title });
    if (!dir) return;
    if (settings.extraModelDirs.includes(dir)) rescan.mutate(undefined, { onSuccess: () => void toast.info(t('models.folderRescanned'), { description: dir }) });
    else save.mutate({ extraModelDirs: [...settings.extraModelDirs, dir] }, { onSuccess: () => void toast.success(t('models.folderAdded'), { description: dir }) });
  };
}
