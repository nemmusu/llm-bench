import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { CustomEngine, CustomEngineCheck, CustomEngineInfo } from '../../../../src/contract/custom-engines';
import type { EngineConfig, EngineStatus } from '../../../../src/contract/engines';
import { settingsSchema, type Settings } from '../../../../src/contract/settings';
import type { CoreContext } from '../../../../src/core/context';
import { withCustomEngines } from '../../../../src/core/engines/custom/adapter';
import { checkCustomEngine, createCustomEngineRoutes } from '../../../../src/core/engines/custom/routes';
import { EngineRegistry } from '../../../../src/core/engines/registry';
import { createEnginesRoutes } from '../../../../src/core/engines/routes';
import type { EngineAdapter } from '../../../../src/core/engines/types';
import { errorResponse } from '../../../../src/core/server/http-error';

/** An adapter whose build lists `flags` (none = its help cannot be read). */
function adapter(kind: EngineAdapter['kind'], o: { flags?: string[]; available?: boolean; capsFail?: boolean } = {}): EngineAdapter & { seen: EngineConfig[] } {
  const seen: EngineConfig[] = [];
  return {
    kind,
    seen,
    detect: async (cfg): Promise<EngineStatus> => {
      seen.push(cfg as EngineConfig);
      return { kind, available: o.available ?? true, installed: true, version: 'b7001', problems: o.available === false ? ['ENGINE_START_FAILED'] : [], supported: true };
    },
    capabilities: async () => {
      if (o.capsFail) throw new Error('no help');
      return { flags: new Set(o.flags ?? []), tokenIdsInPrompt: true, timings: true, minTokens: false, fitFlag: false };
    },
    plan: async () => {
      throw new Error('not here');
    },
    start: async () => {
      throw new Error('not here');
    },
  };
}

const LLAMA_FORK_FLAGS = ['-m', '--host', '--port', '--alias', '-c', '-ngl', '-fa', '-ctk', '-ctv', '-b', '-t', '-np', '--rope-scaling', '--rope-scale', '--yarn-orig-ctx'];

function setup(adapters: EngineAdapter[], initial: unknown[] = []) {
  let settings: Settings = settingsSchema.parse({ customEngines: initial });
  const store = {
    get: async () => settings,
    update: async (patch: Partial<Settings>) => {
      settings = settingsSchema.parse({ ...settings, ...patch });
      return settings;
    },
  };
  const registry = new EngineRegistry(withCustomEngines(adapters, { list: async () => settings.customEngines }));
  const app = new Hono();
  app.onError((e, c) => errorResponse(c, e));
  createCustomEngineRoutes({ settings: store, registry })(app, {} as CoreContext);
  const req = (method: string, url: string, body?: unknown) =>
    app.request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  return { req, current: () => settings.customEngines, registry };
}

const fork = { name: 'Fork PrismML', base: 'llamacpp', run: { mode: 'native', path: '/prism/llama-server' }, extraArgs: ['--ternary-kernels', 'on'], match: { names: ['bonsai'], quants: ['PQ2_0'] } };

describe('custom engines API', () => {
  it('creates, lists with its check, edits, duplicates and deletes', async () => {
    const llama = adapter('llamacpp-native', { flags: LLAMA_FORK_FLAGS });
    const s = setup([llama, adapter('command')]);
    const created = (await (await s.req('POST', '/api/engines/custom', fork)).json()) as CustomEngine;
    expect(created).toMatchObject({ id: 'fork-prismml', name: 'Fork PrismML', schema: 1 });
    const second = (await (await s.req('POST', '/api/engines/custom', fork)).json()) as CustomEngine;
    expect(second.id).toBe('fork-prismml-2');

    const list = (await (await s.req('GET', '/api/engines/custom')).json()) as CustomEngineInfo[];
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ kind: 'llamacpp-native', config: { kind: 'llamacpp-native', customEngineId: 'fork-prismml' } });
    expect(list[0]?.check).toMatchObject({ kind: 'llamacpp-native', flagCount: LLAMA_FORK_FLAGS.length, missing: [{ flag: '-ub', setting: 'ubatchSize', effect: 'default' }] });
    expect(list[0]?.check.status).toMatchObject({ available: true, version: 'b7001', customEngineId: 'fork-prismml' });
    // The check ran on the fork's own executable.
    expect(llama.seen.at(-1)).toMatchObject({ executable: '/prism/llama-server' });

    const edited = (await (await s.req('PUT', '/api/engines/custom/fork-prismml', { ...fork, name: 'PrismML' })).json()) as CustomEngine;
    expect(edited).toMatchObject({ id: 'fork-prismml', name: 'PrismML' });
    const copy = (await (await s.req('POST', '/api/engines/custom/fork-prismml/duplicate', { name: 'PrismML (copia)' })).json()) as CustomEngine;
    expect(copy).toMatchObject({ id: 'prismml-copia', name: 'PrismML (copia)', extraArgs: ['--ternary-kernels', 'on'] });
    const auto = (await (await s.req('POST', '/api/engines/custom/fork-prismml/duplicate', {})).json()) as CustomEngine;
    expect(auto.name).toBe('PrismML (2)');
    expect(await (await s.req('DELETE', '/api/engines/custom/fork-prismml-2')).json()).toEqual({ ok: true });
    expect(s.current().map((e) => e.id)).toEqual(['fork-prismml', 'prismml-copia', 'prismml-2']);
  });

  it('refuses unknown engines and invalid drafts', async () => {
    const s = setup([adapter('llamacpp-native')]);
    for (const [method, url, body] of [
      ['PUT', '/api/engines/custom/nope', fork],
      ['DELETE', '/api/engines/custom/nope', undefined],
      ['POST', '/api/engines/custom/nope/duplicate', {}],
    ] as const) {
      const res = await s.req(method, url, body);
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: { params: unknown } }).error.params).toEqual({ reason: 'custom_engine_missing', id: 'nope' });
    }
    const bad = await s.req('POST', '/api/engines/custom', { ...fork, run: { mode: 'command', template: 'srv --port {port}' } });
    expect(bad.status).toBe(400);
  });

  it('"Prova" checks a draft without saving it', async () => {
    const s = setup([adapter('llamacpp-native', { flags: LLAMA_FORK_FLAGS }), adapter('sglang-docker', { capsFail: true }), adapter('vllm-native', { available: false }), adapter('command')]);
    const check = (await (await s.req('POST', '/api/engines/custom/check', fork)).json()) as CustomEngineCheck;
    expect(check.missing.map((m) => m.flag)).toEqual(['-ub']);
    expect(s.current()).toEqual([]);
    const cmd = (await (await s.req('POST', '/api/engines/custom/check', { name: 'Server', base: 'openai-server', run: { mode: 'command', template: 'srv --port {port} --model {model}' } })).json()) as CustomEngineCheck;
    expect(cmd).toMatchObject({ kind: 'command', flagCount: 0, missing: [], placeholders: ['port', 'model'] });
    // A help that cannot be read: nothing known, nothing left out.
    const unreadable = (await (await s.req('POST', '/api/engines/custom/check', { name: 'S', base: 'sglang', run: { mode: 'docker', image: 'me/sglang:1' } })).json()) as CustomEngineCheck;
    expect(unreadable).toMatchObject({ kind: 'sglang-docker', flagCount: 0, missing: [] });
    // An engine that does not run: no options read.
    const broken = (await (await s.req('POST', '/api/engines/custom/check', { name: 'V', base: 'vllm', run: { mode: 'native', path: '/v' } })).json()) as CustomEngineCheck;
    expect(broken).toMatchObject({ kind: 'vllm-native', flagCount: 0, status: { available: false } });
  });

  it('checks through an unwrapped adapter too', async () => {
    const registry = new EngineRegistry([adapter('llamacpp-native', { flags: [] })]);
    const engine = { schema: 1, id: 'x', name: 'x', base: 'llamacpp', run: { mode: 'native', path: '/x' }, extraArgs: [], env: {}, notes: '' } as CustomEngine;
    expect(await checkCustomEngine(registry, engine)).toMatchObject({ flagCount: 0, missing: [] });
  });
});

describe('SGLang tags route', () => {
  it('lists the tags, or says it cannot', async () => {
    const llama = { releases: async () => [], planInstall: async () => ({}) as never, installBuild: async () => ({}) as never, listInstalled: async () => [], removeBuild: async () => {} };
    const app = new Hono();
    app.onError((e, c) => errorResponse(c, e));
    const asked: unknown[] = [];
    createEnginesRoutes({ registry: new EngineRegistry(), llama, publish: () => {}, sglang: { tags: async (o) => (asked.push(o), [{ name: 'v0.5.21' }]) } })(app, {} as CoreContext);
    expect(await (await app.request('/api/engines/sglang/tags?refresh=1')).json()).toEqual([{ name: 'v0.5.21' }]);
    expect(asked).toEqual([{ refresh: true }]);
    const none = new Hono();
    none.onError((e, c) => errorResponse(c, e));
    createEnginesRoutes({ registry: new EngineRegistry(), llama, publish: () => {} })(none, {} as CoreContext);
    expect((await none.request('/api/engines/sglang/tags')).status).toBe(400);
  });
});
