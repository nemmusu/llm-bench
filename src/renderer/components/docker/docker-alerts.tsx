/**
 * On every page: "Docker non risponde" with "Riavvia Docker" (and why it happened, how to avoid it),
 * a restart's progress wherever it was asked from (the tray too), and our servers Docker took down
 * with "Riavvia i server che erano attivi".
 */
import { Loader, RotateCcw, ServerCrash, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { DOCKER_READY, useDockerActions, useDockerNeed, useDockerRecovery } from '../../lib/queries-docker';
import { activeEvent, useDockerStatus, useSystemInfo } from '../../lib/queries-library';
import { Button } from '../ui/button';
import { DockerGateDialog, RestartProgress } from './docker-gate';

export function DockerAlerts() {
  const { t } = useI18n();
  const status = useDockerStatus();
  const system = useSystemInfo();
  const recovery = useDockerRecovery();
  const actions = useDockerActions();
  const [dialog, setDialog] = useState<'look' | 'restart' | undefined>();
  const [need, setNeed] = useDockerNeed();
  const control = (system.data?.os.platform ?? 'win32') === 'win32';
  const restarting = activeEvent(actions.restartEvent);
  const state = status.data?.state;
  const lost = recovery.data?.servers ?? [];

  let banner = null;
  if (restarting) {
    banner = (
      <section aria-label={t('dockerFix.gate.restartingTitle')} className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-5 py-4 shadow-xs">
        <p className="text-sm font-semibold text-fg">{restarting.stage === 'servers' ? t('dockerFix.lost.restoring') : t('dockerFix.gate.restartingTitle')}</p>
        <RestartProgress event={restarting} />
      </section>
    );
  } else if (state === 'not-responding') {
    banner = (
      <section role="alert" className="flex flex-wrap items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-5 py-4">
        <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-danger-text" />
        <div className="flex min-w-[16rem] flex-1 flex-col gap-0.5">
          <p className="text-sm font-semibold text-fg">{t('dockerFix.banner.title')}</p>
          <p className="text-sm text-fg-2">{t('dockerFix.banner.body')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDialog('look')}>
            {t('dockerFix.banner.details')}
          </Button>
          {control && (
            <Button size="sm" variant="primary" onClick={() => setDialog('restart')}>
              <RotateCcw aria-hidden />
              {t('dockerFix.restart')}
            </Button>
          )}
        </div>
      </section>
    );
  } else if (state !== undefined && DOCKER_READY.has(state) && lost.length > 0) {
    const one = lost.length === 1 ? lost[0] : undefined;
    banner = (
      <section aria-labelledby="docker-lost-title" className="flex flex-wrap items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft px-5 py-4">
        <ServerCrash aria-hidden className="mt-0.5 size-5 shrink-0 text-warning-text" />
        <div className="flex min-w-[16rem] flex-1 flex-col gap-0.5">
          <p id="docker-lost-title" className="text-sm font-semibold text-fg">
            {one ? t('dockerFix.lost.titleOne', { name: one.name }) : t('dockerFix.lost.title', { n: lost.length })}
          </p>
          <p className="text-sm text-fg-2">{t(one ? 'dockerFix.lost.bodyOne' : 'dockerFix.lost.body')}</p>
        </div>
        {recovery.data?.restoring ? (
          <p className="flex items-center gap-2 text-sm text-fg-2">
            <Loader aria-hidden className="size-4 animate-spin text-accent" />
            {t('dockerFix.lost.restoring')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => actions.forget.mutate()} disabled={actions.forget.isPending}>
              {t('dockerFix.lost.dismiss')}
            </Button>
            <Button size="sm" variant="primary" onClick={actions.restore}>
              <RotateCcw aria-hidden />
              {t(one ? 'dockerFix.lost.restoreOne' : 'dockerFix.lost.restore')}
            </Button>
          </div>
        )}
      </section>
    );
  }

  return (
    <>
      {banner && <div className="mx-auto w-full max-w-[1240px] px-8 pt-6 compact:px-6 compact:pt-4">{banner}</div>}
      <DockerGateDialog open={dialog !== undefined} onOpenChange={(o) => !o && setDialog(undefined)} autoRestart={dialog === 'restart'} />
      {/* A screen asked for Docker (a preset started from the Server page): its retry runs once Docker answers. */}
      <DockerGateDialog
        open={need !== undefined}
        onOpenChange={(o) => !o && setNeed(undefined)}
        {...(need?.engineLabel ? { engineLabel: need.engineLabel } : {})}
        {...(need ? { onReady: need.retry } : {})}
      />
    </>
  );
}
