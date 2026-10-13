/**
 * "Serve Docker": what to show when something needs Docker and Docker is not ready, and the one
 * button that moves it forward — "Avvia Docker" when it is off, "Riavvia Docker" when it does not
 * answer (with the last resort, explained, if a normal restart is not enough) — with progress; once
 * Docker answers, `onReady` lets the screen carry on by itself. On Linux Docker is a system service:
 * the command to run instead.
 */
import { useNavigate } from '@tanstack/react-router';
import { Check, Loader, Play, RotateCcw, TriangleAlert } from 'lucide-react';
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
  /** Start or restart at once when Docker is in that state (the user already clicked it elsewhere). */
  auto?: 'start' | 'restart';
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
  const servers = step === 'servers' && event.bytesTotal ? ` · ${event.label ?? ''} (${event.bytesDone + 1}/${event.bytesTotal})` : '';
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-live="polite">
      <div className="flex items-center gap-2 text-sm">
        <Loader aria-hidden className="size-4 shrink-0 animate-spin text-accent [animation-duration:2.4s]" />
        <span className="min-w-0 flex-1 font-medium text-fg">
          {t(`dockerFix.steps.${step}`)}
          {servers}
        </span>
        {event.step !== undefined && event.steps !== undefined && (
          <span className="shrink-0 text-xs text-fg-3 tabular-nums">{t('dockerFix.steps.stepOf', { step: event.step, steps: event.steps })}</span>
        )}
      </div>
      {step !== 'servers' && event.bytesDone > 0 && <p className="text-xs text-fg-3 tabular-nums">{t('dockerFix.elapsed', { time: duration(event.bytesDone) })}</p>}
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
export function useDockerGate({ engineLabel, onReady, auto }: DockerGateOptions): DockerGate {
  const { t } = useI18n();
  const navigate = useNavigate();
  const system = useSystemInfo();
  // LLM Bench starts and restarts Docker Desktop on Windows; elsewhere Docker is a system service.
  const control = (system.data?.os.platform ?? 'win32') === 'win32';
  const probe = useDockerProbe(true, 3000);
  const actions = useDockerActions();
  /** A start or restart begun here: its end decides what comes next. */
  const [mine, setMine] = useState<'start' | 'restart' | undefined>(auto);
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

  // The user already asked for it (the banner's "Riavvia Docker"): `mine` starts as `auto`.
  const fireAuto = useEffectEvent((what: 'start' | 'restart') => (what === 'start' ? actions.start() : actions.restart(false)));
  const autoDone = useRef(false);
  useEffect(() => {
    if (!auto || autoDone.current || !control || startActive || restartActive) return;
    if ((auto === 'start' && state === 'stopped') || (auto === 'restart' && state === 'not-responding')) {
      autoDone.current = true;
      fireAuto(auto);
    }
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
        body: null,
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

function GateDialogContent({ auto, onReady, engineLabel }: { auto?: 'start' | 'restart'; onReady: () => void; engineLabel?: string }) {
  const gate = useDockerGate({ onReady, ...(auto ? { auto } : {}), ...(engineLabel ? { engineLabel } : {}) });
  return (
    <DialogContent title={gate.title} description={gate.description} size="lg" {...(gate.actions ? { footer: gate.actions } : {})}>
      {gate.body}
    </DialogContent>
  );
}

/**
 * The gate in its own dialog (the banner's "Riavvia Docker" and "Perché e come evitarlo", the Engines
 * page): it closes by itself once Docker answers.
 */
export function DockerGateDialog({
  open,
  onOpenChange,
  auto,
  engineLabel,
  onReady,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  auto?: 'start' | 'restart';
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
      {open && <GateDialogContent {...(auto ? { auto } : {})} {...(engineLabel ? { engineLabel } : {})} onReady={ready} />}
    </Dialog>
  );
}

/** The gate as a panel on a page (the catalog, a banner's details): title, words, progress, buttons. */
export function DockerGatePanel({ gate, className, headingLevel = 2 }: { gate: DockerGate; className?: string; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const warn = gate.view !== 'ready' && gate.view !== 'checking' && gate.view !== 'starting' && gate.view !== 'restarting';
  return (
    <section className={cn('flex flex-col gap-3 rounded-xl border p-5', warn ? 'border-warning/30 bg-warning-soft' : 'border-border bg-surface', className)} aria-live="polite">
      <div className="flex items-start gap-3">
        {warn && <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-warning-text" />}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Heading className="text-md font-semibold text-fg">{gate.title}</Heading>
          {gate.description && <p className="text-sm text-fg-2">{gate.description}</p>}
        </div>
      </div>
      {gate.body}
      {gate.actions && <div className="flex flex-wrap justify-end gap-2">{gate.actions}</div>}
    </section>
  );
}
