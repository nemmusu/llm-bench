/** NInfer's routes with stub services, and its composition's defaults (no processes). */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import type { ServerEvent } from '../../../../../src/contract/events';
import type { CoreContext } from '../../../../../src/core/context';
import { createNinferRoutes, type NinferRouteDeps } from '../../../../../src/core/engines/ninfer/routes';
import { createNinferServices } from '../../../../../src/core/engines/ninfer/setup';
import { errorResponse } from '../../../../../src/core/server/http-error';
import { ok, scriptedProc, silentLog, steppingClock, tempDir } from '../../docker/helpers';
import { realClients } from './helpers';

const PREREQS = [
  '##home /home/u',
  '##git git version 2.43.0',
  '##cmake cmake version 3.28.3',
  '##ninja 1.11.1',
  '##compiler g++ 13.3.0',
  '##pkg-config 1.8.1',
  '##nvcc /usr/local/cuda-13.1/bin/nvcc release 13.1',
  '##ffmpeg 60 60 58 7',
  '##curl 8.5.0',
  '##checkout yes',
].join('\n');

type InstallEvent = Extract<ServerEvent, { type: 'engine.install' }>;

function stub(over: Partial<NinferRouteDeps> = {}) {
  const events: InstallEvent[] = [];
  const saved: unknown[] = [];
  const deps: NinferRouteDeps = {
    distros: async () => ({ wsl: false, distros: [] }),
    check: async (kind) => ({ kind, available: false, installed: false, problems: [], supported: true }),
    builder: () => ({ plan: async (req) => ({ dir: req.dir }) as never, build: async () => '/opt/ninfer/build/apps/ninfer-serve' }),
    normalize: async (req) => req,
    saveBuild: async (kind, where) => {
      saved.push([kind, where]);
      return undefined;
    },
    builds: async (fresh) => ({ kind: 'ninfer-native', builds: fresh ? [] : [{ build: 'official', kind: 'ninfer-native', state: 'missing', source: { url: 'https://x/y.git' }, dir: '~/ninfer' }] }),
    setBuildPath: async (build, body) => ({ saved: build === 'all', status: { kind: 'ninfer-native', available: true, installed: true, location: body.path, problems: [], supported: true } }),
    jobs: { building: false },
    publish: (e) => events.push(e as InstallEvent),
    ...over,
  };
  const app = new Hono();
  app.onError((e, c) => errorResponse(c, e));
  createNinferRoutes(deps)(app, {} as CoreContext);
  const send = (method: string, route: string, body?: unknown) =>
    app.request(route, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  const post = (route: string, body?: unknown) => send('POST', route, body);
  const done = async () => {
    for (let i = 0; i < 100 && !events.some((e) => e.stage === 'done' || e.stage === 'error'); i++) await new Promise((r) => setTimeout(r, 5));
    return events.at(-1) as InstallEvent;
  };
  return { post, send, events, saved, done, deps };
}

describe('NInfer routes (stub services)', () => {
  it('a native build has no distro in its result', async () => {
    const r = stub();
    await r.post('/api/engines/ninfer/build', { kind: 'ninfer-native', confirm: true });
    expect((await r.done()).result).toEqual({ ninferPath: '/opt/ninfer/build/apps/ninfer-serve' });
    expect(r.saved).toEqual([['ninfer-native', { path: '/opt/ninfer/build/apps/ninfer-serve' }]]);
  });

  it("NInfer-all's build: its own events, its name once its request is filled in", async () => {
    const r = stub({ normalize: async (req) => ({ ...req, dir: '~/ninfer-all', variant: { template: 'ninfer-all', name: 'NInfer-all' } }) });
    expect(await (await r.post('/api/engines/ninfer/build-plan', { kind: 'ninfer-native', build: 'all' })).json()).toEqual({ dir: '~/ninfer-all' });
    await r.post('/api/engines/ninfer/build', { kind: 'ninfer-native', build: 'all', confirm: true });
    await r.done();
    expect(r.events.every((e) => e.kind === 'ninfer-all')).toBe(true);
    expect(r.events[0]).not.toHaveProperty('label');
    expect(r.events.at(-1)).toMatchObject({ stage: 'done', label: 'NInfer-all' });
  });

  it('a build running can be cancelled; with none, nothing is', async () => {
    let release!: () => void;
    const r = stub({
      builder: () => ({
        plan: async () => ({}) as never,
        build: (_req, _progress, signal) =>
          new Promise<string>((_resolve, reject) => {
            release = () => reject(new Error('never'));
            signal.addEventListener('abort', () => reject(Object.assign(new Error('Build cancelled'), { code: 'CANCELLED' })));
          }),
      }),
    });
    expect(await (await r.post('/api/engines/ninfer/build/cancel')).json()).toEqual({ ok: true, cancelled: false });
    await r.post('/api/engines/ninfer/build', { kind: 'ninfer-native', confirm: true });
    // One build at a time.
    expect((await r.post('/api/engines/ninfer/build', { kind: 'ninfer-native', confirm: true })).status).toBe(400);
    expect(await (await r.post('/api/engines/ninfer/build/cancel')).json()).toEqual({ ok: true, cancelled: true });
    expect((await r.done()).stage).toBe('error');
    expect(r.deps.jobs).toEqual({ building: false, cancel: undefined });
    release();
  });

  it('the two builds, fresh when asked; a folder of the user\'s own for one of them', async () => {
    const r = stub();
    expect(await (await r.send('GET', '/api/engines/ninfer/builds')).json()).toMatchObject({ builds: [{ build: 'official', state: 'missing' }] });
    expect(await (await r.send('GET', '/api/engines/ninfer/builds?fresh=1')).json()).toEqual({ kind: 'ninfer-native', builds: [] });
    expect(await (await r.send('PUT', '/api/engines/ninfer/builds/all', { path: '/opt/all' })).json()).toMatchObject({ saved: true, status: { location: '/opt/all' } });
    const bad = await r.send('PUT', '/api/engines/ninfer/builds/other', { path: '/opt/x' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'VALIDATION', params: { reason: 'ninfer_build_id', build: 'other' } } });
  });
});

describe('NInfer services (defaults)', () => {
  it('uses wsl.exe, no ownership registry, no library, and routes without a shutdown signal', async () => {
    const t = tempDir('gb-ninfer-setup-');
    try {
      const clock = steppingClock();
      let alive = true;
      const proc = scriptedProc(
        (args, cmd) => {
          const exec = args.slice(args.indexOf('--exec') + 1);
          // Linux (the native builder): every prerequisite there.
          if (cmd !== 'wsl.exe') return ok(PREREQS);
          if (exec[0] === 'cat') return alive ? ok('GPUBENCH_OWNER=gpubench-old-1\0') : { code: 1, stdout: '', stderr: 'gone', timedOut: false };
          if (exec[0] === 'kill') {
            alive = exec[1] === '-TERM' ? alive : false;
            return ok();
          }
          if (exec[0] === '/bin/sh') return ok('##home /home/u\n##checkout yes\n');
          return ok();
        },
        () => {
          throw new Error('no spawn');
        },
      );
      const services = createNinferServices({
        deps: { clock, proc, fetch: globalThis.fetch, platform: 'win32', log: silentLog, paths: { dataDir: t.dir } as never, endpoints: {} as never },
        createClient: realClients,
        settings: { get: async () => ({ ninfer: { native: { path: '/opt/ninfer' } } }), update: async () => undefined },
        gpus: async () => [],
      });
      // A leftover that stays after TERM: the grace time passes on the clock, then KILL.
      writeFileSync(path.join(t.dir, 'ninfer-wsl.json'), JSON.stringify({ schema: 1, records: [{ distro: 'Ubuntu', pid: 12, marker: 'gpubench-old-1', startedAtWall: 1 }] }));
      await services.cleanupOrphans();
      expect(proc.calls.filter((c) => c.args.includes('kill')).map((c) => c.args.slice(-2))).toEqual([
        ['-TERM', '12'],
        ['-KILL', '12'],
      ]);
      expect(clock.t).toBeGreaterThan(1000);
      const deps = services.routes({ publish: () => undefined });
      expect(deps.shutdown).toBeUndefined();
      // The native builder marks its steps; the updater has no library to read (its check script answers nothing here).
      await expect(deps.builder('ninfer-native').build({ kind: 'ninfer-native' }, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', message: 'Cannot start cmake' });
      expect((await services.updaters['ninfer-native'].plan()).check).toMatchObject({ state: 'none', reason: 'tools', ninfer: { artifacts: [] } });
    } finally {
      t.cleanup();
    }
  });
});
