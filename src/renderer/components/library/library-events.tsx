import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { DownloadJob, LocalModel } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { libKeys, useLibraryEvents } from '../../lib/queries-library';
import { useSettings } from '../../lib/settings';
import { fileName } from './helpers';

/** The library model a finished download produced (same repo, same main file). */
export function modelFromJob(models: readonly LocalModel[] | undefined, job: DownloadJob): LocalModel | undefined {
  const names = new Set(job.files.map((f) => fileName(f.path)));
  return models?.find((m) => m.identity.repo === job.repo && names.has(fileName(m.identity.file ?? '')));
}

/** Listens to downloads / installs for the whole app (mounted once by the shell). Renders nothing. */
export function LibraryEvents() {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { update } = useSettings();
  useLibraryEvents(lang, (job) => {
    const model = modelFromJob(qc.getQueryData<LocalModel[]>(libKeys.local), job);
    if (model) update({ lastModelId: model.id });
    void navigate({ to: '/' });
  });
  return null;
}
