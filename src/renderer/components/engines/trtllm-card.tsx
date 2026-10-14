/**
 * TensorRT-LLM on the Engines page: NVIDIA's engine in its two ways, Docker (the official NGC image) and
 * native (LLM Bench's own environment; inside WSL on Windows), each with its own state in the switch and
 * one thing to do.
 */
import { Cpu } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useDockerStatus, useEngineStatuses, useMainGpu, useSystemInfo } from '../../lib/queries-library';
import { useLocalImages } from '../../lib/queries-images';
import { TRTLLM_REPO, useTrtllmTags } from '../../lib/queries-trtllm';
import { useSettings } from '../../lib/settings';
import { Badge } from '../ui/badge';
import { Callout } from '../ui/callout';
import { SegmentedControl } from '../ui/segmented-control';
import { Skeleton } from '../ui/skeleton';
import { EngineCard } from './engine-card';
import { TrtllmDocker } from './trtllm-docker';
import { dockerModeState, initialMode, nativeModeState, trtllmStatus, trtllmVersions, type TrtllmMode } from './trtllm-format';
import { TrtllmNative } from './trtllm-native';

/** A GeForce RTX 50 (sm_120): not in TensorRT-LLM's support matrix yet (Blackwell datacenter, Hopper, Ada, Ampere are). */
export function isRtx50(gpu: { name?: string | undefined; computeCapability?: string | undefined } | undefined): boolean {
  return gpu?.computeCapability === '12.0' || /rtx\s*50\d0/i.test(gpu?.name ?? '');
}

export function TrtllmCard() {
  const { t } = useI18n();
  const { settings } = useSettings();
  const engines = useEngineStatuses();
  const docker = useDockerStatus();
  const system = useSystemInfo();
  const gpu = useMainGpu();
  const dockerState = docker.data?.state;
  const tags = useTrtllmTags(true);
  const images = useLocalImages(TRTLLM_REPO, dockerState === 'running');
  const dockerStatus = engines.data?.find((e) => e.kind === 'trtllm-docker');
  const nativeStatus = engines.data?.find((e) => e.kind === 'trtllm-native');
  const versions = trtllmVersions(TRTLLM_REPO, tags.data ?? [], images.data, dockerStatus);
  const dockerMode = dockerModeState(versions, dockerState);
  const nativeMode = nativeModeState(nativeStatus);
  const [picked, setPicked] = useState<TrtllmMode>();
  const mode = picked ?? initialMode(settings.lastEngine, dockerMode, nativeMode);
  const windows = system.data?.os.platform === 'win32';
  const loaded = engines.data !== undefined;
  const status = trtllmStatus(versions.some((v) => v.local), nativeStatus?.installed === true, dockerMode, nativeMode);
  return (
    <EngineCard
      icon={<Cpu />}
      title={t('trtllm.title')}
      description={t('trtllm.desc')}
      badge={
        <Badge tone="outline" size="sm">
          {t('trtllm.badge')}
        </Badge>
      }
      status={loaded ? { tone: status.tone, text: t(`trtllm.status.${status.key}`) } : { tone: 'neutral', text: t('common.loading') }}
    >
      {/* Said plainly, no promises: NVIDIA does not list these cards yet. */}
      {isRtx50(gpu) && <Callout tone="warning" title={t('trtllm.rtx50Title')}>{t('trtllm.rtx50')}</Callout>}
      <SegmentedControl<TrtllmMode>
        label={t('trtllm.modes.label')}
        value={mode}
        onValueChange={setPicked}
        fullWidth
        options={[
          { value: 'docker', label: t('trtllm.modes.docker'), sublabel: loaded ? t(`trtllm.status.${dockerMode}`) : undefined },
          { value: 'native', label: t(windows ? 'trtllm.modes.wsl' : 'trtllm.modes.native'), sublabel: loaded ? t(`trtllm.status.${nativeMode}`) : undefined },
        ]}
      />
      <p className="text-sm text-fg-2">{mode === 'docker' ? t(windows ? 'trtllm.modeDesc.dockerWindows' : 'trtllm.modeDesc.docker') : t(windows ? 'trtllm.modeDesc.wsl' : 'trtllm.modeDesc.native')}</p>
      {!loaded || (mode === 'docker' && tags.isPending) ? (
        <Skeleton className="h-24" />
      ) : mode === 'docker' ? (
        <TrtllmDocker versions={versions} offline={tags.isError} onRetry={() => void tags.refetch()} dockerState={dockerState} defaultImage={dockerStatus?.location} />
      ) : (
        <TrtllmNative status={nativeStatus} wsl={windows} />
      )}
    </EngineCard>
  );
}
