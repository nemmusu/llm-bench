import { AppError, toAppErrorData, type AppErrorData } from '../../contract/errors';
import type { ServerEvent } from '../../contract/events';
import type { Logger, Platform } from '../deps';
import type { DockerInstallPlan, DockerInstallProgress, DockerInstallResult } from './docker-installer';
import type { DriverCheckResult } from './driver';
import type { SystemCheckReport } from './system-check';
import type { UvInstalled, UvProgress } from './uv';

export const SETUP_JOB_KINDS = ['docker-desktop', 'docker-linux', 'uv'] as const;
export type SetupJobKind = (typeof SETUP_JOB_KINDS)[number];

/** One guided install. Also published as `engine.install` events (kind = job kind). */
export interface SetupJob {
  kind: SetupJobKind;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  /**
   * download / verify / installer / extract / <linux script step> while running; at the end the
   * outcome (installed, reboot-maybe-required, relogin-required) or failed / cancelled.
   */
  stage: string;
  /** Bytes; for docker-linux the script step number (bytesTotal = number of steps). */
  bytesDone: number;
  bytesTotal?: number;
  startedAt: string;
  finishedAt?: string;
  result?: DockerInstallResult | UvInstalled;
  error?: AppErrorData;
}

export interface SetupService {
  check(opts?: { fresh?: boolean }): Promise<SystemCheckReport>;
  driver(): Promise<DriverCheckResult>;
  dockerPlan(): Promise<DockerInstallPlan>;
  linuxScript(): { script: string; steps: readonly string[] };
  /** Starts (or joins) the Docker install for this OS; progress arrives as events. */
  startDockerInstall(): { started: boolean; job: SetupJob };
  startUvInstall(): { started: boolean; job: SetupJob };
  jobs(): SetupJob[];
  /** Aborts a running job (downloads only: installers already handed to the user/OS keep going). */
  cancel(kind: SetupJobKind): SetupJob | undefined;
  /** For the vLLM-native installer. */
  uvPath(): Promise<string | undefined>;
}

export interface SetupServiceOptions {
  platform: Platform;
  systemCheck: { check(opts?: { fresh?: boolean }): Promise<SystemCheckReport>; driver(): Promise<DriverCheckResult> };
  docker: {
    plan(signal?: AbortSignal): Promise<DockerInstallPlan>;
    install(progress: (p: DockerInstallProgress) => void, signal: AbortSignal): Promise<DockerInstallResult>;
    linuxScript(): { script: string; steps: readonly string[] };
  };
  uv: {
    install(progress: (p: UvProgress) => void, signal: AbortSignal): Promise<UvInstalled>;
    uvPath(): Promise<string | undefined>;
  };
  publish: (e: ServerEvent) => void;
  /** Core shutdown aborts running downloads. */
  shutdown?: AbortSignal;
  wall?: () => number;
  log?: Logger;
  /** Called after a successful install, e.g. to drop the docker status cache. */
  onInstalled?: (kind: SetupJobKind) => void;
}

interface Running {
  job: SetupJob;
  controller: AbortController;
}

export function createSetupService(o: SetupServiceOptions): SetupService {
  const jobs = new Map<SetupJobKind, Running>();
  const now = () => new Date((o.wall ?? Date.now)()).toISOString();

  /** The final event of a job carries its outcome: `result` when done, `error` when failed or cancelled. */
  const emit = (job: SetupJob) =>
    o.publish({
      type: 'engine.install',
      kind: job.kind,
      bytesDone: job.bytesDone,
      ...(job.bytesTotal !== undefined ? { bytesTotal: job.bytesTotal } : {}),
      stage: job.stage,
      ...(job.error ? { error: job.error } : {}),
      ...(job.result ? { result: { ...job.result } } : {}),
    });

  function start<R extends DockerInstallResult | UvInstalled>(
    kind: SetupJobKind,
    run: (progress: (p: { stage: string; bytesDone: number; bytesTotal?: number }) => void, signal: AbortSignal) => Promise<R>,
    outcome: (r: R) => string,
  ): { started: boolean; job: SetupJob } {
    const cur = jobs.get(kind);
    if (cur?.job.state === 'running') return { started: false, job: { ...cur.job } };
    const controller = new AbortController();
    const onShutdown = () => controller.abort();
    o.shutdown?.addEventListener('abort', onShutdown, { once: true });
    const job: SetupJob = { kind, state: 'running', stage: 'starting', bytesDone: 0, startedAt: now() };
    jobs.set(kind, { job, controller });
    emit(job);
    const progress = (p: { stage: string; bytesDone: number; bytesTotal?: number }) => {
      job.stage = p.stage;
      job.bytesDone = p.bytesDone;
      if (p.bytesTotal !== undefined) job.bytesTotal = p.bytesTotal;
      emit(job);
    };
    void run(progress, controller.signal)
      .then((r) => {
        job.state = 'done';
        job.stage = outcome(r);
        job.result = r;
        o.onInstalled?.(kind);
      })
      .catch((e: unknown) => {
        const err = controller.signal.aborted && !(e instanceof AppError) ? toAppErrorData(new AppError('CANCELLED', 'Cancelled')) : toAppErrorData(e);
        job.state = err.code === 'CANCELLED' ? 'cancelled' : 'failed';
        job.stage = job.state;
        job.error = err;
        o.log?.warn('setup job failed', { kind, code: err.code, message: err.message });
      })
      .finally(() => {
        job.finishedAt = now();
        o.shutdown?.removeEventListener('abort', onShutdown);
        emit(job);
      });
    return { started: true, job: { ...job } };
  }

  return {
    check: (opts) => o.systemCheck.check(opts),
    driver: () => o.systemCheck.driver(),
    dockerPlan: () => o.docker.plan(),
    linuxScript: () => o.docker.linuxScript(),
    startDockerInstall() {
      if (o.platform !== 'win32' && o.platform !== 'linux') {
        throw new AppError('DOCKER_UNSUPPORTED', 'Guided Docker install is only available on Windows and Linux', { params: { platform: o.platform } });
      }
      return start(
        o.platform === 'win32' ? 'docker-desktop' : 'docker-linux',
        (p, s) => o.docker.install(p, s),
        (r) => r.outcome,
      );
    },
    startUvInstall() {
      return start('uv', (p, s) => o.uv.install(p, s), () => 'installed');
    },
    jobs: () => [...jobs.values()].map((r) => ({ ...r.job })),
    cancel(kind) {
      const cur = jobs.get(kind);
      if (!cur) return undefined;
      if (cur.job.state === 'running') cur.controller.abort();
      return { ...cur.job };
    },
    uvPath: () => o.uv.uvPath(),
  };
}
