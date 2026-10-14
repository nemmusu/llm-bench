import { useI18n, type MessageKey } from '../../i18n';
import { cn } from '../../lib/cn';
import type { InstallEvent } from '../../lib/queries-library';
import { Progress } from '../ui/progress';

/** Stages with their own wording; anything else reads "Lavoro in corso…". */
export const KNOWN_STAGES = [
  'starting',
  'resolve',
  'download',
  'extract',
  'smoke',
  'verify',
  'installer',
  'install',
  'prepare',
  'prerequisites',
  'docker-repo',
  'docker-install',
  'nvidia-toolkit',
  'configure',
  'docker-group',
  'git-pull',
  'clone',
  'build',
] as const;

export function stageLabel(t: (k: MessageKey) => string, stage: string): string {
  return (KNOWN_STAGES as readonly string[]).includes(stage) ? t(`setup.stages.${stage as (typeof KNOWN_STAGES)[number]}`) : t('setup.stages.working');
}

export interface InstallProgressProps {
  event: InstallEvent;
  /** Accessible name of the progress bar (what is being installed). */
  label: string;
  className?: string;
}

/**
 * One running install / pull / start: stage in words, then bytes, script steps (the Linux Docker
 * script reports its step in bytesDone/bytesTotal) or elapsed time (Docker Desktop start), and a bar.
 */
export function InstallProgress({ event, label, className }: InstallProgressProps) {
  const { t, bytes, percent, duration } = useI18n();
  const stepMode = event.steps !== undefined || event.kind === 'docker-linux';
  const total = stepMode ? (event.steps ?? event.bytesTotal) : event.bytesTotal;
  const done = stepMode ? (event.step ?? event.bytesDone) : event.bytesDone;
  const ratio = total ? Math.min(1, done / total) : undefined;
  let detail = '';
  // A build's steps are compile units ("412 di 811 file", NInfer's long compiles with the time left) or
  // Make's percentage (100 "steps": the percentage says it all).
  if (ratio !== undefined && event.stage === 'build') {
    const units = total !== 100 ? `${t('setup.progress.units', { n: done, total: total as number })} · ` : '';
    const eta = event.etaSec === undefined ? '' : ` · ${event.etaSec < 60 ? t('setup.progress.etaSoon') : t('setup.progress.etaMin', { n: Math.round(event.etaSec / 60) })}`;
    detail = `${units}${percent(ratio)}${eta}`;
  } else if (ratio !== undefined) {
    detail = `${stepMode ? t('setup.progress.step', { n: done, total: total as number }) : t('setup.progress.bytes', { done: bytes(done), total: bytes(total as number) })} · ${percent(ratio)}`;
  } else if (event.state !== undefined) detail = duration(event.bytesDone);
  const stage = stageLabel(t, event.stage);
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-3 text-xs text-fg-2">
        <span className="font-medium text-fg">{stage}</span>
        <span className="tabular-nums">{detail}</span>
      </div>
      {ratio === undefined ? (
        <div role="progressbar" aria-label={label} aria-valuetext={stage} className="h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div className="skeleton-shimmer h-full w-full" />
        </div>
      ) : (
        <Progress value={ratio * 100} label={label} valueText={percent(ratio)} size="sm" />
      )}
      {event.slow && <p className="text-xs text-warning-text">{t('docker.slowStart')}</p>}
    </div>
  );
}
