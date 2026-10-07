/**
 * The dialogs of the start flow (see start-flow.tsx), for a benchmark and for "Avvia solo il server":
 * the confirmation, installs and downloads with progress, the "GPU busy" question, starting, the
 * failure, and (servers) the address once it is ready.
 */
import { Box, Check, Container, Download, Loader, Server, Square, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RunPlan, ServerInfo, ServerPlan, StartRunRequest, StartServerRequest } from '../../../contract/api';
import type { AppErrorData } from '../../../contract/errors';
import type { LaunchParams } from '../../../contract/engines';
import { useI18n, type MessageKey } from '../../i18n';
import { Button } from '../ui/button';
import { CodeBlock } from '../ui/code-block';
import { Dialog, DialogContent } from '../ui/dialog';
import { HelpTip } from '../ui/help-tip';
import { Progress } from '../ui/progress';
import { ErrorCard, fixFor } from './error-card';
import type { Need } from './needs';
import { FitSummary, PlanWarnings } from './plan-card';
import { ServerReady, useStopServer } from './servers';
import { Link } from '@tanstack/react-router';
import { useServers } from '../../lib/queries-runs';
import { depthLabel, kvName } from '../tune/tune-format';
import { engineKindOfLabel } from './live-now';
import { LoadLine } from './load-line';

/** While "Avvia solo il server" waits: what the engine is doing (the core lists a server as soon as it is launched). */
function ServerLoading() {
  const servers = useServers(1000);
  const s = servers.data?.filter((x) => x.loading).at(-1);
  return s?.loading ? <LoadLine progress={s.loading} engineKind={engineKindOfLabel(s.engineLabel)} className="mt-3" /> : null;
}

/** What is being started: a benchmark (then the live screen) or only the server (then its address). */
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
  /** Why no plan could be made (shown in the server confirmation; the start then says it again). */
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
  | { step: 'error'; job: Job; opts: FlowOpts; error: AppErrorData }
  | { step: 'ready'; job: Job; opts: FlowOpts; server: ServerInfo };

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
function NeedList({ needs, mode }: { needs: Need[]; mode: Mode }) {
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

/** "Contesto 64K e cache q4_0 dal test «Trova le impostazioni migliori» del 07/10", with a link to that result. */
function TunedContext({ tuned }: { tuned: NonNullable<ServerPlan['tuned']> }) {
  const f = useI18n();
  const date = new Intl.DateTimeFormat(f.locale, { day: '2-digit', month: '2-digit' }).format(new Date(tuned.createdAt));
  return (
    <>
      {f.t('servers.flow.contextTuned', { ctx: depthLabel(tuned.contextSize, f), kv: kvName(tuned.kvCacheType, f), date })}{' '}
      <Link to="/results/$runId" params={{ runId: tuned.runId }} className="rounded-xs font-medium text-accent-text underline-offset-4 hover:underline focus-ring">
        {f.t('servers.flow.contextTunedLink')}
      </Link>
    </>
  );
}

/**
 * "Avvia il server": always asked, even with nothing to download. The context in plain words, the
 * VRAM verdict, what is fetched first, warnings and the exact command.
 */
function ServeConfirm({ request, opts }: { request: StartServerRequest; opts: FlowOpts }) {
  const { t, integer } = useI18n();
  const plan = opts.plan as ServerPlan | undefined;
  // Set in expert mode, or the exact settings of a past run ("Avvia solo il server così").
  const params: Partial<LaunchParams> = request.params ?? {};
  const own = (params.contextSize ?? params.maxModelLen) !== undefined;
  return (
    <div className="flex flex-col gap-4">
      {plan ? (
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          {plan.contextSize !== undefined && (
            <div className="flex flex-col gap-1 sm:col-span-2">
              <dt className="inline-flex items-center gap-1 text-xs text-fg-3">
                {t('servers.flow.context')}
                <HelpTip term={t('servers.flow.context')}>{t('servers.flow.contextHelp')}</HelpTip>
              </dt>
              <dd className="text-md font-semibold text-fg tabular-nums">{t('servers.flow.contextValue', { n: integer(plan.contextSize) })}</dd>
              <dd className="text-fg-2">{!own && plan.tuned ? <TunedContext tuned={plan.tuned} /> : t(own ? 'servers.flow.contextOwn' : 'servers.flow.contextAuto')}</dd>
            </div>
          )}
          {plan.fit && (
            <div className="flex flex-col gap-1 sm:col-span-2">
              <dt className="text-xs text-fg-3">{t('benchmark.plan.fit')}</dt>
              <dd>
                <FitSummary fit={plan.fit} />
              </dd>
            </div>
          )}
        </dl>
      ) : (
        // No preview (offline, model gone…): the start may still work, or says why again.
        <ErrorCard error={opts.planError as AppErrorData} headingLevel={3} />
      )}
      {opts.needs.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-fg-3">{t('servers.flow.needs')}</p>
          <NeedList needs={opts.needs} mode="serve" />
        </div>
      )}
      {plan && plan.warnings.length > 0 && <PlanWarnings warnings={plan.warnings} />}
      <p className="text-xs text-fg-3">{t('servers.confirmHint')}</p>
      {plan && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-fg-3">{t('servers.flow.command')}</p>
          <CodeBlock commands={plan.command} label={t('servers.flow.command')} />
        </div>
      )}
    </div>
  );
}

export interface StartDialogsProps {
  flow: Flow;
  onClose: () => void;
  /** Go: fetch what is missing first (or straight on when nothing is). */
  onConfirm: (job: Job, opts: FlowOpts) => Promise<void>;
  /** POST the start again (after "Continua comunque", or a retry). */
  onContinue: (job: Job, opts: FlowOpts, pre: Pre) => Promise<void>;
  onStopServers: (job: Job, opts: FlowOpts, servers: ServerInfo[]) => Promise<void>;
}

export function StartDialogs({ flow, onClose, onConfirm, onContinue, onStopServers }: StartDialogsProps) {
  const { t, bytes } = useI18n();
  const stop = useStopServer();
  const open = flow.step !== 'idle';
  let content: ReactNode = null;
  if (flow.step === 'confirm' && flow.job.mode === 'serve') {
    content = (
      <DialogContent
        size="lg"
        title={t('servers.flow.title')}
        description={t('servers.flow.description', { model: flow.opts.modelLabel, engine: flow.opts.engineLabel })}
        footer={
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => void onConfirm(flow.job, flow.opts)}>
              <Server aria-hidden />
              {t('servers.flow.start')}
            </Button>
          </>
        }
      >
        <ServeConfirm request={flow.job.request} opts={flow.opts} />
      </DialogContent>
    );
  } else if (flow.step === 'confirm') {
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
    content = (
      <DialogContent title={t(title)}>
        <p className="flex items-center gap-2 text-sm text-fg-2" aria-live="polite">
          <Loader aria-hidden className="size-4 animate-spin text-accent" />
          {t(body)}
        </p>
        {flow.job.mode === 'serve' && !flow.planning && <ServerLoading />}
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
              {fixFor(flow.error.code) !== 'retry' && (
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
  } else if (flow.step === 'ready') {
    const server = flow.server;
    content = (
      <DialogContent
        title={t('servers.flow.readyTitle')}
        description={t('servers.readyBody')}
        footer={
          <>
            <Button variant="danger-outline" onClick={() => void stop(server).then(onClose)}>
              <Square aria-hidden />
              {t('servers.stop')}
            </Button>
            <Button variant="primary" onClick={onClose}>
              {t('servers.keepRunning')}
            </Button>
          </>
        }
      >
        <ServerReady info={server} />
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
