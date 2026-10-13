import { Check, FlaskConical } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useSglangTags } from '../../lib/queries-engines';
import { activeEvent, useDockerStatus, useEngineStatuses, useInstallEvent, useSaveEngine, useStartInstall, useSystemCheck } from '../../lib/queries-library';
import { useSettings } from '../../lib/settings';
import { ErrorCallout } from '../library/error-callout';
import { InstallProgress } from '../setup/install-progress';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { PullButton } from './docker-card';
import { EngineCard } from './engine-card';
import { EngineUpdatePanel } from './engine-update';

export const SGLANG_REPO = 'lmsysorg/sglang';
const PREVIEW = 6;

/**
 * SGLang in Docker (Windows through Docker Desktop's WSL2 GPU, Linux with the NVIDIA toolkit): the
 * release tags from Docker Hub, the recommended one marked, each with its size and a download button.
 */
export function SglangDockerCard() {
  const { t, bytes, date } = useI18n();
  const { settings } = useSettings();
  const docker = useDockerStatus();
  const tags = useSglangTags(true);
  const save = useSaveEngine();
  const [all, setAll] = useState(false);
  const running = docker.data?.state === 'running';
  const last = settings.lastEngine;
  const current = last?.kind === 'sglang-docker' && last.customEngineId === undefined ? last.image : undefined;
  const list = tags.data ?? [];
  const shown = all ? list : list.slice(0, PREVIEW);
  return (
    <EngineCard
      icon={<FlaskConical />}
      title={t('engines.sglang.dockerTitle')}
      description={t('engines.sglang.dockerDesc')}
      status={running ? { tone: 'success', text: t('engines.status.ready') } : { tone: 'warning', text: t('engines.status.needsDocker') }}
    >
      {tags.isError && <ErrorCallout error={tags.error} />}
      {tags.isPending && <Skeleton className="h-24" />}
      {list.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border" aria-label={t('engines.sglang.tags')}>
          {shown.map((tag) => {
            const image = `${SGLANG_REPO}:${tag.name}`;
            return (
              <li key={tag.name} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-fg">{tag.name}</span>
                    {tag.recommended && (
                      <Badge size="sm" tone="accent">
                        {t('common.recommended')}
                      </Badge>
                    )}
                    {current === image && (
                      <Badge size="sm" tone="success">
                        <Check aria-hidden />
                        {t('engines.llama.inUse')}
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs text-fg-3 tabular-nums">
                    {[tag.cuda ? `CUDA ${tag.cuda}` : undefined, tag.sizeBytes ? bytes(tag.sizeBytes) : undefined, tag.lastUpdated ? date(tag.lastUpdated) : undefined].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {current !== image && (
                  <Button size="sm" variant="ghost" onClick={() => save.mutate({ kind: 'sglang-docker', image })}>
                    {t('engines.sglang.use')}
                  </Button>
                )}
                <PullButton engine="sglang-docker" image={image} label={t('engines.sglang.pull')} disabled={!running} />
              </li>
            );
          })}
        </ul>
      )}
      {list.length > PREVIEW && (
        <Button variant="link" className="self-start" onClick={() => setAll((a) => !a)}>
          {all ? t('models.curated.less') : t('engines.sglang.allTags', { n: list.length })}
        </Button>
      )}
      <EngineUpdatePanel target="sglang-docker" name={t('engines.sglang.dockerTitle')} enabled={running} />
      {save.isError && <ErrorCallout error={save.error} />}
    </EngineCard>
  );
}

/** SGLang installed on Linux, in its own environment through uv (uv first when it is missing). Hidden where it cannot run. */
export function SglangNativeCard() {
  const { t } = useI18n();
  const engines = useEngineStatuses();
  const check = useSystemCheck();
  const start = useStartInstall();
  const status = engines.data?.find((e) => e.kind === 'sglang-native');
  // uv comes with the vLLM check item: the same installer serves both.
  const needsUv = check.data?.items.find((i) => i.id === 'vllm-native')?.action?.kind === 'install-uv';
  const key = needsUv ? 'uv' : 'sglang-native';
  const event = useInstallEvent(key);
  const running = activeEvent(event);
  if (!status || status.supported === false) return null;
  return (
    <EngineCard
      icon={<FlaskConical />}
      title={t('engines.sglang.nativeTitle')}
      description={t('engines.sglang.nativeDesc')}
      status={status.available ? { tone: 'success', text: t('engines.status.ready') } : { tone: 'neutral', text: t('engines.status.notInstalled') }}
      footer={
        status.available ? undefined : running ? (
          <InstallProgress event={running} label={t('engines.sglang.nativeTitle')} className="w-full" />
        ) : (
          <Button size="sm" onClick={() => start.mutate({ key, path: needsUv ? '/api/setup/uv/install' : '/api/engines/sglang-native/install' })}>
            {needsUv ? t('setup.actions.install-uv') : t('engines.sglang.install')}
          </Button>
        )
      }
    >
      {status.version && <p className="text-sm text-fg-2">{t('engines.sglang.nativeVersion', { version: status.version })}</p>}
      <EngineUpdatePanel target="sglang-native" name={t('engines.sglang.nativeTitle')} enabled={status.available} />
      {event?.stage === 'error' && <ErrorCallout error={event.error ?? { code: 'ENGINE_INSTALL_FAILED', message: key }} />}
    </EngineCard>
  );
}
