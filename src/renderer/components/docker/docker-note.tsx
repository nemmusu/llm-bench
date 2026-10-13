import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useDockerActions } from '../../lib/queries-docker';
import { activeEvent, useDockerStatus, useSystemInfo } from '../../lib/queries-library';
import { InstallProgress } from '../setup/install-progress';
import { Callout } from '../ui/callout';
import { DockerGateDialog, RestartProgress } from './docker-gate';

/**
 * Models for vLLM / SGLang (they run in Docker on Windows): a short note with "Avvia Docker" when
 * Docker is off, "Riavvia Docker" when it does not answer, and their progress. Nothing otherwise.
 */
export function DockerSearchNote({ className }: { className?: string }) {
  const { t } = useI18n();
  const status = useDockerStatus();
  const system = useSystemInfo();
  const actions = useDockerActions();
  const [gate, setGate] = useState(false);
  const windows = system.data?.os.platform === 'win32';
  const starting = activeEvent(actions.startEvent);
  const restarting = activeEvent(actions.restartEvent);
  const state = status.data?.state;
  let note = null;
  if (restarting) note = <RestartProgress event={restarting} className={className} />;
  else if (starting) note = <InstallProgress event={starting} label={t('engines.docker.title')} {...(className ? { className } : {})} />;
  else if (state === 'not-responding') {
    note = <Callout tone="danger" title={t('dockerFix.search.stuck')} action={{ label: t(windows ? 'dockerFix.restart' : 'dockerFix.banner.details'), onClick: () => setGate(true) }} {...(className ? { className } : {})} />;
  } else if (state === 'stopped' && windows) {
    note = <Callout tone="warning" title={t('dockerFix.search.stopped')} action={{ label: t('dockerFix.start'), onClick: actions.start }} {...(className ? { className } : {})} />;
  }
  return (
    <>
      {note}
      <DockerGateDialog open={gate} onOpenChange={setGate} {...(windows ? { auto: 'restart' as const } : {})} />
    </>
  );
}
