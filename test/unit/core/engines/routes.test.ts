import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { EngineStatus } from '../../../../src/contract/engines';
import { AppError } from '../../../../src/contract/errors';
import type { ServerEvent } from '../../../../src/contract/events';
import type { CoreContext } from '../../../../src/core/context';
import type { InstalledBuild } from '../../../../src/core/engines/llamacpp-native/install';
import { EngineRegistry } from '../../../../src/core/engines/registry';
import { createEnginesRoutes, type EnginesRouteDeps, type LlamaInstallService } from '../../../../src/core/engines/routes';
import type { EngineAdapter, InstallPlan } from '../../../../src/core/engines/types';
import { errorResponse } from '../../../../src/core/server/http-error';

function fakeAdapter(kind: EngineAdapter['kind'], detect: EngineAdapter['detect']): EngineAdapter {
  return {
    kind,
    detect,
    capabilities: async () => ({ flags: new Set(), tokenIdsInPrompt: false, timings: false, minTokens: false, fitFlag: false }),
    plan: async () => {
      throw new Error('unused');
    },
    start: async () => {
      throw new Error('unused');
    },
  };
}

describe('EngineRegistry', () => {
  it('reports every kind; missing adapters are unsupported; detect failures become problems', async () => {
    const llama = fakeAdapter('llamacpp-native', async (cfg) => ({
      kind: 'llamacpp-native',
      available: true,
      installed: true,
      problems: [],
      supported: true,
      location: cfg?.executable ?? 'managed',
    }));
    const ext = fakeAdapter('external', async () => {
      throw new AppError('ENDPOINT_UNREACHABLE', 'down');
    });
    const reg = new EngineRegistry([llama, ext]);
    expect(reg.get('llamacpp-native')).toBe(llama);
    expect(reg.get('vllm-docker')).toBeUndefined();
    expect(reg.require('external')).toBe(ext);
    expect(() => reg.require('vllm-native')).toThrow(AppError);
    const all = await reg.detectAll({ 'llamacpp-native': { kind: 'llamacpp-native', executable: 'C:\\x.exe' } });
    expect(all.map((s) => [s.kind, s.supported, s.problems])).toEqual([
      ['llamacpp-native', true, []],
      ['llamacpp-docker', false, []],
      ['vllm-docker', false, []],
      ['vllm-native', false, []],
      ['external', true, ['ENDPOINT_UNREACHABLE']],
    ]);
    expect(all[0]?.location).toBe('C:\\x.exe');
    expect((await new EngineRegistry().detectAll()).every((s) => !s.supported)).toBe(true);
  });
});

const build: InstalledBuild = {
  schema: 1,
  id: 'b1-cpu',
  tag: 'b1',
  variant: 'cpu',
  backend: 'cpu',
  server: 'llama-server.exe',
  files: [],
  installedAt: '2026-01-01T00:00:00.000Z',
  sources: [],
  dir: 'C:\\e\\llamacpp\\b1-cpu',
  serverPath: 'C:\\e\\llamacpp\\b1-cpu\\llama-server.exe',
};
const plan: InstallPlan = { kind: 'llamacpp-native', label: 'llama.cpp b1 (cpu)', bytes: 10, items: [], data: {} };

function setup(llama: Partial<LlamaInstallService> = {}, extra: Partial<EnginesRouteDeps> = {}) {
  const events: ServerEvent[] = [];
  const svc: EnginesRouteDeps = {
    registry: new EngineRegistry([
      fakeAdapter('llamacpp-native', async (): Promise<EngineStatus> => ({ kind: 'llamacpp-native', available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true })),
    ]),
    llama: {
      releases: async () => [{ tag: 'b1', publishedAt: '', assets: [] }],
      planInstall: async () => plan,
      installBuild: async (_p, progress) => {
        progress({ stage: 'download', bytesDone: 5, bytesTotal: 10 });
        progress({ stage: 'done', bytesDone: 10 });
        return build;
      },
      listInstalled: async () => [build],
      removeBuild: async () => {},
      ...llama,
    },
    publish: (e) => events.push(e),
    ...extra,
  };
  const app = new Hono();
  app.onError((e, c) => errorResponse(c, e));
  createEnginesRoutes(svc)(app, {} as CoreContext);
  return { app, events, svc };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('engines routes', () => {
  it('GET /api/engines (with and without saved configs)', async () => {
    const { app } = setup();
    const res = await app.request('/api/engines');
    expect(res.status).toBe(200);
    expect(((await res.json()) as EngineStatus[]).map((s) => s.kind)).toHaveLength(5);
    const configs = vi.fn(async () => ({ external: { kind: 'external' as const, baseUrl: 'http://x' } }));
    const withCfg = setup({}, { configs });
    await withCfg.app.request('/api/engines');
    expect(configs).toHaveBeenCalled();
  });

  it('GET releases / installed, DELETE installed build', async () => {
    const removeBuild = vi.fn(async () => {});
    const { app } = setup({ removeBuild });
    expect(await (await app.request('/api/engines/llamacpp/releases')).json()).toEqual([{ tag: 'b1', publishedAt: '', assets: [] }]);
    expect(await (await app.request('/api/engines/llamacpp/installed')).json()).toEqual([build]);
    const del = await app.request('/api/engines/llamacpp/installed/b1-cpu', { method: 'DELETE' });
    expect(await del.json()).toEqual({ ok: true });
    expect(removeBuild).toHaveBeenCalledWith('b1-cpu');
    const failing = setup({
      removeBuild: async () => {
        throw new AppError('VALIDATION', 'Invalid build id');
      },
    });
    expect((await failing.app.request('/api/engines/llamacpp/installed/B1', { method: 'DELETE' })).status).toBe(400);
  });

  it('POST install answers at once and streams progress as engine.install events', async () => {
    const { app, events } = setup();
    const res = await app.request('/api/engines/llamacpp-native/install', { method: 'POST', body: JSON.stringify({ build: 'b1' }) });
    expect(await res.json()).toEqual({ ok: true });
    await until(() => events.some((e) => e.type === 'engine.install' && e.stage === 'done'));
    expect(events).toEqual([
      { type: 'engine.install', kind: 'llamacpp-native', stage: 'resolve', bytesDone: 0 },
      { type: 'engine.install', kind: 'llamacpp-native', stage: 'download', bytesDone: 5, bytesTotal: 10 },
      { type: 'engine.install', kind: 'llamacpp-native', stage: 'done', bytesDone: 10 },
    ]);
  });

  it('one install at a time; failures are published as error events', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, events } = setup({
      installBuild: async () => {
        await gate;
        throw new AppError('DOWNLOAD_CHECKSUM', 'bad', { params: { file: 'x.zip' } });
      },
    });
    expect((await app.request('/api/engines/llamacpp-native/install', { method: 'POST', body: '{}' })).status).toBe(200);
    const busy = await app.request('/api/engines/llamacpp-native/install', { method: 'POST', body: '{}' });
    expect(busy.status).toBe(400);
    expect(await busy.json()).toMatchObject({ error: { code: 'VALIDATION', params: { reason: 'busy' } } });
    release();
    await until(() => events.some((e) => e.type === 'engine.install' && e.stage === 'error'));
    expect(events.at(-1)).toEqual({
      type: 'engine.install',
      kind: 'llamacpp-native',
      stage: 'error',
      bytesDone: 0,
      error: { code: 'DOWNLOAD_CHECKSUM', message: 'bad', params: { file: 'x.zip' } },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect((await app.request('/api/engines/llamacpp-native/install', { method: 'POST', body: '{}' })).status).toBe(200);
  });

  it('rejects other kinds and bad bodies', async () => {
    const { app } = setup();
    const other = await app.request('/api/engines/vllm-docker/install', { method: 'POST', body: '{}' });
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ error: { code: 'VALIDATION', params: { kind: 'vllm-docker' } } });
    expect((await app.request('/api/engines/llamacpp-native/install', { method: 'POST', body: 'nope' })).status).toBe(400);
    expect((await app.request('/api/engines/llamacpp-native/install', { method: 'POST', body: '{"build":5}' })).status).toBe(400);
  });

  it('core shutdown aborts a running install', async () => {
    const shutdown = new AbortController();
    let seen: AbortSignal | undefined;
    const { app, events } = setup(
      {
        planInstall: async (_req, signal) => {
          seen = signal;
          await new Promise((r) => signal?.addEventListener('abort', r));
          throw new AppError('CANCELLED', 'Install cancelled');
        },
      },
      { shutdown: shutdown.signal },
    );
    await app.request('/api/engines/llamacpp-native/install', { method: 'POST', body: '{}' });
    await until(() => seen !== undefined);
    shutdown.abort();
    await until(() => events.some((e) => e.type === 'engine.install' && e.stage === 'error'));
    expect(events.at(-1)).toMatchObject({ stage: 'error', error: { code: 'CANCELLED' } });
  });
});
