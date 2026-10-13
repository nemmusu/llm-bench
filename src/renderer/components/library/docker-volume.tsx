import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Container, X } from 'lucide-react';
import type { LocalModel } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { useApi } from '../../lib/api-context';
import { activeEvent, libKeys, useDockerStatus, useInstallEvent, useStartInstall, useSystemInfo } from '../../lib/queries-library';
import { InstallProgress } from '../setup/install-progress';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { HelpTip } from '../ui/help-tip';
import { ErrorCallout } from './error-callout';

export const VOLUME_KEY = 'docker-volume';
const TARGET_KEY = ['lib', 'docker-volume-target'] as const;

/**
 * Docker Desktop (Windows, macOS) reads host folders through a slow VM share: a copy of the model
 * inside a Docker volume loads several times faster. Only offered where it helps: GGUF models,
 * Docker running, not Linux (native Docker reads the disk directly).
 */
export function useVolumeSupport(): { enabled: boolean; copied: Set<string> } {
  const api = useApi();
  const system = useSystemInfo();
  const docker = useDockerStatus();
  const enabled = docker.data?.state === 'running' && system.data !== undefined && system.data.os.platform !== 'linux';
  const list = useQuery({
    queryKey: libKeys.volumes,
    queryFn: () => api.get<{ localIds: string[] }>('/api/docker/model-volumes'),
    enabled,
  });
  return { enabled, copied: new Set(list.data?.localIds) };
}

export function DockerVolumeAction({ model, copied }: { model: LocalModel; copied: boolean }) {
  const { t } = useI18n();
  const api = useApi();
  const qc = useQueryClient();
  const event = useInstallEvent(VOLUME_KEY);
  const start = useStartInstall();
  const target = useQuery({ queryKey: TARGET_KEY, queryFn: skipToken, initialData: '', staleTime: Infinity }).data;
  const remove = useMutation({
    mutationFn: () => api.del(`/api/docker/model-volumes/${encodeURIComponent(model.id)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: libKeys.volumes }),
  });
  const mine = target === model.id;
  const running = mine ? activeEvent(event) : undefined;
  const name = model.identity.displayName;

  if (running) return <InstallProgress event={running} label={t('models.volume.copying', { name })} className="mt-1 max-w-md" />;
  if (copied) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="success" size="sm">
          <Check aria-hidden />
          {t('models.volume.copied')}
        </Badge>
        <IconButton size="sm" label={t('models.volume.remove', { name })} icon={<X />} onClick={() => remove.mutate()} disabled={remove.isPending} />
        {remove.isError && <ErrorCallout error={remove.error} className="w-full" />}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      {/* Why, behind the "?": the same sentence under every model of the list was noise. */}
      <span className="-ml-2.5 inline-flex items-center gap-0.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={start.isPending}
          onClick={() => {
            qc.setQueryData(TARGET_KEY, model.id);
            start.mutate({ key: VOLUME_KEY, path: '/api/docker/model-volumes', body: { localId: model.id } });
          }}
          aria-label={`${t('models.volume.copy')}: ${name}`}
        >
          <Container aria-hidden />
          {t('models.volume.copy')}
        </Button>
        <HelpTip term={t('models.volume.copy')}>{t('models.volume.hint')}</HelpTip>
      </span>
      {mine && event?.stage === 'error' && <ErrorCallout error={event.error ?? { code: 'DOCKER_VOLUME_FAILED', message: 'copy' }} className="w-full" />}
    </div>
  );
}
