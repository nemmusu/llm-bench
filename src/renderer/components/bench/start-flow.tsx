/**
 * "Avvia benchmark" and "Avvia solo il server", start to finish: the exact plan of these choices (it
 * lists what must be installed or downloaded, with sizes), one clear confirmation, the installs and
 * downloads with progress, the "GPU busy" question, then POST /api/runs with the same request (the
 * core finds what was just downloaded) and the live screen — or POST /api/servers and the server's
 * address. Used by the Benchmark page, the result page ("Rifai questo benchmark", "Avvia solo il
 * server così") and the Models page ("Avvia server").
 */
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { RunPlan, ServerInfo, ServerPlan, StartRunRequest, StartServerRequest } from '../../../contract/api';
import type { AppErrorData } from '../../../contract/errors';
import type { ServerEvent } from '../../../contract/events';
import type { DownloadJob } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { useApi, useServerEvents } from '../../lib/api-context';
import { apiErrorData, ENGINES_KEY, LOCAL_MODELS_KEY, SERVERS_KEY } from '../../lib/queries-runs';
import { needsFromPlan, type Need } from './needs';
import { saveRunContext } from './run-context';
import { StartDialogs, type Flow, type FlowOpts, type Job, type Pre, type StepProgress } from './start-dialogs';

export interface StartOptions {
  /** What to fetch first when no plan can be made (the plan's own list wins). */
  needs: Need[];
  /** The preview of exactly this request, when the caller has it (else it is asked for first). */
  plan?: RunPlan;
  /** Also the name of the model download in the confirmation and in the downloads panel. */
  modelLabel: string;
  engineLabel: string;
  /** Called once the run really started (e.g. remember the choices in settings). */
  onStarted?: (runId: string) => void;
}

export interface ServeOptions {
  /** The preview of exactly this request: the Server page shows it before "Avvia" (it is the confirmation). */
  plan: ServerPlan;
  modelLabel: string;
  engineLabel: string;
  /** Called once the server answers (also after "Continua in background"). */
  onStarted?: (info: ServerInfo) => void;
  /** "Continua in background": the dialog closes, the server keeps loading (its card shows how far it is). */
  onBackground?: () => void;
}

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

/** "Il test non è partito" / "Il server non è partito", for a start that failed after its dialog went away. */
const TEXT_STARTFAILED = { run: 'benchmark.startFailed', serve: 'servers.flow.startFailed' } as const;

/** Whether the user already accepted a GPU other programs are using. */
const sharedOk = (job: Job): boolean => (job.mode === 'run' ? job.request.allowSharedGpu : job.sharedOk === true);

export function useStartFlow(): {
  start: (request: StartRunRequest, opts: StartOptions) => void;
  serve: (request: StartServerRequest, opts: ServeOptions) => void;
  ui: ReactNode;
} {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [flow, setFlow] = useState<Flow>({ step: 'idle' });
  const background = useRef<(() => void) | undefined>(undefined);
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

  /** The preview of exactly this job: POST /api/runs/plan or /api/servers/plan. */
  const planOf = useCallback(
    (job: Job) => api.post<RunPlan | ServerPlan>(job.mode === 'run' ? '/api/runs/plan' : '/api/servers/plan', job.request),
    [api],
  );

  const post = useCallback(
    async (job: Job, opts: FlowOpts, pre: Pre) => {
      const gen = generation.current;
      setFlow({ step: 'starting', job, opts });
      try {
        if (job.mode === 'run') {
          const { runId } = await api.post<{ runId: string }>('/api/runs', job.request);
          saveRunContext(qc, runId, {
            request: job.request,
            ...(opts.plan ? { plan: opts.plan as RunPlan } : {}),
            modelLabel: opts.modelLabel,
            engineLabel: opts.engineLabel,
            pre,
            startedAt: Date.now(),
          });
          job.onStarted?.(runId);
          setFlow({ step: 'idle' });
          void qc.invalidateQueries({ queryKey: ['runs', 'active'] });
          void navigate({ to: '/run/$runId', params: { runId } });
        } else {
          const server = await api.post<ServerInfo>('/api/servers', job.request);
          void qc.invalidateQueries({ queryKey: SERVERS_KEY });
          // Also after "Continua in background": the server card already shows it, now ready.
          job.onStarted?.(server);
          if (generation.current === gen) setFlow({ step: 'idle' });
        }
      } catch (e) {
        const error = apiErrorData(e);
        // Sent to the background meanwhile: nobody is looking at the dialog any more.
        if (generation.current !== gen) {
          toast.error(t(TEXT_STARTFAILED[job.mode]), { description: t(`errors.${error.code}.title`) });
          void qc.invalidateQueries({ queryKey: SERVERS_KEY });
          return;
        }
        if (error.code === 'VRAM_BUSY') {
          const own = error.params?.reason === 'own_server' ? await api.get<ServerInfo[]>('/api/servers').catch(() => []) : [];
          setFlow({ step: 'busy', job, opts, names: processList(error.params), ownServers: own });
        } else setFlow({ step: 'error', job, opts, error });
      }
    },
    [api, qc, navigate],
  );

  /** VRAM check from the plan, then start. */
  const proceed = useCallback(
    (job: Job, opts: FlowOpts, pre: Pre) => {
      const busy = opts.plan?.warnings.find((w) => w.code === 'VRAM_BUSY');
      if (busy && !sharedOk(job)) {
        setFlow({ step: 'busy', job, opts, names: processList(busy.params), ownServers: [] });
        return;
      }
      void post(job, opts, pre);
    },
    [post],
  );

  /** POST /api/engines/:kind/install and its 'engine.install' events until 'done' (or 'error', thrown). */
  const install = useCallback(
    async (kind: string, body: Record<string, unknown>, onEvent: (e: Extract<ServerEvent, { type: 'engine.install' }>) => void) => {
      const wait = waitFor((e) => {
        if (e.type !== 'engine.install' || e.kind !== kind) return undefined;
        onEvent(e);
        return INSTALL_DONE.has(e.stage) ? e : undefined;
      });
      try {
        await api.post(`/api/engines/${kind}/install`, body);
      } catch (e) {
        wait.cancel();
        throw e;
      }
      const end = await wait.promise;
      if (end.error) throw Object.assign(new Error(end.error.message), { data: end.error });
      void qc.invalidateQueries({ queryKey: ENGINES_KEY });
      void qc.invalidateQueries({ queryKey: ['lib', 'engines'] });
    },
    [api, qc, waitFor],
  );

  /** POST /api/downloads and its 'download.update' events until the job ends; then the library knows the files. */
  const download = useCallback(
    async (need: Extract<Need, { kind: 'model' }>, onJob: (j: DownloadJob) => void) => {
      const known: { id?: string } = {};
      const early: DownloadJob[] = [];
      const wait = waitFor((e) => {
        if (e.type !== 'download.update') return undefined;
        if (known.id === undefined) {
          early.push(e.job);
          return undefined;
        }
        if (e.job.id !== known.id) return undefined;
        onJob(e.job);
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
      onJob(seen);
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
      // The request names the model by repo and file: the core finds this copy once its library is rescanned.
      await api.post('/api/models/rescan');
      void qc.invalidateQueries({ queryKey: LOCAL_MODELS_KEY });
      void qc.invalidateQueries({ queryKey: ['lib', 'models', 'local'] });
    },
    [api, qc, waitFor],
  );

  const fetchNeeds = useCallback(
    async (job: Job, opts: FlowOpts) => {
      // Closing the dialog bumps the generation: late answers of this attempt are then ignored.
      const gen = ++generation.current;
      const alive = () => generation.current === gen;
      const progress: StepProgress[] = opts.needs.map((need) => ({ need, state: 'pending' }));
      const update = (i: number, patch: Partial<StepProgress>) => {
        progress[i] = { ...progress[i]!, ...patch };
        if (alive()) setFlow({ step: 'fetching', job, opts, progress: [...progress] });
      };
      const bytes = (i: number, stage: string, done: number, total: number | undefined) => update(i, { stage, done, ...(total ? { total } : {}) });
      setFlow({ step: 'fetching', job, opts, progress: [...progress] });
      try {
        for (const [i, need] of opts.needs.entries()) {
          update(i, { state: 'running' });
          if (need.kind === 'engine') await install('llamacpp-native', {}, (e) => bytes(i, e.stage, e.bytesDone, e.bytesTotal));
          else if (need.kind === 'image') await install(need.engine, { image: need.label }, (e) => bytes(i, e.stage, e.bytesDone, e.bytesTotal));
          else await download(need, (j) => bytes(i, j.state, j.bytesDone, j.bytesTotal));
          update(i, { state: 'done' });
        }
      } catch (e) {
        if (!alive()) return;
        const data = (e as { data?: AppErrorData }).data ?? apiErrorData(e);
        setFlow({ step: 'fetching', job, opts, progress: progress.map((p) => (p.state === 'running' ? { ...p, state: 'failed' as const } : p)), error: data });
        return;
      }
      void qc.invalidateQueries({ queryKey: ['bench', 'plan'] });
      // Fresh plan now that everything is in place: warnings (GPU busy) and the scenario for the live screen.
      const plan = await planOf(job).catch(() => opts.plan);
      if (!alive()) return;
      const pre = { install: opts.needs.some((n) => n.kind !== 'model'), download: opts.needs.some((n) => n.kind === 'model') };
      proceed(job, { ...opts, ...(plan ? { plan } : {}) }, pre);
    },
    [qc, install, download, planOf, proceed],
  );

  /** "Scarica e avvia" / "Avvia server": fetch what is missing first, or go straight on. */
  const confirm = useCallback(
    async (job: Job, opts: FlowOpts) => {
      if (opts.needs.length) await fetchNeeds(job, opts);
      else proceed(job, opts, { install: false, download: false });
    },
    [fetchNeeds, proceed],
  );

  /**
   * With the plan of this job (if one could be made): a run asks only when something must be
   * fetched first; a server was already confirmed on its page ("Avvia" / "Scarica e avvia").
   */
  const decide = useCallback(
    (job: Job, opts: FlowOpts) => {
      const needs = opts.plan ? needsFromPlan(job.request, opts.plan, opts.modelLabel) : opts.needs;
      const next: FlowOpts = { ...opts, needs };
      if (job.mode === 'serve' && needs.length) void fetchNeeds(job, next);
      else if (needs.length) setFlow({ step: 'confirm', job, opts: next });
      else proceed(job, next, { install: false, download: false });
    },
    [proceed, fetchNeeds],
  );

  /** Started before the preview of these exact choices arrived: get it now (downloads, GPU check, phases, duration). */
  const begin = useCallback(
    (job: Job, opts: FlowOpts) => {
      const gen = ++generation.current;
      setFlow({ step: 'starting', job, opts, planning: true });
      void planOf(job)
        .then(
          (plan): Partial<FlowOpts> => ({ plan }),
          (e: unknown): Partial<FlowOpts> => ({ planError: apiErrorData(e) }),
        )
        .then((got) => {
          if (generation.current === gen) decide(job, { ...opts, ...got });
        });
    },
    [planOf, decide],
  );

  const start = useCallback(
    (request: StartRunRequest, opts: StartOptions) => {
      const job: Job = { mode: 'run', request, onStarted: opts.onStarted };
      const base: FlowOpts = { needs: opts.needs, modelLabel: opts.modelLabel, engineLabel: opts.engineLabel };
      if (opts.plan) decide(job, { ...base, plan: opts.plan });
      else begin(job, base);
    },
    [decide, begin],
  );

  const serve = useCallback(
    (request: StartServerRequest, opts: ServeOptions) => {
      background.current = opts.onBackground;
      decide({ mode: 'serve', request, onStarted: opts.onStarted }, { needs: [], plan: opts.plan, modelLabel: opts.modelLabel, engineLabel: opts.engineLabel });
    },
    [decide],
  );

  const close = () => {
    generation.current++;
    waiters.current.clear();
    if (downloadId.current) void api.post(`/api/downloads/${downloadId.current}/cancel`).catch(() => undefined);
    downloadId.current = undefined;
    setFlow({ step: 'idle' });
  };

  const stopServersAndStart = async (job: Job, opts: FlowOpts, servers: ServerInfo[]) => {
    setFlow({ step: 'starting', job, opts });
    await Promise.all(servers.map((s) => api.del(`/api/servers/${encodeURIComponent(s.id)}`).catch(() => undefined)));
    void qc.invalidateQueries({ queryKey: SERVERS_KEY });
    await post(job, opts, { install: false, download: false });
  };

  /** "Continua in background": the dialog goes, the start does not (nothing is cancelled). */
  const toBackground = () => {
    generation.current++;
    setFlow({ step: 'idle' });
    background.current?.();
  };

  return {
    start,
    serve,
    ui: <StartDialogs flow={flow} onClose={close} onConfirm={confirm} onContinue={post} onStopServers={stopServersAndStart} onBackground={toBackground} />,
  };
}
