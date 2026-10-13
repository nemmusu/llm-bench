/**
 * NInfer's routes over its composition (createNinferServices) and the fake wsl.exe with real processes:
 * distros, "Indica dove si trova", the guided build and the update, as 'engine.install' events.
 */
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ServerEvent } from '../../../../../src/contract/events';
import type { NinferSettings } from '../../../../../src/contract/ninfer';
import type { CoreContext } from '../../../../../src/core/context';
import { createNinferRoutes, withBuild } from '../../../../../src/core/engines/ninfer/routes';
import { createNinferServices } from '../../../../../src/core/engines/ninfer/setup';
import { systemClock } from '../../../../../src/core/node-deps';
import { errorResponse } from '../../../../../src/core/server/http-error';
import { recordingLog, tempDir } from '../../docker/helpers';
import { realClients, realProc, WSL_ARGV } from './helpers';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});

type InstallEvent = Extract<ServerEvent, { type: 'engine.install' }>;
const INCOMING = [{ sha: '4f2a9c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49', title: 'serve: faster MTP verification' }];

function setup(o: { config?: Record<string, unknown>; platform?: 'win32' | 'linux'; ninfer?: NinferSettings } = {}) {
  const t = tempDir('gb-ninfer-routes-');
  cleanups.push(t.cleanup);
  const log = recordingLog();
  let saved: { ninfer?: NinferSettings } = o.ninfer ? { ninfer: o.ninfer } : {};
  const services = createNinferServices({
    deps: {
      clock: systemClock,
      proc: realProc(path.join(t.dir, 'wsl'), { FAKE_WSL_CONFIG: JSON.stringify({ stepMs: 5, ...o.config }) }),
      fetch: globalThis.fetch,
      platform: o.platform ?? 'win32',
      log,
      paths: { dataDir: t.dir } as never,
      endpoints: { wsl: WSL_ARGV } as never,
    },
    createClient: realClients,
    settings: {
      get: async () => saved,
      update: async (patch) => {
        saved = { ...saved, ...patch };
      },
    },
    gpus: async () => [{ name: 'NVIDIA GeForce RTX 5090' }],
    ownership: { add: async () => undefined, remove: async () => undefined },
    models: async () => [],
  });
  const events: InstallEvent[] = [];
  const shutdown = new AbortController();
  const app = new Hono();
  app.onError((e, c) => errorResponse(c, e));
  createNinferRoutes(services.routes({ publish: (e) => events.push(e as InstallEvent), shutdown: shutdown.signal }))(app, {} as CoreContext);
  const post = (route: string, body: unknown) => app.request(route, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const last = async (stage: 'done' | 'error') => {
    for (let i = 0; i < 400 && !events.some((e) => e.stage === stage); i++) await new Promise((r) => setTimeout(r, 25));
    return events.find((e) => e.stage === stage) as InstallEvent;
  };
  return { t, app, post, events, last, services, shutdown, log, saved: () => saved };
}

describe('NInfer routes', () => {
  it('lists the distros of WSL (Windows only)', async () => {
    const { app } = setup();
    expect(await (await app.request('/api/engines/ninfer/distros')).json()).toEqual({ wsl: true, distros: [{ name: 'Ubuntu-24.04', default: true, version: 2, running: true }] });
    const linux = setup({ platform: 'linux' });
    expect(await (await linux.app.request('/api/engines/ninfer/distros')).json()).toEqual({ wsl: false, distros: [] });
  }, 60_000);

  it('checks a path before it is saved, and refuses other engines', async () => {
    const { post } = setup();
    expect(await (await post('/api/engines/ninfer/check', { kind: 'ninfer-wsl', ninferPath: '/home/user/ninfer', wslDistro: 'Ubuntu-24.04' })).json()).toMatchObject({ available: true, version: 'e31bc99b13f5' });
    expect((await post('/api/engines/ninfer/check', { kind: 'llamacpp-native' })).status).toBe(400);
  }, 60_000);

  it('plans and runs the guided build, then saves where NInfer is; one build at a time', async () => {
    const r = setup({ ninfer: { native: { path: '/opt/ninfer' } } });
    expect(await (await r.post('/api/engines/ninfer/build-plan', { kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/fresh' })).json()).toMatchObject({ existing: false, ready: true });
    expect((await r.post('/api/engines/ninfer/build', { kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/fresh' })).status).toBe(400);
    expect((await r.post('/api/engines/ninfer/build', { kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/fresh', confirm: true })).status).toBe(200);
    const busy = await r.post('/api/engines/ninfer/build', { kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', confirm: true });
    expect(busy.status).toBe(400);
    expect(await busy.json()).toMatchObject({ error: { params: { reason: 'busy' } } });
    const done = await r.last('done');
    expect(done.result).toEqual({ ninferPath: '/home/user/fresh/build/apps/ninfer-serve', distro: 'Ubuntu-24.04' });
    expect(r.events.map((e) => e.stage)).toEqual(expect.arrayContaining(['resolve', 'clone', 'configure', 'build', 'done']));
    expect(r.events.find((e) => e.stage === 'build' && e.steps !== undefined)).toMatchObject({ kind: 'ninfer-wsl', step: expect.any(Number), steps: 4 });
    expect(r.saved().ninfer).toEqual({ native: { path: '/opt/ninfer' }, wsl: { distro: 'Ubuntu-24.04', path: '/home/user/fresh/build/apps/ninfer-serve' } });
  }, 60_000);

  it('reports a failed build as an error event', async () => {
    const r = setup({ config: { failStage: 'build' } });
    await r.post('/api/engines/ninfer/build', { kind: 'ninfer-native', confirm: true });
    expect((await r.last('error')).error).toMatchObject({ code: 'ENGINE_INSTALL_FAILED' });
  }, 60_000);

  it('checks for updates, updates, and the build shows the new commit at once', async () => {
    const r = setup({ config: { incoming: INCOMING }, ninfer: { wsl: { distro: 'Ubuntu-24.04', path: '/home/user/ninfer' } } });
    expect(await (await r.post('/api/engines/ninfer/check', { kind: 'ninfer-wsl' })).json()).toMatchObject({ version: 'e31bc99b13f5' });
    expect(await (await r.post('/api/engines/ninfer/update-check', { kind: 'ninfer-wsl' })).json()).toMatchObject({ behind: 1, commits: INCOMING });
    expect((await r.post('/api/engines/ninfer/update', { kind: 'ninfer-wsl' })).status).toBe(400);
    expect((await r.post('/api/engines/ninfer/update', { kind: 'ninfer-wsl', confirm: true })).status).toBe(200);
    expect((await r.last('done')).result).toEqual({ ninferPath: '/home/user/ninfer/build/apps/ninfer-serve', commit: INCOMING[0]?.sha });
    expect(await r.services.wsl.detect()).toMatchObject({ version: '4f2a9c1d0e8b' });
  }, 60_000);

  it('a shutdown stops a running build', async () => {
    const r = setup({ config: { stepMs: 2000 } });
    await r.post('/api/engines/ninfer/build', { kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', confirm: true });
    for (let i = 0; i < 200 && !r.events.some((e) => e.stage === 'configure'); i++) await new Promise((res) => setTimeout(res, 25));
    r.shutdown.abort();
    expect((await r.last('error')).error).toMatchObject({ code: 'CANCELLED' });
  }, 60_000);

  it('stops the servers a crashed session left in WSL (Windows only)', async () => {
    const r = setup();
    writeFileSync(path.join(r.t.dir, 'ninfer-wsl.json'), JSON.stringify({ schema: 1, records: [{ distro: 'Ubuntu-24.04', pid: 999_999, marker: 'gpubench-gone-1', startedAtWall: 1 }] }));
    await r.services.cleanupOrphans();
    expect(await r.services.processes.list()).toEqual([]);
    expect(r.log.entries.some((e) => e.msg.startsWith('stopped NInfer servers'))).toBe(false);
    const leftover = { distro: 'Ubuntu-24.04', pid: 7, marker: 'gpubench-left-1', startedAtWall: 1 };
    r.services.processes.cleanupOrphans = async () => [leftover];
    await r.services.cleanupOrphans();
    expect(r.log.entries.find((e) => e.msg.startsWith('stopped NInfer servers'))?.data).toEqual({ pids: [7] });
    // Linux: there is no WSL to ask.
    const linux = setup({ platform: 'linux' });
    writeFileSync(path.join(linux.t.dir, 'ninfer-wsl.json'), JSON.stringify({ schema: 1, records: [{ distro: 'Ubuntu-24.04', pid: 5, marker: 'gpubench-gone-2', startedAtWall: 1 }] }));
    await linux.services.cleanupOrphans();
    expect(await linux.services.processes.list()).toHaveLength(1);
  }, 60_000);

  it('saves the build of one kind and keeps the other', () => {
    expect(withBuild(undefined, 'ninfer-native', { path: '/n' })).toEqual({ native: { path: '/n' } });
    expect(withBuild({ native: { path: '/n' } }, 'ninfer-wsl', { path: '/w', distro: 'Ubuntu' })).toEqual({ native: { path: '/n' }, wsl: { distro: 'Ubuntu', path: '/w' } });
  });
});
