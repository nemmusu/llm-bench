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

const PREREQS = ['##home /home/u', '##git git version 2.43.0', '##cmake cmake version 3.28.3', '##ninja 1.11.1', '##compiler g++ 13.3.0', '##pkg-config 1.8.1', '##nvcc /usr/bin/nvcc', '##cuda release 13.1, V13.1.80', '##ffmpeg 60 60 58 7', '##curl 8.5.0', '##checkout yes'].join('\n');

type InstallEvent = Extract<ServerEvent, { type: 'engine.install' }>;

function stub(over: Partial<NinferRouteDeps> = {}) {
  const events: InstallEvent[] = [];
  const saved: unknown[] = [];
  const deps: NinferRouteDeps = {
    distros: async () => ({ wsl: false, distros: [] }),
    check: async (kind) => ({ kind, available: false, installed: false, problems: [], supported: true }),
    builder: () => ({ plan: async () => ({}) as never, build: async () => '/opt/ninfer/build/apps/ninfer-serve' }),
    saveBuild: async (kind, where) => {
      saved.push([kind, where]);
    },
    jobs: { building: false },
    publish: (e) => events.push(e as InstallEvent),
    ...over,
  };
  const app = new Hono();
  app.onError((e, c) => errorResponse(c, e));
  createNinferRoutes(deps)(app, {} as CoreContext);
  const post = (route: string, body: unknown) => app.request(route, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const done = async () => {
    for (let i = 0; i < 100 && !events.some((e) => e.stage === 'done' || e.stage === 'error'); i++) await new Promise((r) => setTimeout(r, 5));
    return events.at(-1) as InstallEvent;
  };
  return { post, events, saved, done };
}

describe('NInfer routes (stub services)', () => {
  it('a native build has no distro in its result', async () => {
    const r = stub();
    await r.post('/api/engines/ninfer/build', { kind: 'ninfer-native', confirm: true });
    expect((await r.done()).result).toEqual({ ninferPath: '/opt/ninfer/build/apps/ninfer-serve' });
    expect(r.saved).toEqual([['ninfer-native', { path: '/opt/ninfer/build/apps/ninfer-serve' }]]);
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
