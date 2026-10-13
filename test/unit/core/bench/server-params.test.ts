/** "Avvia solo il server": the recommended settings for this card, and the server preview. */
import { afterEach, describe, expect, it } from 'vitest';
import { serverApiName } from '../../../../src/core/engines/types';
import type { StartServerRequest } from '../../../../src/contract/api';
import type { LaunchParams } from '../../../../src/contract/engines';
import type { FitEstimate, FitLevel } from '../../../../src/contract/models';
import type { GpuSample } from '../../../../src/contract/hardware';
import { BenchService, SERVER_CONTEXTS, serverContextOf, type BenchServiceDeps } from '../../../../src/core/bench/service';
import type { ModelTarget } from '../../../../src/core/engines/types';
import { modelIdentity } from '../store/fixtures';
import { modelTarget } from './fakes';
import { serviceSetup, TempDirs } from './service-helpers';

const tmp = new TempDirs();
afterEach(() => tmp.cleanup());

const fit = (level: FitLevel, over: Partial<FitEstimate> = {}): FitEstimate => ({
  level,
  needMiB: 4200,
  weightsMiB: 3000,
  kvMiB: 700,
  overheadMiB: 500,
  availableMiB: 30000,
  utilization: 0.14,
  contextSize: 8192,
  basis: 'file-size',
  notes: [],
  ...over,
});

const llama = (params?: Partial<LaunchParams>): StartServerRequest => ({
  engine: { kind: 'llamacpp-native' },
  model: { localId: 'm1' },
  ...(params ? { params: { extraArgs: [], env: {}, ...params } } : {}),
});
const vllm = (params?: Partial<LaunchParams>): StartServerRequest => ({
  engine: { kind: 'vllm-docker' },
  model: { repo: 'Qwen/Qwen3-0.6B' },
  ...(params ? { params: { extraArgs: [], env: {}, ...params } } : {}),
});

/** The context a fit call asked about (llama.cpp ctx-size or vLLM max-model-len). */
const asked = (p: Pick<LaunchParams, 'contextSize' | 'maxModelLen'>) => p.maxModelLen ?? p.contextSize;

/** A service whose fit answers by context size; records every context it was asked about. */
function withFit(levels: (ctx: number) => FitLevel | undefined, o: { model?: ModelTarget; deps?: Partial<BenchServiceDeps>; kind?: 'vllm-docker' } = {}) {
  const contexts: number[] = [];
  const params: LaunchParams[] = [];
  const s = serviceSetup(tmp, {
    ...(o.kind ? { adapter: { kind: o.kind, parallel: null } } : { adapter: { parallel: null } }),
    deps: {
      resolveModel: async () => o.model ?? modelTarget(),
      fit: async (_req, _model, plan) => {
        const ctx = asked(plan.params) as number;
        contexts.push(ctx);
        params.push(plan.params);
        const level = levels(ctx);
        return level ? fit(level, { contextSize: ctx, maxGpuLayers: 20 }) : undefined;
      },
      ...o.deps,
    },
  });
  return { s, svc: new BenchService(s.deps), contexts, params };
}

const withContext = (contextLength: number) => modelTarget({ identity: modelIdentity({ facts: { contextLength } }) });

describe('recommended server context', () => {
  it('the largest context that fits the card well (perfect or good)', async () => {
    const { svc, contexts, s } = withFit(() => 'perfect');
    const plan = await svc.planServer(llama());
    expect(plan.contextSize).toBe(32768);
    expect(plan.params.contextSize).toBe(32768);
    // Parallel stays the engine default (one request at a time).
    expect(plan.params.parallel).toBeUndefined();
    // One try, then the preview's own fit with the chosen settings.
    expect(contexts).toEqual([32768, 32768]);
    expect(plan.fit?.level).toBe('perfect');
    // The engine is asked to show other programs the model's own name.
    expect(s.adapter.plans.at(-1)?.apiName).toBe(serverApiName('llamacpp-native', modelTarget()));

    const good = withFit((ctx) => (ctx > 8192 ? 'no' : ctx > 4096 ? 'good' : 'perfect'));
    expect((await good.svc.planServer(llama())).contextSize).toBe(8192);
    expect(good.contexts.slice(0, 3)).toEqual([32768, 16384, 8192]);
  });

  it('otherwise the largest that is tight, otherwise the smallest (the fit then reports the partial offload)', async () => {
    const tight = withFit((ctx) => (ctx === 32768 ? 'partial' : 'tight'));
    expect((await tight.svc.planServer(llama())).contextSize).toBe(16384);
    // Every candidate is tried looking for a better fit, the tight ones too.
    expect(tight.contexts.slice(0, 4)).toEqual([...SERVER_CONTEXTS]);

    const none = withFit(() => 'partial');
    const plan = await none.svc.planServer(llama());
    expect(plan.contextSize).toBe(4096);
    // Every layer on the GPU (Windows): the rest would go to shared system memory.
    expect(plan.warnings.map((w) => w.code)).toEqual(['spill_risk']);
    // Fewer layers chosen on purpose: a partial offload.
    const offloaded = await none.svc.planServer(llama({ gpuLayers: 20 }));
    expect(offloaded.warnings).toContainEqual({ code: 'partial_offload', params: { maxGpuLayers: 20 } });

    const tooBig = withFit(() => 'no');
    const big = await tooBig.svc.planServer(llama());
    expect(big.contextSize).toBe(4096);
    // Windows still loads it, in shared system memory.
    expect(big.warnings.map((w) => w.code)).toContain('spill_risk');
  });

  it('a busy card: the context follows what a launch gets right now, the verdict stays on the card', async () => {
    // Fits the card perfectly at any size, but with other programs open only 8K fits right now.
    const s = serviceSetup(tmp, {
      adapter: { parallel: null },
      deps: {
        resolveModel: async () => modelTarget(),
        fit: async (_req, _model, plan) => {
          const ctx = asked(plan.params) as number;
          return fit('perfect', { contextSize: ctx, levelNow: ctx > 8192 ? 'partial' : 'good', freeNowMiB: 9000, needMiB: 9500 });
        },
      },
    });
    const plan = await new BenchService(s.deps).planServer(llama());
    expect(plan.contextSize).toBe(8192);
    expect(plan.fit?.level).toBe('perfect');
  });

  it('never more than the model was trained for', async () => {
    const short = withFit(() => 'perfect', { model: withContext(8192) });
    expect((await short.svc.planServer(llama())).contextSize).toBe(8192);
    expect(short.contexts[0]).toBe(8192);

    // 8192 and 4096 are both tried (32768 and 16384 capped to 8192 count once).
    const capped = withFit((ctx) => (ctx > 4096 ? 'partial' : 'good'), { model: withContext(8192) });
    expect((await capped.svc.planServer(llama())).contextSize).toBe(4096);
    expect(capped.contexts.slice(0, 2)).toEqual([8192, 4096]);

    // A model trained on less than 4096 tokens gets all of it.
    const tiny = withFit(() => 'tight', { model: withContext(2048) });
    expect((await tiny.svc.planServer(llama())).contextSize).toBe(2048);
  });

  it('without a fit estimate: 8192, capped at the model context', async () => {
    const s = serviceSetup(tmp);
    expect((await new BenchService(s.deps).planServer(llama())).contextSize).toBe(8192);
    const unknown = withFit(() => undefined);
    expect((await unknown.svc.planServer(llama())).contextSize).toBe(8192);
    const broken = withFit(() => 'perfect', { deps: { fit: () => Promise.reject(new Error('header unreadable')) } });
    const fallback = await broken.svc.planServer(llama());
    expect(fallback.contextSize).toBe(8192);
    expect(fallback).not.toHaveProperty('fit');
    const small = withFit(() => undefined, { model: withContext(4096) });
    expect((await small.svc.planServer(llama())).contextSize).toBe(4096);
  });

  it('a context chosen by the user is kept as is', async () => {
    const { svc, contexts } = withFit(() => 'no');
    const plan = await svc.planServer(llama({ contextSize: 65536, flashAttention: 'on' }));
    expect(plan.contextSize).toBe(65536);
    expect(plan.params).toMatchObject({ contextSize: 65536, flashAttention: 'on' });
    // Only the preview's fit, with the user's own context.
    expect(contexts).toEqual([65536]);
  });

  it('vLLM: the same choice for max-model-len, with the memory share lowered to the free VRAM', async () => {
    const { s, svc, params } = withFit((ctx) => (ctx > 16384 ? 'no' : 'good'), { kind: 'vllm-docker' });
    const sample: GpuSample = { t: 0, gpu: 0, utilPct: 1, memUsedMiB: 12064, memTotalMiB: 32607, powerW: 40, tempC: 40, smClockMHz: 200, memClockMHz: 400, pcieGen: 4, pcieWidth: 16, throttle: [] };
    s.telemetry.snapshot = async () => [sample];
    const plan = await svc.planServer(vllm());
    expect(plan.contextSize).toBe(16384);
    expect(plan.params).toMatchObject({ maxModelLen: 16384, gpuMemoryUtilization: 0.6 });
    expect(plan.params.contextSize).toBeUndefined();
    // The fit was asked with the lowered memory share.
    expect(params[0]).toMatchObject({ maxModelLen: 32768, gpuMemoryUtilization: 0.6 });
    expect(plan.warnings[0]).toEqual({ code: 'gpu_memory_reduced', params: { utilization: 0.6, freeMiB: 20543, totalMiB: 32607 } });
  });

  it('vLLM: a repo not downloaded yet has no fit (fallback); a length chosen by the user is kept', async () => {
    const s = serviceSetup(tmp, { adapter: { kind: 'vllm-docker' }, deps: { fit: async () => undefined } });
    const svc = new BenchService(s.deps);
    const plan = await svc.planServer(vllm());
    expect(plan.contextSize).toBe(8192);
    expect(plan.params.maxModelLen).toBe(8192);
    expect((await svc.planServer(vllm({ maxModelLen: 2048 }))).contextSize).toBe(2048);
    // ctx-size works for vLLM too (it becomes --max-model-len): nothing is added.
    const ctx = await svc.planServer(vllm({ contextSize: 12288 }));
    expect(ctx.contextSize).toBe(12288);
    expect(ctx.params.maxModelLen).toBeUndefined();
  });

  it('serverContextOf reads the engine’s own setting', () => {
    expect(serverContextOf('llamacpp-docker', { extraArgs: [], env: {}, maxModelLen: 4096 })).toBeUndefined();
    expect(serverContextOf('vllm-native', { extraArgs: [], env: {}, maxModelLen: 4096, contextSize: 8192 })).toBe(4096);
  });
});

describe('BenchService.prepareServer / planServer', () => {
  it('starts never as a preview, with the given marker, the Docker model volume and the chosen params', async () => {
    const previews: (boolean | undefined)[] = [];
    const s = serviceSetup(tmp, {
      deps: {
        resolveModel: async (_req, o) => {
          previews.push(o?.preview);
          return modelTarget();
        },
        adjustEngine: async (req) => ({ ...req.engine, modelVolume: 'gpubench-model-m1' }),
        fit: async () => fit('good'),
      },
    });
    const svc = new BenchService(s.deps);
    const p = await svc.prepareServer({ engine: { kind: 'llamacpp-docker' }, model: { localId: 'm1' } }, { preview: false, marker: 'gpubench-srv' });
    expect(previews).toEqual([false]);
    expect(p.marker).toBe('gpubench-srv');
    expect(p.launch.argv).toContain('gpubench-srv');
    expect(p.engine).toEqual({ kind: 'llamacpp-docker', modelVolume: 'gpubench-model-m1' });
    expect(p.contextSize).toBe(32768);
    expect(s.adapter.plans[0]).toMatchObject({ preview: false, marker: 'gpubench-srv', params: { contextSize: 32768 } });
    expect(p.warnings).toEqual([]);
  });

  it('the chosen port, else a free one; the plan says which and how it is reached', async () => {
    const s = serviceSetup(tmp, { deps: { fit: async () => fit('good') } });
    const svc = new BenchService(s.deps);
    const chosen = await svc.planServer({ ...llama(), port: 8085 });
    expect(chosen).toMatchObject({ port: 8085, network: 'local' });
    expect(s.adapter.plans.at(-1)?.port).toBe(8085);
    expect((await svc.planServer(llama())).port).toBe(40000);
  });

  it('shared on the local network: every card and the API key (redacted in the preview, real at start)', async () => {
    const s = serviceSetup(tmp, { adapter: { hostArg: true }, deps: { fit: async () => fit('good'), redact: (argv, env) => ({ argv, env }), serverApiKey: () => 'gpub-real-key' } });
    const svc = new BenchService(s.deps);
    const plan = await svc.planServer({ ...llama(), port: 8086, network: 'lan' });
    expect(plan.network).toBe('lan');
    expect(plan.command.argv).toEqual(expect.arrayContaining(['--host', '0.0.0.0', '--api-key', '<API_KEY>']));
    expect(plan.command.argv).not.toContain('gpub-real-key');
    const started = await svc.prepareServer({ ...llama(), port: 8086, network: 'lan' }, { preview: false, marker: 'gpubench-lan' });
    expect(started.launch.argv.slice(-2)).toEqual(['--api-key', 'gpub-real-key']);
    expect(started.launch.apiKey).toBe('gpub-real-key');
    // No key available (never in the app: the core makes one): refused.
    const keyless = new BenchService(serviceSetup(tmp, { adapter: { hostArg: true }, deps: { fit: async () => fit('good') } }).deps);
    await expect(keyless.prepareServer({ ...llama(), network: 'lan' }, { preview: false, marker: 'gpubench-x' })).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'api_key_missing' } });
  });

  it('refuses external endpoints (already running)', async () => {
    const svc = new BenchService(serviceSetup(tmp).deps);
    await expect(svc.planServer({ engine: { kind: 'external', baseUrl: 'http://h:1' }, model: {} })).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'external' } });
  });

  it('previews like a run: redacted command, needs, pending parts, fit and warnings', async () => {
    const s = serviceSetup(tmp, {
      telemetry: { users: [{ pid: 77, name: 'ollama', knownLlm: true }] },
      deps: {
        needs: async () => [{ kind: 'engine', label: 'llama.cpp', bytes: 480 * 1024 ** 2 }],
        fit: async () => fit('good'),
        slowSharedFilesystem: () => true,
        redact: (argv, env) => ({ argv: argv.map((a) => a.replace(/^gpubench-.*/, '<M>')), env }),
      },
    });
    const pendingAdapter = Object.assign(Object.create(s.adapter) as typeof s.adapter, {
      plan: async (...a: Parameters<typeof s.adapter.plan>) => ({ ...(await s.adapter.plan(...a)), ...(a[3].preview ? { pending: ['engine' as const] } : {}) }),
    });
    const plan = await new BenchService({ ...s.deps, getAdapter: () => pendingAdapter }).planServer(llama());
    expect(plan.command.argv).toContain('<M>');
    expect(plan.command.bash).toContain('llama-server');
    expect(plan.needs).toEqual([{ kind: 'engine', label: 'llama.cpp', bytes: 480 * 1024 ** 2 }]);
    expect(plan.pending).toEqual(['engine']);
    expect(plan.fit?.level).toBe('good');
    expect(plan.warnings).toEqual([{ code: 'VRAM_BUSY', params: { names: 'ollama', pids: '77' } }, { code: 'slow_shared_filesystem' }]);
    expect(plan).not.toHaveProperty('scenario');
    expect(plan).not.toHaveProperty('estimatedSeconds');
  });
});
