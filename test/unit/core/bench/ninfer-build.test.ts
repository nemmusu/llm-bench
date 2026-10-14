/**
 * The build of NInfer a model needs, chosen by the core for every launch (BenchService.prepare /
 * prepareServer: Benchmark, "Trova le impostazioni migliori", servers, presets, "Usa queste
 * impostazioni"): a .ninfer artifact whose manifest lists GGUF blocks runs on NInfer-all whatever NInfer
 * build the request named; not built yet, the plan says so and a start stops with a clear reason.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { customEngineSchema, type CustomEngine } from '../../../../src/contract/custom-engines';
import type { EngineConfig } from '../../../../src/contract/engines';
import type { ModelIdentity } from '../../../../src/contract/models';
import { BenchService } from '../../../../src/core/bench/service';
import { chooseNinferBuild } from '../../../../src/core/engines/ninfer/choose';
import type { EngineAdapter } from '../../../../src/core/engines/types';
import { makeRun, modelIdentity } from '../store/fixtures';
import { request, serviceSetup, TempDirs } from './service-helpers';

const tmp = new TempDirs();
afterEach(() => tmp.cleanup());

const ALL_SOURCE = { url: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master' };
const ninferAll = customEngineSchema.parse({
  id: 'ninfer-all',
  name: 'NInfer-all',
  base: 'ninfer',
  template: 'ninfer-all',
  run: { mode: 'ninfer', path: '/home/u/ninfer-all', distro: 'Ubuntu-24.04', source: ALL_SOURCE },
});
const fusion = customEngineSchema.parse({ id: 'fusion', name: 'Fusion', base: 'ninfer', run: { mode: 'ninfer', path: '/home/u/fusion', distro: 'Ubuntu-24.04' } });

/** The user's model: its manifest (at the start of the file) lists GGUF blocks. */
const gguf = (over: Partial<ModelIdentity> = {}): ModelIdentity =>
  modelIdentity({
    displayName: 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP',
    format: 'ninfer',
    repo: 'nerkyor/Qwen3.8-27B-Coder390-GGUF-NInfer',
    file: 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP.ninfer',
    quant: 'Q6_K',
    weakKey: 'nerkyor/gguf-ninfer',
    facts: { layouts: ['contiguous_le_v1', 'gguf_blocks_v1', 'row_split_k128_v1'], contextLength: 262_144 },
    ...over,
  });

function setup(o: { identity?: ModelIdentity; engines?: CustomEngine[]; installed?: boolean; recipes?: false } = {}) {
  const s = serviceSetup(tmp, {
    adapter: { kind: 'ninfer-wsl' },
    deps: {
      resolveModel: async () => ({ identity: o.identity ?? gguf() }),
      ...(o.recipes === false ? {} : { recipes: async () => ({ recipes: [], customEngines: o.engines ?? [] }) }),
    },
  });
  const inner = s.adapter;
  const planned: EngineConfig[] = [];
  const detected: EngineConfig[] = [];
  const adapter = {
    kind: 'ninfer-wsl',
    detect: async (cfg?: EngineConfig) => {
      if (cfg) detected.push(cfg);
      return { kind: 'ninfer-wsl' as const, available: o.installed !== false, installed: o.installed !== false, problems: [], supported: true };
    },
    capabilities: () => inner.capabilities(),
    plan: (cfg: EngineConfig, ...rest: Parameters<EngineAdapter['plan']> extends [unknown, ...infer R] ? R : never) => {
      planned.push(cfg);
      return inner.plan(cfg, ...rest);
    },
    start: () => inner.start(),
  } as unknown as EngineAdapter;
  s.deps.getAdapter = () => adapter;
  return { s, service: new BenchService(s.deps), planned, detected };
}

const official = (over: Record<string, unknown> = {}) => request({ engine: { kind: 'ninfer-wsl' }, ...over });

describe('which NInfer build runs a model', () => {
  it('a GGUF-NInfer model on NInfer: NInfer-all runs it, the plan and the run say so', async () => {
    const { s, service, planned } = setup({ engines: [ninferAll] });
    const plan = await service.plan(official());
    expect(plan.ninferBuild).toEqual({ build: 'all', why: 'layout', layout: 'gguf_blocks_v1', ready: true, customEngineId: 'ninfer-all' });
    expect(plan.pending).toBeUndefined();
    expect(plan.warnings).toContainEqual({ code: 'ninfer_all_chosen', params: { layout: 'gguf_blocks_v1', why: 'layout' } });
    expect(planned.at(-1)).toEqual({ kind: 'ninfer-wsl', customEngineId: 'ninfer-all' });
    const { runId } = await service.start(official());
    await service.whenIdle();
    const run = await s.runs.get(runId);
    // The launch record names the engine it really ran ("Usa questo preset" brings NInfer-all back).
    expect(run?.notes.map((n) => n.code)).toContain('ninfer_all_chosen');
    expect(planned.at(-1)).toEqual({ kind: 'ninfer-wsl', customEngineId: 'ninfer-all' });
  });

  it('NInfer-all not built: the plan says so (its program still to come), a start stops with the reason', async () => {
    const { service, planned } = setup();
    const plan = await service.plan(official());
    expect(plan.ninferBuild).toEqual({ build: 'all', why: 'layout', layout: 'gguf_blocks_v1', ready: false });
    expect(plan.pending).toEqual(['engine']);
    expect(planned.at(-1)).toEqual({ kind: 'ninfer-wsl', ninferPath: '~/ninfer-all/build/apps/ninfer-serve' });
    await expect(service.start(official())).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { reason: 'ninfer_all_missing', engine: 'NInfer-all', layout: 'gguf_blocks_v1' } });
    // A server too.
    expect((await service.planServer(official())).ninferBuild).toMatchObject({ ready: false });
    await expect(service.prepareServer(official(), { preview: false, marker: 'gpubench-x' })).rejects.toMatchObject({ params: { reason: 'ninfer_all_missing' } });
    // Without the settings' custom engines at all: the same.
    expect((await setup({ recipes: false }).service.plan(official())).ninferBuild).toMatchObject({ ready: false });
  });

  it('not saved but built by hand in ~/ninfer-all: found there and used; a look that fails or finds nothing changes nothing', async () => {
    const found = setup();
    const asked: string[] = [];
    found.s.deps.findNinferAll = async (kind) => {
      asked.push(kind);
      return ninferAll;
    };
    const plan = await new BenchService(found.s.deps).plan(official());
    expect(asked).toEqual(['ninfer-wsl']);
    expect(plan.ninferBuild).toEqual({ build: 'all', why: 'layout', layout: 'gguf_blocks_v1', ready: true, customEngineId: 'ninfer-all' });
    expect(found.planned.at(-1)).toEqual({ kind: 'ninfer-wsl', customEngineId: 'ninfer-all' });
    const none = setup();
    none.s.deps.findNinferAll = async () => undefined;
    expect((await new BenchService(none.s.deps).plan(official())).ninferBuild).toMatchObject({ ready: false });
    const failing = setup();
    failing.s.deps.findNinferAll = () => Promise.reject(new Error('wsl.exe did not answer'));
    expect((await new BenchService(failing.s.deps).plan(official())).ninferBuild).toMatchObject({ ready: false });
  });

  it('saved but not answering (a build that broke): not ready, previewed with its own path', async () => {
    const { s, service, planned, detected } = setup({ engines: [ninferAll], installed: false });
    const plan = await service.plan(official());
    expect(plan.ninferBuild).toMatchObject({ ready: false, customEngineId: 'ninfer-all' });
    // A check that fails outright: not ready either.
    const failing = s.deps.getAdapter('ninfer-wsl');
    s.deps.getAdapter = () => ({ ...failing, detect: () => Promise.reject(new Error('wsl.exe gone')) }) as never;
    expect((await new BenchService(s.deps).plan(official())).ninferBuild).toMatchObject({ ready: false });
    s.deps.getAdapter = () => failing;
    expect(detected).toContainEqual({ kind: 'ninfer-wsl', customEngineId: 'ninfer-all' });
    expect(planned.at(-1)).toEqual({ kind: 'ninfer-wsl', customEngineId: 'ninfer-all' });
  });

  it('NInfer-all named on purpose: the same, without a note; another variant on purpose: left alone', async () => {
    const named = setup({ engines: [ninferAll] });
    const plan = await named.service.plan(official({ engine: { kind: 'ninfer-wsl', customEngineId: 'ninfer-all' } }));
    expect(plan.ninferBuild).toMatchObject({ ready: true });
    expect(plan.warnings.map((w) => w.code)).not.toContain('ninfer_all_chosen');
    const other = setup({ engines: [ninferAll, fusion] });
    expect((await other.service.plan(official({ engine: { kind: 'ninfer-wsl', customEngineId: 'fusion' } }))).ninferBuild).toBeUndefined();
    expect(other.planned.at(-1)).toEqual({ kind: 'ninfer-wsl', customEngineId: 'fusion' });
  });

  it('an official artifact stays on NInfer; a name says GGUF-NInfer only when the manifest could not be read; else an earlier run', async () => {
    const plain = setup({ identity: gguf({ facts: { layouts: ['contiguous_le_v1'] } }), engines: [ninferAll] });
    expect((await plain.service.plan(official())).ninferBuild).toBeUndefined();
    expect(plain.planned.at(-1)).toEqual({ kind: 'ninfer-wsl' });
    const byName = setup({ identity: gguf({ facts: {} }), engines: [ninferAll] });
    expect((await byName.service.plan(official())).ninferBuild).toMatchObject({ why: 'name' });
    // Renamed, no manifest to read: what an earlier run here could not read.
    const renamed = gguf({ facts: {}, repo: undefined, displayName: 'mine', file: 'mine.ninfer', weakKey: 'local/mine' });
    const history = setup({ identity: renamed, engines: [ninferAll] });
    expect((await history.service.plan(official())).ninferBuild).toBeUndefined();
    // A run that read it fine says nothing.
    await history.s.runs.save(makeRun({ id: 'OK-RUN', model: renamed }));
    expect((await history.service.plan(official())).ninferBuild).toBeUndefined();
    await history.s.runs.save(makeRun({ status: 'failed', model: renamed, error: { code: 'ENGINE_MODEL_UNSUPPORTED', message: 'x', params: { engine: 'NInfer', reason: 'layout', value: 'gguf_blocks_v1' } } }));
    expect((await history.service.plan(official())).ninferBuild).toMatchObject({ why: 'history', layout: 'gguf_blocks_v1' });
    // Earlier runs that cannot be read: nothing to go on.
    history.s.deps.runs.tried = () => Promise.reject(new Error('disk'));
    expect((await new BenchService(history.s.deps).plan(official())).ninferBuild).toBeUndefined();
  });

  it('only NInfer launches of .ninfer models are looked at', async () => {
    const { service, planned } = setup({ identity: gguf({ format: 'gguf' }), engines: [ninferAll] });
    expect((await service.plan(official())).ninferBuild).toBeUndefined();
    expect(planned.at(-1)).toEqual({ kind: 'ninfer-wsl' });
    expect(chooseNinferBuild({ kind: 'llamacpp-native' }, gguf(), [ninferAll])).toEqual({ engine: { kind: 'llamacpp-native' } });
    // A NInfer program named by its path: the user's own choice.
    expect(chooseNinferBuild({ kind: 'ninfer-wsl', ninferPath: '/opt/x' }, gguf(), [ninferAll])).toEqual({ engine: { kind: 'ninfer-wsl', ninferPath: '/opt/x' } });
    // A custom engine that is gone: left for the engine to say.
    expect(chooseNinferBuild({ kind: 'ninfer-wsl', customEngineId: 'gone' }, gguf(), [ninferAll])).toEqual({ engine: { kind: 'ninfer-wsl', customEngineId: 'gone' } });
  });
});
