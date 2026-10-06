import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCacheRoutes } from '../../../../src/core/cache/routes';
import { createLinuxEvictor } from '../../../../src/core/cache/evictor';
import type { WindowsStandbyEvictor } from '../../../../src/core/cache/windows-standby';
import { createApp } from '../../../../src/core/server/app';
import { noProc, tempDir, testContext, testDeps } from '../server/helpers';

const H = { authorization: 'Bearer t', host: '127.0.0.1:1' };

function fakeWindows(state: { installed: boolean; allow: boolean }): WindowsStandbyEvictor {
  return {
    kind: 'windows-standby',
    evict: async () => ({ guaranteed: state.installed }),
    info: async () => ({ installed: state.installed }),
    install: async () => {
      if (state.allow) state.installed = true;
      return state.installed;
    },
    uninstall: async () => {
      if (state.allow) state.installed = false;
      return !state.installed;
    },
  } as unknown as WindowsStandbyEvictor;
}

describe('cache routes', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  it('reports automatic eviction on Linux and refuses the Windows task there', async () => {
    const ctx = testContext(testDeps(t.dir));
    const app = createApp(ctx, { token: 't', port: () => 1, modules: [createCacheRoutes({ evictor: createLinuxEvictor({ proc: noProc }) })] });
    expect(await (await app.request('/api/cache/cold', { headers: H })).json()).toEqual({ method: 'linux-fadvise', automatic: true });
    expect((await app.request('/api/cache/windows-task', { method: 'POST', headers: H })).status).toBe(400);
    expect((await app.request('/api/cache/windows-task', { method: 'DELETE', headers: H })).status).toBe(400);
  });

  it('installs and removes the Windows task, mirroring the opt-in in settings', async () => {
    const ctx = testContext(testDeps(t.dir));
    const state = { installed: false, allow: true };
    const win = fakeWindows(state);
    const app = createApp(ctx, { token: 't', port: () => 1, modules: [createCacheRoutes({ evictor: win, windowsStandby: win })] });
    expect(await (await app.request('/api/cache/cold', { headers: H })).json()).toEqual({
      method: 'windows-standby',
      automatic: false,
      windowsTaskInstalled: false,
    });
    const on = await app.request('/api/cache/windows-task', { method: 'POST', headers: H });
    expect(await on.json()).toMatchObject({ windowsTaskInstalled: true });
    expect((await ctx.settings.get()).coldCacheOptIn).toBe(true);
    const off = await app.request('/api/cache/windows-task', { method: 'DELETE', headers: H });
    expect(await off.json()).toMatchObject({ windowsTaskInstalled: false });
    expect((await ctx.settings.get()).coldCacheOptIn).toBe(false);
  });

  it('answers 409 when the UAC prompt is declined', async () => {
    const ctx = testContext(testDeps(t.dir));
    const win = fakeWindows({ installed: false, allow: false });
    const app = createApp(ctx, { token: 't', port: () => 1, modules: [createCacheRoutes({ evictor: win, windowsStandby: win })] });
    expect((await app.request('/api/cache/windows-task', { method: 'POST', headers: H })).status).toBe(409);
    expect((await ctx.settings.get()).coldCacheOptIn).toBe(false);
    const stuck = fakeWindows({ installed: true, allow: false });
    const app2 = createApp(ctx, { token: 't', port: () => 1, modules: [createCacheRoutes({ evictor: stuck, windowsStandby: stuck })] });
    expect((await app2.request('/api/cache/windows-task', { method: 'DELETE', headers: H })).status).toBe(409);
  });
});
