/**
 * "Avvia benchmark", start to finish: one clear confirmation for what must be downloaded or
 * installed (with sizes), the downloads themselves with progress, the "GPU busy" question, then
 * POST /api/runs and the live screen. Used by the Benchmark page and by "Rifai questo benchmark".
 */
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Box, Check, Download, Loader, TriangleAlert } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { RunPlan, ServerInfo, StartRunRequest } from '../../../contract/api';
import type { AppErrorData } from '../../../contract/errors';
import type { ServerEvent } from '../../../contract/events';
import type { DownloadJob, LocalModel } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { useApi, useServerEvents } from '../../lib/api-context';
import { apiErrorData, ENGINES_KEY, LOCAL_MODELS_KEY, SERVERS_KEY } from '../../lib/queries-runs';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Progress } from '../ui/progress';
import { ErrorCard } from './error-card';
import { saveRunContext } from './run-context';

/**
 * Something to fetch before the run can start. A model with `file` is one GGUF (the request then
 * points at the downloaded copy); without it the whole repo is fetched for vLLM (the core finds
 * the local copy by itself).
 */
export type Need =
  | { kind: 'engine'; label: string; bytes?: number }
  | { kind: 'model'; label: string; bytes?: number; repo: string; revision: string; file?: string };

export interface StartOptions {
  needs: Need[];
  plan?: RunPlan;
  modelLabel: string;
  engineLabel: string;
  /** Called once the run really started (e.g. remember the choices in settings). */
  onStarted?: (runId: string) => void;
}

interface StepProgress {
  need: Need;
  state: 'pending' | 'running' | 'done' | 'failed';
  stage?: string;
  done?: number;
  total?: number;
}

type Flow =
  | { step: 'idle' }
  | { step: 'confirm'; request: StartRunRequest; opts: StartOptions }
  | { step: 'fetching'; request: StartRunRequest; opts: StartOptions; progress: StepProgress[]; error?: AppErrorData }
  | { step: 'busy'; request: StartRunRequest; opts: StartOptions; names: string; ownServers: ServerInfo[] }
  | { step: 'starting'; request: StartRunRequest; opts: StartOptions }
  | { step: 'error'; request: StartRunRequest; opts: StartOptions; error: AppErrorData };

type Waiter = (e: ServerEvent) => void;

const INSTALL_DONE = new Set(['done', 'error']);

/** "llama-server.exe (PID 4242), ollama.exe (PID 77)" from the comma-separated names/pids of VRAM_BUSY. */
export function processList(params: Record<string, unknown> | undefined): string {
  const split = (v: unknown) =>
    String(v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const pids = split(params?.pids);
  return split(params?.names)
    .map((n, i) => (pids[i] ? `${n} (PID ${pids[i]})` : n))
    .join(', ');
}
const DOWNLOAD_DONE = new Set<DownloadJob['state']>(['done', 'failed', 'cancelled']);

export function useStartFlow(): { start: (request: StartRunRequest, opts: StartOptions) => void; ui: ReactNode } {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [flow, setFlow] = useState<Flow>({ step: 'idle' });
  const waiters = useRef(new Set<Waiter>());
  const generation = useRef(0);
  const downloadId = useRef<string | undefined>(undefined);

  useServerEvents((e) => {
    for (const w of [...waiters.current]) w(e);
  });

  /** Resolves with the first event `pick` accepts (it also sees every event before that). */
  const waitFor = useCallback(<T,>(pick: (e: ServerEvent) => T | undefined): { promise: Promise<T>; cancel: () => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    const w: Waiter = (e) => {
      const r = pick(e);
      if (r !== undefined) {
        waiters.current.delete(w);
        resolve(r);
      }
    };
    waiters.current.add(w);
    return { promise, cancel: () => waiters.current.delete(w) };
  }, []);

  const post = useCallback(
    async (request: StartRunRequest, opts: StartOptions, pre: { install: boolean; download: boolean }) => {
      setFlow({ step: 'starting', request, opts });
      try {
        const { runId } = await api.post<{ runId: string }>('/api/runs', request);
        saveRunContext(qc, runId, {
          request,
          ...(opts.plan ? { plan: opts.plan } : {}),
          modelLabel: opts.modelLabel,
          engineLabel: opts.engineLabel,
          pre,
          startedAt: Date.now(),
        });
        opts.onStarted?.(runId);
        setFlow({ step: 'idle' });
        void qc.invalidateQueries({ queryKey: ['runs', 'active'] });
        void navigate({ to: '/run/$runId', params: { runId } });
      } catch (e) {
        const error = apiErrorData(e);
        if (error.code === 'VRAM_BUSY') {
          const own = error.params?.reason === 'own_server' ? await api.get<ServerInfo[]>('/api/servers').catch(() => []) : [];
          setFlow({ step: 'busy', request, opts, names: processList(error.params), ownServers: own });
        } else setFlow({ step: 'error', request, opts, error });
      }
    },
    [api, qc, navigate],
  );

  /** VRAM check from the plan, then start. */
  const proceed = useCallback(
    (request: StartRunRequest, opts: StartOptions, pre: { install: boolean; download: boolean }) => {
      const busy = opts.plan?.warnings.find((w) => w.code === 'VRAM_BUSY');
      if (busy && !request.allowSharedGpu) {
        setFlow({ step: 'busy', request, opts, names: processList(busy.params), ownServers: [] });
        return;
      }
      void post(request, opts, pre);
    },
    [post],
  );

  const fetchNeeds = useCallback(
    async (request: StartRunRequest, opts: StartOptions) => {
      // Closing the dialog bumps the generation: late answers of this attempt are then ignored.
      const gen = ++generation.current;
      const alive = () => generation.current === gen;
      const progress: StepProgress[] = opts.needs.map((need) => ({ need, state: 'pending' }));
      const update = (i: number, patch: Partial<StepProgress>) => {
        progress[i] = { ...progress[i]!, ...patch };
        if (alive()) setFlow({ step: 'fetching', request, opts, progress: [...progress] });
      };
      setFlow({ step: 'fetching', request, opts, progress: [...progress] });
      let req = request;
      try {
        for (const [i, need] of opts.needs.entries()) {
          update(i, { state: 'running' });
          if (need.kind === 'engine') {
            const wait = waitFor((e) => {
              if (e.type !== 'engine.install' || e.kind !== 'llamacpp-native') return undefined;
              update(i, { stage: e.stage, done: e.bytesDone, ...(e.bytesTotal ? { total: e.bytesTotal } : {}) });
              return INSTALL_DONE.has(e.stage) ? e : undefined;
            });
            try {
              await api.post('/api/engines/llamacpp-native/install', {});
            } catch (e) {
              wait.cancel();
              throw e;
            }
            const end = await wait.promise;
            if (end.error) throw Object.assign(new Error(end.error.message), { data: end.error });
            void qc.invalidateQueries({ queryKey: ENGINES_KEY });
            void qc.invalidateQueries({ queryKey: ['lib', 'engines'] });
            void qc.invalidateQueries({ queryKey: ['bench', 'plan'] });
          } else {
            const known: { id?: string } = {};
            const early: DownloadJob[] = [];
            const wait = waitFor((e) => {
              if (e.type !== 'download.update') return undefined;
              if (known.id === undefined) {
                early.push(e.job);
                return undefined;
              }
              if (e.job.id !== known.id) return undefined;
              update(i, { stage: e.job.state, done: e.job.bytesDone, ...(e.job.bytesTotal ? { total: e.job.bytesTotal } : {}) });
              return DOWNLOAD_DONE.has(e.job.state) ? e.job : undefined;
            });
            let job: DownloadJob;
            try {
              job = await api.post<DownloadJob>('/api/downloads', { repo: need.repo, revision: need.revision, files: [need.file ?? '*'], label: need.label });
            } catch (e) {
              wait.cancel();
              throw e;
            }
            known.id = job.id;
            downloadId.current = job.id;
            // The job may have finished (or progressed) before its id was known.
            const seen = [job, ...early.filter((j) => j.id === job.id)].pop()!;
            update(i, { stage: seen.state, done: seen.bytesDone, ...(seen.bytesTotal ? { total: seen.bytesTotal } : {}) });
            let end: DownloadJob;
            if (DOWNLOAD_DONE.has(seen.state)) {
              wait.cancel();
              end = seen;
            } else end = await wait.promise;
            downloadId.current = undefined;
            if (end.state !== 'done') {
              const code = end.error?.code ?? 'DOWNLOAD_FAILED';
              throw Object.assign(new Error(end.error?.message ?? 'download failed'), { data: { code, message: end.error?.message ?? 'download failed' } });
            }
            const models = await api.post<LocalModel[]>('/api/models/rescan');
            void qc.invalidateQueries({ queryKey: LOCAL_MODELS_KEY });
            void qc.invalidateQueries({ queryKey: ['lib', 'models', 'local'] });
            const file = need.file;
            if (file !== undefined) {
              const local = models.find((m) => m.identity.file === file || m.paths.some((p) => p.replaceAll('\\', '/').endsWith(`/${file}`)));
              if (!local) throw Object.assign(new Error('downloaded model not found'), { data: { code: 'MODEL_NOT_FOUND', message: `${file} not found after download` } });
              req = { ...req, model: { localId: local.id } };
            }
          }
          update(i, { state: 'done' });
        }
      } catch (e) {
        if (!alive()) return;
        const data = (e as { data?: AppErrorData }).data ?? apiErrorData(e);
        setFlow({ step: 'fetching', request, opts, progress: progress.map((p) => (p.state === 'running' ? { ...p, state: 'failed' as const } : p)), error: data });
        return;
      }
      // Fresh plan now that everything is in place: warnings (GPU busy) and the scenario for the live screen.
      const plan = await api.post<RunPlan>('/api/runs/plan', req).catch(() => opts.plan);
      if (!alive()) return;
      const pre = { install: opts.needs.some((n) => n.kind === 'engine'), download: opts.needs.some((n) => n.kind === 'model') };
      proceed(req, { ...opts, ...(plan ? { plan } : {}) }, pre);
    },
    [api, qc, waitFor, proceed],
  );

  const start = useCallback(
    (request: StartRunRequest, opts: StartOptions) => {
      if (opts.needs.length) {
        setFlow({ step: 'confirm', request, opts });
        return;
      }
      if (opts.plan) {
        proceed(request, opts, { install: false, download: false });
        return;
      }
      // Started before the preview of these exact choices arrived: get it now (GPU check, phases, duration).
      const gen = ++generation.current;
      setFlow({ step: 'starting', request, opts });
      void api
        .post<RunPlan>('/api/runs/plan', request)
        .catch(() => undefined)
        .then((plan) => {
          if (generation.current === gen) proceed(request, { ...opts, ...(plan ? { plan } : {}) }, { install: false, download: false });
        });
    },
    [api, proceed],
  );

  const close = () => {
    generation.current++;
    waiters.current.clear();
    if (downloadId.current) void api.post(`/api/downloads/${downloadId.current}/cancel`).catch(() => undefined);
    downloadId.current = undefined;
    setFlow({ step: 'idle' });
  };

  const stopServersAndStart = async (request: StartRunRequest, opts: StartOptions, servers: ServerInfo[]) => {
    setFlow({ step: 'starting', request, opts });
    await Promise.all(servers.map((s) => api.del(`/api/servers/${encodeURIComponent(s.id)}`).catch(() => undefined)));
    void qc.invalidateQueries({ queryKey: SERVERS_KEY });
    await post(request, opts, { install: false, download: false });
  };

  return { start, ui: <StartDialogs flow={flow} onClose={close} onConfirm={fetchNeeds} onContinue={post} onStopServers={stopServersAndStart} /> };
}

function NeedRow({ p }: { p: StepProgress }) {
  const { t, bytes, integer } = useI18n();
  const Icon = p.need.kind === 'engine' ? Box : Download;
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

function StartDialogs({
  flow,
  onClose,
  onConfirm,
  onContinue,
  onStopServers,
}: {
  flow: Flow;
  onClose: () => void;
  onConfirm: (request: StartRunRequest, opts: StartOptions) => Promise<void>;
  onContinue: (request: StartRunRequest, opts: StartOptions, pre: { install: boolean; download: boolean }) => Promise<void>;
  onStopServers: (request: StartRunRequest, opts: StartOptions, servers: ServerInfo[]) => Promise<void>;
}) {
  const { t, bytes } = useI18n();
  const open = flow.step !== 'idle';
  let content: ReactNode = null;
  if (flow.step === 'confirm') {
    const total = flow.opts.needs.reduce((a, n) => a + (n.bytes ?? 0), 0);
    content = (
      <DialogContent
        title={t('benchmark.needs.title')}
        description={total ? t('benchmark.needs.descriptionSize', { size: bytes(total) }) : t('benchmark.needs.description')}
        footer={
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => void onConfirm(flow.request, flow.opts)}>
              <Download aria-hidden />
              {t('benchmark.needs.confirm')}
            </Button>
          </>
        }
      >
        <ul className="flex flex-col gap-2">
          {flow.opts.needs.map((n) => (
            <li key={n.label} className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
              {n.kind === 'engine' ? <Box aria-hidden className="size-4 text-accent-text" /> : <Download aria-hidden className="size-4 text-accent-text" />}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium text-fg">{t(n.kind === 'engine' ? 'benchmark.needs.installEngine' : 'benchmark.needs.downloadModel', { name: n.label })}</span>
                <span className="text-xs text-fg-3">{t(n.kind === 'engine' ? 'benchmark.needs.engineWhy' : 'benchmark.needs.modelWhy')}</span>
              </span>
              <span className="font-medium text-fg tabular-nums">{n.bytes === undefined ? t('benchmark.needs.sizeUnknown') : bytes(n.bytes)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-fg-3">{t('benchmark.needs.once')}</p>
      </DialogContent>
    );
  } else if (flow.step === 'fetching') {
    const done = flow.progress.every((p) => p.state === 'done');
    content = (
      <DialogContent
        title={flow.error ? t('benchmark.needs.failedTitle') : t('benchmark.needs.progressTitle')}
        description={flow.error ? undefined : t('benchmark.needs.progressBody')}
        footer={
          flow.error ? (
            <>
              <Button onClick={onClose}>{t('common.close')}</Button>
              <Button variant="primary" onClick={() => void onConfirm(flow.request, flow.opts)}>
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
        description={t(own ? 'benchmark.busy.ownBody' : 'benchmark.busy.body')}
        footer={
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            {own ? (
              <Button variant="primary" onClick={() => void onStopServers(flow.request, flow.opts, flow.ownServers)}>
                {t('benchmark.busy.stopServers')}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void onContinue({ ...flow.request, allowSharedGpu: true }, flow.opts, { install: false, download: false })}>
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
    content = (
      <DialogContent title={t('benchmark.starting')}>
        <p className="flex items-center gap-2 text-sm text-fg-2" aria-live="polite">
          <Loader aria-hidden className="size-4 animate-spin text-accent" />
          {t('benchmark.startingBody')}
        </p>
      </DialogContent>
    );
  } else if (flow.step === 'error') {
    content = (
      <DialogContent title={t('benchmark.startFailed')} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
        <ErrorCard
          error={flow.error}
          headingLevel={3}
          handlers={{ retry: () => void onContinue(flow.request, flow.opts, { install: false, download: false }) }}
          extra={
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t('benchmark.changeChoices')}
            </Button>
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
