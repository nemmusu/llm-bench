import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import type { ServerEvent } from '../../../../src/contract/events';
import type { CoreContext } from '../../../../src/core/context';
import type { DockerInstallProgress, DockerInstallResult } from '../../../../src/core/setup/docker-installer';
import { createSetupRoutes } from '../../../../src/core/setup/routes';
import { createSetupService, type SetupJob, type SetupServiceOptions } from '../../../../src/core/setup/service';
import type { SystemCheckReport } from '../../../../src/core/setup/system-check';
import type { UvInstalled, UvProgress } from '../../../../src/core/setup/uv';
import { errorResponse } from '../../../../src/core/server/http-error';
import { memoryLogger, tick } from '../telemetry/fakes';

const REPORT: SystemCheckReport = { platform: 'win32', items: [], canBenchmark: true, checkedAt: '2026-10-06T08:00:00.000Z' };

/** A promise the test resolves or rejects by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(over: Partial<SetupServiceOptions> = {}) {
  const events: ServerEvent[] = [];
  const docker = {
    progress: undefined as ((p: DockerInstallProgress) => void) | undefined,
    signal: undefined as AbortSignal | undefined,
    run: deferred<DockerInstallResult>(),
  };
  const uv = { progress: undefined as ((p: UvProgress) => void) | undefined, run: deferred<UvInstalled>() };
  const checks: ({ fresh?: boolean } | undefined)[] = [];
  const installed: string[] = [];
  const opts: SetupServiceOptions = {
    platform: 'win32',
    systemCheck: {
      check: (o) => {
        checks.push(o);
        return Promise.resolve(REPORT);
      },
      driver: () => Promise.resolve({ state: 'ok', recommendedAction: 'none', links: [] }),
    },
    docker: {
      plan: () => Promise.resolve({ platform: 'darwin', kind: 'none', supported: false, reason: 'unsupported-platform' }),
      install: (p, s) => {
        docker.progress = p;
        docker.signal = s;
        return docker.run.promise;
      },
      linuxScript: () => ({ script: 'set -e', steps: ['prepare'] }),
    },
    uv: {
      install: (p) => {
        uv.progress = p;
        return uv.run.promise;
      },
      uvPath: () => Promise.resolve('/e/uv/0.12.23/uv'),
    },
    publish: (e) => events.push(e),
    wall: () => Date.UTC(2026, 9, 6),
    log: memoryLogger(),
    onInstalled: (k) => installed.push(k),
    ...over,
  };
  const svc = createSetupService(opts);
  const app = new Hono();
  app.onError((e, c) => errorResponse(c, e));
  createSetupRoutes(() => svc)(app, {} as CoreContext);
  return { app, svc, events, docker, uv, checks, installed };
}

const json = async (res: Response) => (await res.json()) as unknown;

describe('setup routes', () => {
  it('serves the checklist, driver, plan and the Linux script', async () => {
    const { app, checks } = setup();
    expect(await json(await app.request('/api/setup/check'))).toEqual(REPORT);
    await app.request('/api/setup/check?fresh=1');
    expect(checks).toEqual([{ fresh: false }, { fresh: true }]);
    expect(await json(await app.request('/api/setup/driver'))).toEqual({ state: 'ok', recommendedAction: 'none', links: [] });
    expect(await json(await app.request('/api/setup/docker/plan'))).toMatchObject({ kind: 'none' });
    expect(await json(await app.request('/api/setup/docker/linux-script'))).toEqual({ script: 'set -e', steps: ['prepare'] });
  });

  it('accepts the service directly too', async () => {
    const { svc } = setup();
    const app = new Hono();
    createSetupRoutes(svc)(app, {} as CoreContext);
    expect((await app.request('/api/setup/jobs')).status).toBe(200);
  });

  it('starts the Docker install in the background and streams engine.install events', async () => {
    const { app, events, docker, installed } = setup();
    const res = await app.request('/api/setup/docker/install', { method: 'POST' });
    expect(res.status).toBe(202);
    expect(await json(res)).toMatchObject({ started: true, job: { kind: 'docker-desktop', state: 'running', stage: 'starting' } });
    docker.progress?.({ stage: 'download', bytesDone: 10, bytesTotal: 100 });
    docker.progress?.({ stage: 'verify', bytesDone: 100 });
    // A second click joins the running job.
    expect(await json(await app.request('/api/setup/docker/install', { method: 'POST' }))).toMatchObject({ started: false, job: { stage: 'verify' } });
    docker.run.resolve({ kind: 'docker-desktop', outcome: 'reboot-maybe-required', exitCode: 3010 });
    await tick();
    expect(events).toEqual([
      { type: 'engine.install', kind: 'docker-desktop', bytesDone: 0, stage: 'starting' },
      { type: 'engine.install', kind: 'docker-desktop', bytesDone: 10, bytesTotal: 100, stage: 'download' },
      { type: 'engine.install', kind: 'docker-desktop', bytesDone: 100, bytesTotal: 100, stage: 'verify' },
      {
        type: 'engine.install',
        kind: 'docker-desktop',
        bytesDone: 100,
        bytesTotal: 100,
        stage: 'reboot-maybe-required',
        result: { kind: 'docker-desktop', outcome: 'reboot-maybe-required', exitCode: 3010 },
      },
    ]);
    const jobs = (await json(await app.request('/api/setup/jobs'))) as SetupJob[];
    expect(jobs).toEqual([
      {
        kind: 'docker-desktop',
        state: 'done',
        stage: 'reboot-maybe-required',
        bytesDone: 100,
        bytesTotal: 100,
        startedAt: '2026-10-06T00:00:00.000Z',
        finishedAt: '2026-10-06T00:00:00.000Z',
        result: { kind: 'docker-desktop', outcome: 'reboot-maybe-required', exitCode: 3010 },
      },
    ]);
    expect(installed).toEqual(['docker-desktop']);
  });

  it('uses the docker-linux job on Linux and refuses other platforms', async () => {
    const linux = setup({ platform: 'linux' });
    expect(await json(await linux.app.request('/api/setup/docker/install', { method: 'POST' }))).toMatchObject({ job: { kind: 'docker-linux' } });
    const mac = setup({ platform: 'darwin' });
    const res = await mac.app.request('/api/setup/docker/install', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await json(res)).toMatchObject({ error: { code: 'DOCKER_UNSUPPORTED' } });
  });

  it('reports failures and lets a failed job be restarted', async () => {
    const { app, svc, docker, events } = setup({ onInstalled: undefined });
    svc.startDockerInstall();
    docker.run.reject(new AppError('ENGINE_INSTALL_FAILED', 'Installer signature check failed: status', { params: { reason: 'bad-signature' } }));
    await tick();
    expect(svc.jobs()[0]).toMatchObject({ state: 'failed', stage: 'failed', error: { code: 'ENGINE_INSTALL_FAILED', params: { reason: 'bad-signature' } } });
    // The final event carries the error, so the UI can explain it without polling the jobs.
    expect(events.at(-1)).toEqual({
      type: 'engine.install',
      kind: 'docker-desktop',
      bytesDone: 0,
      stage: 'failed',
      error: { code: 'ENGINE_INSTALL_FAILED', message: 'Installer signature check failed: status', params: { reason: 'bad-signature' } },
    });
    docker.run = deferred();
    expect(await json(await app.request('/api/setup/docker/install', { method: 'POST' }))).toMatchObject({ started: true });
  });

  it('cancels a running job through the API', async () => {
    const { app, docker, events } = setup();
    await app.request('/api/setup/docker/install', { method: 'POST' });
    const res = await app.request('/api/setup/jobs/docker-desktop/cancel', { method: 'POST' });
    expect(await json(res)).toMatchObject({ kind: 'docker-desktop', state: 'running' });
    expect(docker.signal?.aborted).toBe(true);
    // The installer reports a plain abort: it becomes CANCELLED.
    docker.run.reject(new DOMException('aborted', 'AbortError'));
    await tick();
    const job = ((await json(await app.request('/api/setup/jobs'))) as SetupJob[])[0];
    expect(job).toMatchObject({ state: 'cancelled', stage: 'cancelled', error: { code: 'CANCELLED' } });
    expect(events.at(-1)).toMatchObject({ stage: 'cancelled', error: { code: 'CANCELLED' } });
    expect(events.at(-1)).not.toHaveProperty('result');
    // Cancelling a finished job is a no-op that returns it.
    expect(await json(await app.request('/api/setup/jobs/docker-desktop/cancel', { method: 'POST' }))).toMatchObject({ state: 'cancelled' });
  });

  it('maps a generic error thrown after a cancel to CANCELLED, and keeps AppErrors as they are', async () => {
    const a = setup();
    a.svc.startDockerInstall();
    a.svc.cancel('docker-desktop');
    a.docker.run.reject(new Error('socket hang up'));
    await tick();
    expect(a.svc.jobs()[0]).toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED' } });
    const b = setup();
    b.svc.startDockerInstall();
    b.svc.cancel('docker-desktop');
    b.docker.run.reject(new AppError('DOWNLOAD_FAILED', 'x'));
    await tick();
    expect(b.svc.jobs()[0]).toMatchObject({ state: 'failed', error: { code: 'DOWNLOAD_FAILED' } });
  });

  it('validates cancel requests', async () => {
    const { app } = setup();
    expect(await json(await app.request('/api/setup/jobs/rm-rf/cancel', { method: 'POST' }))).toMatchObject({ error: { code: 'VALIDATION' } });
    const res = await app.request('/api/setup/jobs/uv/cancel', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: { code: 'VALIDATION', params: { reason: 'no-job' } } });
  });

  it('installs uv as a job and exposes its path', async () => {
    const { app, svc, uv, events } = setup();
    const res = await app.request('/api/setup/uv/install', { method: 'POST' });
    expect(res.status).toBe(202);
    uv.progress?.({ stage: 'download', bytesDone: 5 });
    uv.run.resolve({ version: '0.12.23', path: '/e/uv/0.12.23/uv' });
    await tick();
    expect(svc.jobs()[0]).toMatchObject({ kind: 'uv', state: 'done', stage: 'installed', result: { version: '0.12.23' } });
    expect(events.map((e) => (e as { stage: string }).stage)).toEqual(['starting', 'download', 'installed']);
    expect(events.at(-1)).toMatchObject({ result: { version: '0.12.23', path: '/e/uv/0.12.23/uv' } });
    expect(await svc.uvPath()).toBe('/e/uv/0.12.23/uv');
  });

  it('aborts running jobs on core shutdown', async () => {
    const shutdown = new AbortController();
    const { svc, docker } = setup({ shutdown: shutdown.signal, wall: undefined });
    svc.startDockerInstall();
    shutdown.abort();
    expect(docker.signal?.aborted).toBe(true);
    docker.run.reject(new AppError('CANCELLED', 'Download cancelled'));
    await tick();
    expect(svc.jobs()[0]).toMatchObject({ state: 'cancelled' });
    expect(typeof svc.jobs()[0]?.startedAt).toBe('string');
  });
});
