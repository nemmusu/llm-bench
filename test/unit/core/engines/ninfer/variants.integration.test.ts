/**
 * NInfer variants end to end, with the fake wsl.exe and real processes: the guided build of NInfer-all
 * from its repository (saved as its custom engine), its --help (its own KV types), a GGUF-NInfer artifact
 * that the official build cannot read and NInfer-all serves, a folder holding another repository, and the
 * variant's own "Aggiorna".
 */
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CustomEngine } from '../../../../../src/contract/custom-engines';
import { launchParamsSchema } from '../../../../../src/contract/engines';
import type { ServerEvent } from '../../../../../src/contract/events';
import type { LocalModel } from '../../../../../src/contract/models';
import type { NinferSettings } from '../../../../../src/contract/ninfer';
import type { CoreContext } from '../../../../../src/core/context';
import { withCustomEngines } from '../../../../../src/core/engines/custom/adapter';
import { checkCustomEngine } from '../../../../../src/core/engines/custom/routes';
import { createNinferRoutes } from '../../../../../src/core/engines/ninfer/routes';
import { createNinferServices, githubRepoBytes } from '../../../../../src/core/engines/ninfer/setup';
import { EngineRegistry } from '../../../../../src/core/engines/registry';
import { EngineUpdates } from '../../../../../src/core/engines/updates/service';
import type { ModelTarget } from '../../../../../src/core/engines/types';
import { systemClock } from '../../../../../src/core/node-deps';
import { pickFreePort } from '../../../../../src/core/process/ports';
import { errorResponse } from '../../../../../src/core/server/http-error';
import { recordingLog, tempDir } from '../../docker/helpers';
import { realClients, realProc, WSL_ARGV } from './helpers';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});

type InstallEvent = Extract<ServerEvent, { type: 'engine.install' }>;
const ALL = { url: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master' };

/** GitHub as the build asks it: the repository's size; anything else (the engine's readiness) as it is. */
const github: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('https://api.github.test/')) return url.endsWith('/repos/iamwavecut/ninfer-all') ? Response.json({ size: 39_367 }) : new Response('nope', { status: 404 });
  return globalThis.fetch(input, init);
};

function setup() {
  const t = tempDir('gb-ninfer-variants-');
  cleanups.push(t.cleanup);
  // No custom engine saved yet (an older settings file has no list at all).
  let saved: { ninfer?: NinferSettings; customEngines?: CustomEngine[] } = { ninfer: { wsl: { distro: 'Ubuntu-24.04', path: '/home/user/ninfer' } } };
  const services = createNinferServices({
    deps: {
      clock: systemClock,
      proc: realProc(path.join(t.dir, 'wsl'), { FAKE_WSL_CONFIG: JSON.stringify({ stepMs: 5 }) }),
      fetch: github,
      platform: 'win32',
      log: recordingLog(),
      paths: { dataDir: t.dir } as never,
      endpoints: { wsl: WSL_ARGV, githubApi: 'https://api.github.test/' } as never,
    },
    createClient: realClients,
    settings: {
      get: async () => saved,
      update: async (patch) => {
        saved = { ...saved, ...patch };
      },
    },
    gpus: async () => [{ name: 'NVIDIA GeForce RTX 5090' }],
    models: async () => [],
  });
  const events: InstallEvent[] = [];
  const app = new Hono();
  app.onError((e, c) => errorResponse(c, e));
  createNinferRoutes(services.routes({ publish: (e) => events.push(e as InstallEvent) }))(app, {} as CoreContext);
  const post = (route: string, body: unknown) => app.request(route, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const done = async (n: number) => {
    for (let i = 0; i < 400 && events.filter((e) => e.stage === 'done' || e.stage === 'error').length < n; i++) await new Promise((r) => setTimeout(r, 25));
    return events.filter((e) => e.stage === 'done' || e.stage === 'error')[n - 1] as InstallEvent;
  };
  const registry = new EngineRegistry(withCustomEngines([services.native, services.wsl], { list: async () => saved.customEngines ?? [] }));
  return { t, post, events, done, services, registry, saved: () => saved };
}

/** A GGUF-NInfer artifact without a manifest, as the user's: "…-GGUF-NInfer/GGUF-NInfer/…-Q6_K-MTP.ninfer". */
function ggufNinfer(dir: string): ModelTarget & { local: LocalModel } {
  const folder = path.join(dir, 'Qwen3.8-27B-Coder390-GGUF-NInfer', 'GGUF-NInfer');
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP.ninfer');
  writeFileSync(file, Buffer.alloc(4096));
  const identity: LocalModel['identity'] = {
    displayName: 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP',
    format: 'ninfer',
    source: 'hf',
    repo: 'nerkyor/Qwen3.8-27B-Coder390-GGUF-NInfer',
    file: 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP.ninfer',
    files: ['Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP.ninfer'],
    sizeBytes: 4096,
    weakKey: 'nerkyor/gguf-ninfer',
    facts: { noManifest: true, components: ['text', 'mtp'] },
  };
  return { identity, local: { id: 'g1', identity, paths: [file], auxiliary: [], dir: folder, origin: 'library', modifiedAt: '2026-10-13T00:00:00.000Z' } };
}

describe('NInfer-all, a variant of NInfer', () => {
  it('is downloaded from its repository and built, then saved as its custom engine; its help lists its own KV types', async () => {
    const r = setup();
    const req = { kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/ninfer-all', source: ALL, variant: { template: 'ninfer-all', name: 'NInfer-all' } };
    const plan = await (await r.post('/api/engines/ninfer/build-plan', req)).json();
    expect(plan).toMatchObject({
      dir: '/home/user/ninfer-all',
      existing: false,
      source: ALL,
      downloadBytes: 39_367 * 1024,
      cpus: 16,
      minutes: 29,
      ready: true,
      commands: [
        'git clone --progress --branch master https://github.com/iamwavecut/ninfer-all.git /home/user/ninfer-all',
        'cmake -S /home/user/ninfer-all -B /home/user/ninfer-all/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=120a -DCMAKE_CUDA_COMPILER=/usr/local/cuda-13.1/bin/nvcc',
        'cmake --build /home/user/ninfer-all/build -j',
        'git -C /home/user/ninfer-all rev-parse HEAD > /home/user/ninfer-all/build/.llmbench-built-commit',
      ],
      // NInfer-all's own minimum for the RTX 5090.
      cuda: { need: '13.1', have: '13.1', allNeeds: true },
    });
    expect((await r.post('/api/engines/ninfer/build', { ...req, confirm: true })).status).toBe(200);
    const end = await r.done(1);
    expect(end).toMatchObject({ kind: 'ninfer-variant', label: 'NInfer-all', stage: 'done', result: { ninferPath: '/home/user/ninfer-all/build/apps/ninfer-serve', distro: 'Ubuntu-24.04', customEngineId: 'ninfer-all' } });
    expect(r.events.every((e) => e.kind === 'ninfer-variant' && e.label === 'NInfer-all')).toBe(true);
    const engine = r.saved().customEngines?.[0] as CustomEngine;
    expect(engine).toMatchObject({
      id: 'ninfer-all',
      name: 'NInfer-all',
      base: 'ninfer',
      template: 'ninfer-all',
      run: { mode: 'ninfer', path: '/home/user/ninfer-all/build/apps/ninfer-serve', distro: 'Ubuntu-24.04', source: ALL },
      match: { names: ['GGUF-NInfer'], layouts: ['gguf_blocks_v1'] },
    });
    // The official build is left as it was.
    expect(r.saved().ninfer).toEqual({ wsl: { distro: 'Ubuntu-24.04', path: '/home/user/ninfer' } });

    // "Prova": it answers like NInfer, and its --help lists rk8v4 and the others.
    const check = await checkCustomEngine(r.registry, engine);
    expect(check.status).toMatchObject({ available: true, kind: 'ninfer-wsl', customEngineId: 'ninfer-all' });
    expect(check.kvDtypes).toEqual(['bf16', 'int8', 'fp8', 'rk8v4', 'rk4v4', 'rk4v4-e8', 'rk2v4-e8', 'nvfp4', 'k8v4']);
    expect(check.missing).toEqual([]);

    // Built again in place (its checkout is there, cloned from NInfer-all): the same engine, updated.
    const again = { ...req, variant: { id: 'ninfer-all', name: 'NInfer-all' } };
    expect(await (await r.post('/api/engines/ninfer/build-plan', again)).json()).toMatchObject({
      existing: true,
      ready: true,
      commands: [expect.stringContaining('cmake -S'), 'cmake --build /home/user/ninfer-all/build -j', expect.stringContaining('.llmbench-built-commit')],
    });
    await r.post('/api/engines/ninfer/build', { ...again, confirm: true });
    expect((await r.done(2)).result).toMatchObject({ customEngineId: 'ninfer-all' });
    expect(r.saved().customEngines).toHaveLength(1);
  }, 120_000);

  it('a GGUF-NInfer artifact: the official build stops with the format it does not know, NInfer-all serves it with its own KV type', async () => {
    const r = setup();
    await r.post('/api/engines/ninfer/build', { kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/ninfer-all', source: ALL, variant: { template: 'ninfer-all', name: 'NInfer-all' }, confirm: true });
    await r.done(1);
    const model = ggufNinfer(r.t.dir);
    const adapter = r.registry.require('ninfer-wsl');
    const params = launchParamsSchema.parse({ contextSize: 4096, parallel: 1, ninfer: { kvCapacity: 8192, kvDtype: 'int8', spec: 'mtp', prefixReuse: false, thinking: false } });

    // The official NInfer: the start fails at once, saying which format and which variant reads it.
    const official = await adapter.plan({ kind: 'ninfer-wsl' }, model, params, { port: await pickFreePort(), marker: 'gpubench-variant-1' });
    const inst = await adapter.start(official, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_MODEL_UNSUPPORTED', params: { engine: 'NInfer', reason: 'layout', value: 'gguf_blocks_v1', build: 'e31bc99b13f5', template: 'ninfer-all', variant: 'NInfer-all' } });
    await inst.stop();
    // Its own KV types only: a variant's rk8v4 is refused before anything starts.
    const rk = launchParamsSchema.parse({ ...params, ninfer: { ...params.ninfer, kvDtype: 'rk8v4' } });
    await expect(adapter.plan({ kind: 'ninfer-wsl' }, model, rk, { port: 1, marker: 'gpubench-variant-2' })).rejects.toMatchObject({
      code: 'ENGINE_BAD_FLAG',
      params: { flag: '--kv-dtype', value: 'rk8v4', values: 'bf16, int8, fp8, nvfp4, k8v4', reason: 'kv_dtype_unsupported' },
    });

    // NInfer-all: its KV types are its build's, its name is the engine's; the same artifact loads and answers.
    const cfg = { kind: 'ninfer-wsl' as const, customEngineId: 'ninfer-all' };
    expect((await adapter.capabilities(cfg)).choices?.['--kv-dtype']).toContain('rk8v4');
    const plan = await adapter.plan(cfg, model, rk, { port: await pickFreePort(), marker: 'gpubench-variant-3' });
    expect(plan.engine).toMatchObject({ name: 'NInfer-all', customEngine: { id: 'ninfer-all', base: 'ninfer' }, variant: 'Ubuntu-24.04' });
    expect(plan.argv).toEqual(expect.arrayContaining(['/home/user/ninfer-all/build/apps/ninfer-serve', '--kv-dtype', 'rk8v4']));
    const all = await adapter.start(plan, new AbortController().signal);
    try {
      await all.waitReady();
      const res = await fetch(`http://127.0.0.1:${plan.port}/v1/models`);
      expect(res.status).toBe(200);
    } finally {
      await all.stop();
    }
  }, 120_000);

  it('never builds a checkout of another repository; a variant without a repository only in its own checkout', async () => {
    const r = setup();
    // ~/ninfer holds the official NInfer.
    const other = { kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/ninfer', source: ALL, variant: { template: 'ninfer-all', name: 'NInfer-all' } };
    expect(await (await r.post('/api/engines/ninfer/build-plan', other)).json()).toMatchObject({ existing: true, otherRepo: 'https://github.com/Neroued/ninfer.git', ready: false });
    await r.post('/api/engines/ninfer/build', { ...other, confirm: true });
    expect((await r.done(1)).error).toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'ninfer_other_repo', origin: 'https://github.com/Neroued/ninfer.git' } });
    // No repository named: its own checkout is built as it is (the official one here); nowhere else.
    expect(await (await r.post('/api/engines/ninfer/build-plan', { kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/ninfer', variant: { name: 'Mine' } })).json()).toMatchObject({ existing: true, ready: true });
    const nowhere = await r.post('/api/engines/ninfer/build-plan', { kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/new', variant: { name: 'Mine' } });
    expect(nowhere.status).toBe(400);
    expect(await nowhere.json()).toMatchObject({ error: { code: 'VALIDATION', params: { reason: 'ninfer_no_source' } } });
  }, 120_000);

  it('its "Aggiorna" is NInfer\'s, in its own checkout, under its own target', async () => {
    const r = setup();
    await r.post('/api/engines/ninfer/build', { kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '~/ninfer-all', source: ALL, variant: { template: 'ninfer-all', name: 'NInfer-all' }, confirm: true });
    await r.done(1);
    const settings = { get: async () => ({ customEngines: r.saved().customEngines ?? [] }) };
    const updates = new EngineUpdates({ settings, clock: systemClock, ninferVariant: (e: CustomEngine) => r.services.variantUpdater(e) } as unknown as ConstructorParameters<typeof EngineUpdates>[0]);
    expect(await updates.check('custom:ninfer-all')).toMatchObject({ target: 'custom:ninfer-all', method: 'git', state: 'current', repo: '/home/user/ninfer-all', distro: 'Ubuntu-24.04' });
    // Without NInfer's updaters in the composition: updated with its own tools.
    expect(await new EngineUpdates({ settings, clock: systemClock } as unknown as ConstructorParameters<typeof EngineUpdates>[0]).check('custom:ninfer-all')).toMatchObject({ method: 'none', reason: 'tools' });
    // A variant built on Linux (no distro): it is looked for on this system, and checked as a native NInfer.
    const native = r.services.variantUpdater({ ...(r.saved().customEngines?.[0] as CustomEngine), run: { mode: 'ninfer', path: '/opt/ninfer-all' } });
    const o = (native as unknown as { o: { where(): Promise<unknown>; verify(): Promise<boolean> } }).o;
    expect(await o.where()).toEqual({ serve: '/opt/ninfer-all/build/apps/ninfer-serve', repo: '/opt/ninfer-all' });
    expect(await o.verify()).toBe(false);
  }, 120_000);
});

describe('what cloning downloads', () => {
  it('GitHub\'s size of the repository, else nothing', async () => {
    expect(await githubRepoBytes(github, 'https://api.github.test/', 'iamwavecut/ninfer-all')).toBe(39_367 * 1024);
    expect(await githubRepoBytes(github, 'https://api.github.test', 'nobody/nothing')).toBeUndefined();
    expect(await githubRepoBytes(async () => Response.json({ size: 'big' }), 'https://x', 'a/b')).toBeUndefined();
    expect(await githubRepoBytes(async () => Promise.reject(new Error('offline')), 'https://x', 'a/b')).toBeUndefined();
  });
});
