/**
 * The dialogs of the start flow (see start-flow.tsx), for a benchmark and for a server: the downloads
 * confirmation (benchmarks; a server is confirmed on its own page), installs and downloads with
 * progress, the "GPU busy" question, starting (a server can go on in the background), the failure.
 */
import { Box, Check, Container, Download, Loader, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RunPlan, ServerInfo, ServerPlan, StartRunRequest, StartServerRequest } from '../../../contract/api';
import type { AppErrorData } from '../../../contract/errors';
import { useI18n, type MessageKey } from '../../i18n';
import { useServers } from '../../lib/queries-runs';
import { useDockerGate } from '../docker/docker-gate';
import { NinferGateContent } from '../engines/ninfer-all-gate';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Progress } from '../ui/progress';
import { ErrorCard, fixFor } from './error-card';
import { LoadLine } from './load-line';
import type { Need } from './needs';

/** While a server starts: what the engine is doing (the core lists a server as soon as it is launched). */
function ServerLoading({ port }: { port: number | undefined }) {
  const servers = useServers(1000);
  const s = servers.data?.filter((x) => x.loading && (port === undefined || x.port === port)).at(-1);
  return s?.loading ? <LoadLine progress={s.loading} engineKind={s.engineKind} className="mt-3" /> : null;
}

/** What is being started: a benchmark (then the live screen) or a server (then the Server page). */
export type Job =
  | { mode: 'run'; request: StartRunRequest; onStarted?: (runId: string) => void }
  | {
      mode: 'serve';
      request: StartServerRequest;
      onStarted?: (info: ServerInfo) => void;
      /** The user said "Continua comunque" to a busy GPU. */
      sharedOk?: boolean;
    };

export type Mode = Job['mode'];

/** What the dialogs show about a job. */
export interface FlowOpts {
  /** What to fetch first: the plan's list, or a guess when no plan could be made. */
  needs: Need[];
  plan?: RunPlan | ServerPlan;
  /** Why no plan could be made. */
  planError?: AppErrorData;
  /** Also the name of the model download in the confirmation and in the downloads panel. */
  modelLabel: string;
  engineLabel: string;
}

export interface StepProgress {
  need: Need;
  state: 'pending' | 'running' | 'done' | 'failed';
  stage?: string;
  done?: number;
  total?: number;
}

export type Pre = { install: boolean; download: boolean };

export type Flow =
  | { step: 'idle' }
  | { step: 'confirm'; job: Job; opts: FlowOpts }
  | { step: 'fetching'; job: Job; opts: FlowOpts; progress: StepProgress[]; error?: AppErrorData }
  | { step: 'busy'; job: Job; opts: FlowOpts; names: string; ownServers: ServerInfo[] }
  /** `planning`: the preview of these exact choices is still on its way. */
  | { step: 'starting'; job: Job; opts: FlowOpts; planning?: boolean }
  /** A Docker engine and Docker is off or does not answer: "Avvia Docker" / "Riavvia Docker", then `resume`. */
  | { step: 'docker'; job: Job; opts: FlowOpts; resume: () => void }
  /** A .ninfer model only NInfer-all reads, and NInfer-all is not built yet: its guided build, then `resume`. */
  | { step: 'ninfer'; job: Job; opts: FlowOpts; resume: () => void }
  | { step: 'error'; job: Job; opts: FlowOpts; error: AppErrorData };

/** The same job, acknowledged to run on a GPU other programs are using. */
export function sharedJob(job: Job): Job {
  return job.mode === 'run' ? { ...job, request: { ...job.request, allowSharedGpu: true } } : { ...job, sharedOk: true };
}

/** Words that differ between a benchmark and a server. */
const TEXT: Record<
  Mode,
  {
    planning: [MessageKey, MessageKey];
    starting: [MessageKey, MessageKey];
    progress: [MessageKey, MessageKey];
    failedTitle: MessageKey;
    startFailed: MessageKey;
    busyBody: MessageKey;
    modelWhy: MessageKey;
  }
> = {
  run: {
    planning: ['benchmark.starting', 'benchmark.startingBody'],
    starting: ['benchmark.starting', 'benchmark.startingBody'],
    progress: ['benchmark.needs.progressTitle', 'benchmark.needs.progressBody'],
    failedTitle: 'benchmark.needs.failedTitle',
    startFailed: 'benchmark.startFailed',
    busyBody: 'benchmark.busy.body',
    modelWhy: 'benchmark.needs.modelWhy',
  },
  serve: {
    planning: ['servers.flow.title', 'servers.flow.planning'],
    starting: ['servers.flow.startingTitle', 'servers.starting'],
    progress: ['servers.flow.progressTitle', 'servers.flow.progressBody'],
    failedTitle: 'servers.flow.failedTitle',
    startFailed: 'servers.flow.startFailed',
    busyBody: 'servers.flow.busyBody',
    modelWhy: 'servers.flow.modelWhy',
  },
};

const NEED_ICONS = { engine: Box, image: Container, model: Download } as const;

/** "Installo llama.cpp", "Scarico l'immagine …", "Scarico Qwen3 4B · Q4_K_M", and why (the model's depends on the mode). */
const NEED_WHAT = { engine: 'benchmark.needs.installEngine', image: 'benchmark.needs.pullImage', model: 'benchmark.needs.downloadModel' } as const;
const NEED_WHY = { engine: 'benchmark.needs.engineWhy', image: 'benchmark.needs.imageWhy' } as const;

/** What gets installed or downloaded first, with sizes. */
export function NeedList({ needs, mode }: { needs: Need[]; mode: Mode }) {
  const { t, bytes } = useI18n();
  return (
    <ul className="flex flex-col gap-2">
      {needs.map((n) => {
        const Icon = NEED_ICONS[n.kind];
        return (
          <li key={n.label} className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
            <Icon aria-hidden className="size-4 shrink-0 text-accent-text" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium break-words text-fg">{t(NEED_WHAT[n.kind], { name: n.label })}</span>
              <span className="text-xs text-fg-3">{t(n.kind === 'model' ? TEXT[mode].modelWhy : NEED_WHY[n.kind])}</span>
            </span>
            <span className="shrink-0 font-medium text-fg tabular-nums">{n.bytes === undefined ? t('benchmark.needs.sizeUnknown') : bytes(n.bytes)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function NeedRow({ p }: { p: StepProgress }) {
  const { t, bytes, integer } = useI18n();
  const Icon = NEED_ICONS[p.need.kind];
  // A total always comes with the bytes done.
  const pct = p.total ? Math.min(100, (100 * p.done!) / p.total) : p.state === 'done' ? 100 : 0;
  const stage =
    p.state === 'done'
      ? t('benchmark.needs.ready')
      : p.state === 'pending'
        ? t('benchmark.needs.waiting')
        : p.state === 'failed'
          ? t('benchmark.needs.failed')
          : t(`benchmark.needs.stage.${stageKey(p.stage)}`);
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-3">
        <Icon aria-hidden className="size-4 shrink-0 text-accent-text" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{p.need.label}</span>
        {p.state === 'done' ? (
          <Check aria-hidden className="size-4 text-success-text" />
        ) : p.state === 'running' ? (
          <Loader aria-hidden className="size-4 animate-spin text-accent [animation-duration:2.4s]" />
        ) : p.state === 'failed' ? (
          <TriangleAlert aria-hidden className="size-4 text-danger-text" />
        ) : null}
        <span className="text-xs text-fg-3 tabular-nums">{stage}</span>
      </div>
      <Progress
        size="sm"
        value={pct}
        tone={p.state === 'done' ? 'success' : 'accent'}
        label={p.need.label}
        valueText={p.total ? t('benchmark.needs.bytesOf', { done: bytes(p.done!), total: bytes(p.total) }) : `${integer(pct)}%`}
      />
    </li>
  );
}

/** Install stages and download states shown with words. */
function stageKey(stage: string | undefined): 'resolve' | 'download' | 'extract' | 'smoke' | 'verifying' | 'queued' | 'working' {
  switch (stage) {
    case 'resolve':
    case 'download':
    case 'extract':
    case 'smoke':
    case 'verifying':
    case 'queued':
      return stage;
    case 'running':
      return 'download';
    default:
      return 'working';
  }
}

export interface StartDialogsProps {
  flow: Flow;
  onClose: () => void;
  /** Go: fetch what is missing first (the confirmation is shown only when something is). */
  onConfirm: (job: Job, opts: FlowOpts) => Promise<void>;
  /** POST the start again (after "Continua comunque", or a retry). */
  onContinue: (job: Job, opts: FlowOpts, pre: Pre) => Promise<void>;
  onStopServers: (job: Job, opts: FlowOpts, servers: ServerInfo[]) => Promise<void>;
  /** "Continua in background" while a server loads. */
  onBackground: () => void;
}

/** "Serve Docker": the gate's words and buttons in the start dialog; carries on by itself once Docker answers. */
function DockerStep({ flow, onClose }: { flow: Extract<Flow, { step: 'docker' }>; onClose: () => void }) {
  const { t } = useI18n();
  const gate = useDockerGate({ engineLabel: flow.opts.engineLabel, onReady: flow.resume });
  return (
    <DialogContent
      title={gate.title}
      description={gate.description}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          {gate.actions}
        </>
      }
    >
      {gate.body}
    </DialogContent>
  );
}

export function StartDialogs({ flow, onClose, onConfirm, onContinue, onStopServers, onBackground }: StartDialogsProps) {
  const { t, bytes } = useI18n();
  const open = flow.step !== 'idle';
  let content: ReactNode = null;
  if (flow.step === 'docker') content = <DockerStep flow={flow} onClose={onClose} />;
  // "Questo modello funziona solo con NInfer-all": its build, then the start carries on by itself.
  else if (flow.step === 'ninfer') content = <NinferGateContent onReady={flow.resume} onClose={onClose} />;
  else if (flow.step === 'confirm') {
    const total = flow.opts.needs.reduce((a, n) => a + (n.bytes ?? 0), 0);
    content = (
      <DialogContent
        title={t('benchmark.needs.title')}
        description={total ? t('benchmark.needs.descriptionSize', { size: bytes(total) }) : t('benchmark.needs.description')}
        footer={
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => void onConfirm(flow.job, flow.opts)}>
              <Download aria-hidden />
              {t('benchmark.needs.confirm')}
            </Button>
          </>
        }
      >
        <NeedList needs={flow.opts.needs} mode="run" />
        <p className="mt-3 text-xs text-fg-3">{t('benchmark.needs.once')}</p>
      </DialogContent>
    );
  } else if (flow.step === 'fetching') {
    const done = flow.progress.every((p) => p.state === 'done');
    const text = TEXT[flow.job.mode];
    content = (
      <DialogContent
        title={flow.error ? t(text.failedTitle) : t(text.progress[0])}
        description={flow.error ? undefined : t(text.progress[1])}
        footer={
          flow.error ? (
            <>
              <Button onClick={onClose}>{t('common.close')}</Button>
              <Button variant="primary" onClick={() => void onConfirm(flow.job, flow.opts)}>
                {t('common.retry')}
              </Button>
            </>
          ) : (
            <Button onClick={onClose} disabled={done}>
              {t('common.cancel')}
            </Button>
          )
        }
      >
        <div className="flex flex-col gap-3" aria-live="polite">
          <ul className="flex flex-col gap-2">
            {flow.progress.map((p) => (
              <NeedRow key={p.need.label} p={p} />
            ))}
          </ul>
          {flow.error && <ErrorCard error={flow.error} headingLevel={3} />}
        </div>
      </DialogContent>
    );
  } else if (flow.step === 'busy') {
    const own = flow.ownServers.length > 0;
    content = (
      <DialogContent
        title={t(own ? 'benchmark.busy.ownTitle' : 'benchmark.busy.title')}
        description={t(own ? 'benchmark.busy.ownBody' : TEXT[flow.job.mode].busyBody)}
        footer={
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            {own ? (
              <Button variant="primary" onClick={() => void onStopServers(flow.job, flow.opts, flow.ownServers)}>
                {t('benchmark.busy.stopServers')}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void onContinue(sharedJob(flow.job), flow.opts, { install: false, download: false })}>
                {t('benchmark.busy.continue')}
              </Button>
            )}
          </>
        }
      >
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-text" />
          <div className="flex flex-col gap-1">
            <span className="font-medium text-fg">{t('benchmark.busy.who')}</span>
            <span className="text-fg-2">{own ? flow.ownServers.map((s) => `${s.modelName} · ${s.baseUrl}`).join(', ') : flow.names || t('benchmark.busy.unknown')}</span>
          </div>
        </div>
        <p className="mt-3 text-xs text-fg-3">{t(own ? 'benchmark.busy.ownHint' : 'benchmark.busy.hint')}</p>
      </DialogContent>
    );
  } else if (flow.step === 'starting') {
    const [title, body] = TEXT[flow.job.mode][flow.planning ? 'planning' : 'starting'];
    const serving = flow.job.mode === 'serve' && !flow.planning;
    content = (
      <DialogContent title={t(title)} {...(serving ? { footer: <Button onClick={onBackground}>{t('servers.flow.background')}</Button> } : {})}>
        <p className="flex items-center gap-2 text-sm text-fg-2" aria-live="polite">
          <Loader aria-hidden className="size-4 animate-spin text-accent" />
          {t(body)}
        </p>
        {serving && <ServerLoading port={(flow.job.request as StartServerRequest).port} />}
      </DialogContent>
    );
  } else if (flow.step === 'error') {
    const again = () => void onContinue(flow.job, flow.opts, { install: false, download: false });
    content = (
      <DialogContent title={t(TEXT[flow.job.mode].startFailed)} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
        <ErrorCard
          error={flow.error}
          headingLevel={3}
          handlers={{ retry: again }}
          extra={
            <>
              {/* An engine that did not load (the log is in the technical details) can still be tried again. */}
              {fixFor(flow.error.code) !== 'retry' && flow.error.params?.template !== 'ninfer-all' && (
                <Button size="sm" variant="ghost" onClick={again}>
                  {t('common.retry')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onClose}>
                {t('benchmark.changeChoices')}
              </Button>
            </>
          }
        />
      </DialogContent>
    );
  }
  return (
    // Radix only ever asks to close (Escape, overlay, the close button).
    <Dialog open={open} onOpenChange={onClose}>
      {content}
    </Dialog>
  );
}
