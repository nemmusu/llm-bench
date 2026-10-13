/**
 * "Serve Docker": what to show when something needs Docker and Docker is not ready, and the one
 * button that moves it forward — "Avvia Docker" when it is off, "Riavvia Docker" when it does not
 * answer (with the last resort, explained, if a normal restart is not enough) — with progress; once
 * Docker answers, `onReady` lets the screen carry on by itself. On Linux Docker is a system service:
 * the command to run instead.
 */
import { useNavigate } from '@tanstack/react-router';
import { Check, Container, Loader, Play, RotateCcw } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { DOCKER_RESTART_STEPS, type DockerState } from '../../../contract/docker';
import type { AppErrorData, ErrorCode } from '../../../contract/errors';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { DOCKER_READY, useDockerActions, useDockerProbe } from '../../lib/queries-docker';
import { activeEvent, errorData, useSystemInfo, type InstallEvent } from '../../lib/queries-library';
import { ErrorCallout } from '../library/error-callout';
import { Button } from '../ui/button';
import { CodeBlock } from '../ui/code-block';
import { Dialog, DialogContent } from '../ui/dialog';
import { Progress } from '../ui/progress';
import { DockerCause } from './docker-cause';

export type GateView = 'checking' | 'ready' | 'stopped' | 'starting' | 'stuck' | 'restarting' | 'deep' | 'failed' | 'error' | 'manual-start' | 'manual-restart' | 'other';

export interface DockerGate {
  view: GateView;
  title: string;
  description?: string;
  body: ReactNode;
  /** The buttons that move it forward. */
  actions: ReactNode;
}

export interface DockerGateOptions {
  /** What needs Docker ("vLLM (Docker)"); absent when it is Docker itself (the banner, the Engines page). */
  engineLabel?: string;
  /** Docker answers: carry on with what the user was doing (called once). */
  onReady: () => void;
  /** Restart at once when Docker does not answer (the user already clicked "Riavvia Docker" elsewhere). */
  autoRestart?: boolean;
}

/** The error a state stands for, for the states no button here can fix. */
const CODE: Partial<Record<DockerState, ErrorCode>> = {
  'not-installed': 'DOCKER_NOT_INSTALLED',
  'no-permission': 'DOCKER_PERMISSION',
  unsupported: 'DOCKER_UNSUPPORTED',
};

/** The restart's step in words, its place among the steps, how long it has been going, the slow hint. */
export function RestartProgress({ event, className }: { event: InstallEvent; className?: string }) {
  const { t, duration } = useI18n();
  const step = (DOCKER_RESTART_STEPS as readonly string[]).includes(event.stage) ? (event.stage as (typeof DOCKER_RESTART_STEPS)[number]) : 'restart';
  const servers = step === 'servers' && event.bytesTotal ? `${event.label ? ` · ${event.label}` : ''} (${event.bytesDone + 1}/${event.bytesTotal})` : '';
  const label = `${t(`dockerFix.steps.${step}`)}${servers}`;
  // Before the first step is known (the click's own marker): at the start of the bar.
  const steps = event.steps ?? 3;
  const at = event.step ?? 1;
  const stepOf = t('dockerFix.steps.stepOf', { step: at, steps });
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-live="polite">
      <div className="flex items-center gap-2 text-sm">
        <Loader aria-hidden className="size-4 shrink-0 animate-spin text-accent [animation-duration:2.4s]" />
        <span className="min-w-0 flex-1 font-medium text-fg">{label}</span>
        <span className="shrink-0 text-xs text-fg-3 tabular-nums">{stepOf}</span>
      </div>
      {/* Each step half done while it runs: the bar moves at every step. */}
      <Progress size="sm" value={(100 * (at - 0.5)) / steps} label={t('dockerFix.gate.restartingTitle')} valueText={`${stepOf} · ${label}`} />
      {step !== 'servers' && event.bytesDone >= 1000 && <p className="text-xs text-fg-3 tabular-nums">{t('dockerFix.elapsed', { time: duration(event.bytesDone) })}</p>}
      {event.slow && <p className="text-xs text-warning-text">{t('dockerFix.slow')}</p>}
    </div>
  );
}

function Waiting({ ms, slow }: { ms: number | undefined; slow: boolean | undefined }) {
  const { t, duration } = useI18n();
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <p className="flex items-center gap-2 text-sm text-fg-2">
        <Loader aria-hidden className="size-4 animate-spin text-accent [animation-duration:2.4s]" />
        {ms ? t('dockerFix.elapsed', { time: duration(ms) }) : t('dockerFix.checking')}
      </p>
      {slow && <p className="text-xs text-warning-text">{t('dockerFix.slow')}</p>}
    </div>
  );
}

/** Docker's state for this screen, worked out with a real check, and what to say and offer about it. */
export function useDockerGate({ engineLabel, onReady, autoRestart }: DockerGateOptions): DockerGate {
  const { t } = useI18n();
  const navigate = useNavigate();
  const system = useSystemInfo();
  // LLM Bench starts and restarts Docker Desktop on Windows; elsewhere Docker is a system service.
  const control = (system.data?.os.platform ?? 'win32') === 'win32';
  const probe = useDockerProbe(true, 3000);
  const actions = useDockerActions();
  /** A start or restart begun here: its end decides what comes next. */
  const [mine, setMine] = useState<'start' | 'restart' | undefined>(autoRestart ? 'restart' : undefined);
  const startActive = activeEvent(actions.startEvent);
  const restartActive = activeEvent(actions.restartEvent);
  const state = probe.data?.state;
  const ready = state !== undefined && DOCKER_READY.has(state) && !startActive && !restartActive;

  const begin = (what: 'start' | 'restart', deep = false) => {
    setMine(what);
    if (what === 'start') actions.start();
    else actions.restart(deep);
  };
  const retry = () => {
    setMine(undefined);
    void probe.refetch();
  };

  // A start or restart ended (here, from the tray, from another screen): look again.
  const startStage = startActive ? undefined : actions.startEvent?.stage;
  const restartStage = restartActive ? undefined : actions.restartEvent?.stage;
  const refetch = probe.refetch;
  useEffect(() => {
    if (startStage !== undefined || restartStage !== undefined) void refetch();
  }, [startStage, restartStage, refetch]);

  const fireReady = useEffectEvent(() => onReady());
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    fireReady();
  }, [ready]);

  // The user already asked for it (the banner's "Riavvia Docker"): `mine` starts as 'restart'.
  const fireRestart = useEffectEvent(() => actions.restart(false));
  const autoDone = useRef(false);
  useEffect(() => {
    if (!autoRestart || autoDone.current || !control || restartActive || state !== 'not-responding') return;
    autoDone.current = true;
    fireRestart();
  });

  // A restart that did not bring Docker back says what to try next wherever it was asked from
  // (the banner, the tray, the Engines page); other failures only where they were asked for.
  const restartError = actions.restartEvent?.stage === 'error' ? actions.restartEvent.error : undefined;
  const startError = mine === 'start' && actions.startEvent?.stage === 'error' ? actions.startEvent.error : undefined;
  const failure: AppErrorData | undefined = startError ?? (restartError && (mine === 'restart' || restartError.code === 'DOCKER_NOT_RESPONDING') ? restartError : undefined);
  const reason = failure?.params?.reason;

  const restartButton = (
    <Button variant="primary" onClick={() => begin('restart')}>
      <RotateCcw aria-hidden />
      {t('dockerFix.restart')}
    </Button>
  );
  const retryButton = (
    <Button variant="primary" onClick={retry}>
      {t('dockerFix.retry')}
    </Button>
  );

  if (startActive) {
    return { view: 'starting', title: t('dockerFix.gate.startingTitle'), description: t('dockerFix.gate.startingBody'), body: <Waiting ms={startActive.bytesDone} slow={startActive.slow} />, actions: null };
  }
  if (restartActive) {
    return { view: 'restarting', title: t('dockerFix.gate.restartingTitle'), description: t('dockerFix.gate.restartingBody'), body: <RestartProgress event={restartActive} />, actions: null };
  }
  if (ready) {
    return {
      view: 'ready',
      title: t('dockerFix.ready'),
      body: (
        <p className="flex items-center gap-2 text-sm text-success-text">
          <Check aria-hidden className="size-4" />
          {t('dockerFix.ready')}
        </p>
      ),
      actions: null,
    };
  }
  if (failure?.code === 'DOCKER_NOT_RESPONDING' && reason === 'needs-deep') {
    return {
      view: 'deep',
      title: t('dockerFix.deep.title'),
      description: t('dockerFix.deep.body'),
      body: (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-2">{t('dockerFix.deep.safe')}</p>
          <CodeBlock commands={{ powershell: 'wsl --terminate docker-desktop', bash: 'wsl --terminate docker-desktop' }} label={t('dockerFix.deep.command')} single />
        </div>
      ),
      actions: (
        <Button variant="primary" onClick={() => begin('restart', true)}>
          <RotateCcw aria-hidden />
          {t('dockerFix.deep.confirm')}
        </Button>
      ),
    };
  }
  if (failure?.code === 'DOCKER_NOT_RESPONDING' && (reason === 'restart-failed' || reason === 'no-desktop-cli')) {
    return {
      view: 'failed',
      title: t('dockerFix.failed.title'),
      description: t(reason === 'no-desktop-cli' ? 'dockerFix.failed.noCli' : 'dockerFix.failed.body'),
      body: <DockerCause windows={control} />,
      actions: retryButton,
    };
  }
  if (failure && failure.code !== 'DOCKER_NOT_RESPONDING' && failure.code !== 'CANCELLED') {
    return { view: 'error', title: t(`errors.${failure.code}.title`, failure.params), body: <ErrorCallout error={failure} />, actions: retryButton };
  }
  if (!probe.data) {
    if (probe.isError) {
      const e = errorData(probe.error);
      return { view: 'error', title: t(`errors.${e.code}.title`, e.params), body: <ErrorCallout error={e} />, actions: retryButton };
    }
    return { view: 'checking', title: t('dockerFix.checking'), body: <Waiting ms={undefined} slow={false} />, actions: null };
  }
  const s = probe.data;
  switch (s.state) {
    case 'stopped':
      if (!control) {
        return {
          view: 'manual-start',
          title: t('dockerFix.gate.linuxTitle'),
          description: t('dockerFix.gate.linuxBody'),
          body: <CodeBlock commands={{ powershell: 'sudo systemctl start docker', bash: 'sudo systemctl start docker' }} label={t('dockerFix.gate.linuxTitle')} defaultShell="bash" single />,
          actions: retryButton,
        };
      }
      return {
        view: 'stopped',
        title: t('dockerFix.gate.stoppedTitle'),
        description: engineLabel ? t('dockerFix.gate.stoppedBody', { engine: engineLabel }) : t('dockerFix.gate.stoppedBodyPlain'),
        body: (
          <p className="flex items-center gap-2 text-xs text-fg-3">
            <Container aria-hidden className="size-4 shrink-0" />
            {t('dockerFix.gate.stoppedHint')}
          </p>
        ),
        actions: (
          <Button variant="primary" onClick={() => begin('start')}>
            <Play aria-hidden />
            {t('dockerFix.start')}
          </Button>
        ),
      };
    case 'starting':
      return { view: 'starting', title: t('dockerFix.gate.startingTitle'), description: t('dockerFix.gate.startingBody'), body: <Waiting ms={s.startingForMs} slow={false} />, actions: null };
    case 'not-responding':
      if (!control) {
        return {
          view: 'manual-restart',
          title: t('dockerFix.gate.stuckTitle'),
          description: t('dockerFix.gate.linuxStuckBody'),
          body: <CodeBlock commands={{ powershell: 'sudo systemctl restart docker', bash: 'sudo systemctl restart docker' }} label={t('dockerFix.gate.stuckTitle')} defaultShell="bash" single />,
          actions: retryButton,
        };
      }
      return { view: 'stuck', title: t('dockerFix.gate.stuckTitle'), description: t('dockerFix.gate.stuckBody'), body: <DockerCause windows />, actions: restartButton };
    default: {
      const code = CODE[s.state] ?? 'DOCKER_NOT_RUNNING';
      return {
        view: 'other',
        title: t('dockerFix.gate.otherTitle'),
        body: <ErrorCallout error={{ code, message: s.detail ?? s.state }} />,
        actions: (
          <>
            <Button onClick={retry}>{t('dockerFix.retry')}</Button>
            <Button variant="primary" onClick={() => void navigate({ to: '/engines' })}>
              {t('fixes.engines')}
            </Button>
          </>
        ),
      };
    }
  }
}

function GateDialogContent({ autoRestart, onReady, engineLabel }: { autoRestart: boolean; onReady: () => void; engineLabel?: string }) {
  const gate = useDockerGate({ onReady, autoRestart, ...(engineLabel ? { engineLabel } : {}) });
  return (
    <DialogContent title={gate.title} description={gate.description} size="lg" {...(gate.actions ? { footer: gate.actions } : {})}>
      {gate.body}
    </DialogContent>
  );
}

/**
 * The gate in its own dialog (the banner's "Riavvia Docker" and "Perché e come evitarlo", the Engines
 * page, a preset that needs Docker): it closes by itself once Docker answers, then `onReady`.
 */
export function DockerGateDialog({
  open,
  onOpenChange,
  autoRestart = false,
  engineLabel,
  onReady,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The user already clicked "Riavvia Docker". */
  autoRestart?: boolean;
  engineLabel?: string;
  /** Docker answers (after the dialog closed): carry on with what needed it. */
  onReady?: () => void;
}) {
  const ready = () => {
    onOpenChange(false);
    onReady?.();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <GateDialogContent autoRestart={autoRestart} {...(engineLabel ? { engineLabel } : {})} onReady={ready} />}
    </Dialog>
  );
}
