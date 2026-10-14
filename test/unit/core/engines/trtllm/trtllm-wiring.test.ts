// TensorRT-LLM across the core: its contract, its client (tokenizer, BOS), the external endpoint check, the
// VRAM estimate, the tuner's search, recipes, the custom-engine wrapper and the comparison's settings row.
import { describe, expect, it } from 'vitest';
import { engineBaseOf, isDockerKind, launchParamsSchema, trtllmParamsText } from '../../../../../src/contract/engines';
import { engineRunsFormat } from '../../../../../src/contract/ninfer';
import { recipeArgTargetOf } from '../../../../../src/contract/recipes';
import { buildScenario } from '../../../../../src/core/bench/scenarios';
import { buildTuneSetup, type TunePrepared } from '../../../../../src/core/bench/tune-setup';
import { trtllmSpace } from '../../../../../src/core/bench/tune-space';
import { CustomEngineAdapter } from '../../../../../src/core/engines/custom/adapter';
import { ExternalAdapter } from '../../../../../src/core/engines/external/adapter';
import { initialStage } from '../../../../../src/core/engines/shared/load-progress';
import { missingStandardFlags } from '../../../../../src/core/engines/shared/standard-flags';
import { serverApiName, type EngineAdapter, type EngineCaps, type LaunchPlan } from '../../../../../src/core/engines/types';
import { createInferenceClient } from '../../../../../src/core/inference/client';
import { OpenAiClient } from '../../../../../src/core/inference/openai-client';
import { estimateFit, fitParamsFrom, kvElementBytes, NVFP4_KV_BYTES, runsSafetensors } from '../../../../../src/core/models/fit';
import type { ModelFactsEx } from '../../../../../src/core/models/types';
import { paramText } from '../../../../../src/renderer/components/compare/compare-diff';
import { hardware, modelIdentity } from '../../store/fixtures';

const P = (o: object = {}) => launchParamsSchema.parse(o);
const clock = { now: () => 0, wall: () => 0, sleep: async () => undefined };

describe('the contract', () => {
  it('names its kinds, its base, its format and its settings in words', () => {
    expect(engineBaseOf('trtllm-docker')).toBe('trtllm');
    expect(engineBaseOf('trtllm-native')).toBe('trtllm');
    expect(isDockerKind('trtllm-docker')).toBe(true);
    expect(isDockerKind('trtllm-native')).toBe(false);
    expect(engineRunsFormat('trtllm-native', 'safetensors')).toBe(true);
    expect(engineRunsFormat('trtllm-docker', 'gguf')).toBe(false);
    expect(recipeArgTargetOf('trtllm-docker')).toBeUndefined();
    expect(trtllmParamsText(undefined)).toBe('');
    expect(trtllmParamsText({ kvCacheDtype: 'fp8', kvCacheFreeMemoryFraction: 0.8, tensorParallel: 2, chunkedPrefill: false, trustRemoteCode: true })).toBe(
      'kv_cache_dtype fp8 · kv_cache_free_gpu_memory_fraction 0.8 · tp_size 2 · chunked_prefill off · trust_remote_code',
    );
    expect(trtllmParamsText({ chunkedPrefill: true, trustRemoteCode: false })).toBe('chunked_prefill on');
    expect(paramText('trtllm', P({ trtllm: { tensorParallel: 2 } }), 'auto')).toBe('tp_size 2');
    expect(paramText('trtllm', P(), 'auto')).toBe('auto');
    expect(serverApiName('trtllm-native', { identity: modelIdentity({ repo: 'nvidia/Qwen3-8B-FP8' }) })).toBe('nvidia/Qwen3-8B-FP8');
    expect(initialStage('trtllm-docker')).toBe('container');
    expect(initialStage('trtllm-native')).toBe('starting');
    expect(missingStandardFlags('trtllm', new Set(['--host'])).map((m) => m.flag)).toContain('--served_model_name');
  });
});

/** trtllm-serve's /_internal/tokenize: BOS (1) always first, or no BOS at all. */
function tokenizer(o: { bos?: boolean; status?: number; probeStatus?: number } = {}) {
  const bodies: unknown[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url).toBe('http://trt/_internal/tokenize');
    const body = JSON.parse(String(init?.body)) as { prompt: string };
    bodies.push(body);
    if (o.status) return new Response('{"detail":"Not Found"}', { status: o.status });
    if (o.probeStatus && (body.prompt === 'A' || body.prompt === 'z')) return new Response('{}', { status: o.probeStatus });
    const ids = [...body.prompt].map((c) => c.charCodeAt(0));
    return Response.json({ count: ids.length, tokens: o.bos === false ? ids : [1, ...ids] });
  }) as typeof globalThis.fetch;
  return { client: new OpenAiClient('trtllm', 'http://trt', { fetch, clock }, { model: 'm' }), bodies };
}

describe('the trtllm client', () => {
  it('tokenizes with /_internal/tokenize: special tokens kept or taken off, BOS found once', async () => {
    const t = tokenizer();
    expect(await t.client.tokenize('Hi', { addSpecial: true })).toEqual([1, 72, 105]);
    expect(await t.client.tokenize('Hi')).toEqual([72, 105]);
    expect(await t.client.tokenize('Ok', { addSpecial: false })).toEqual([79, 107]);
    // Only model and prompt are sent (its request model forbids anything else); BOS was found with two probes.
    expect(t.bodies).toEqual([{ model: 'm', prompt: 'Hi' }, { model: 'm', prompt: 'Hi' }, { model: 'm', prompt: 'A' }, { model: 'm', prompt: 'z' }, { model: 'm', prompt: 'Ok' }]);
    const plain = tokenizer({ bos: false });
    expect(await plain.client.tokenize('Hi', { addSpecial: false })).toEqual([72, 105]);
    // A one-character probe without BOS is one token: nothing to take off.
  });

  it('builds without the route have no tokenizer (text prompts); other failures are errors, retried', async () => {
    await expect(tokenizer({ status: 404 }).client.tokenize('x')).rejects.toMatchObject({ params: { reason: 'tokenize_unsupported' } });
    await expect(tokenizer({ status: 405 }).client.tokenize('x', { addSpecial: true })).rejects.toMatchObject({ params: { reason: 'tokenize_unsupported' } });
    await expect(tokenizer({ status: 500 }).client.tokenize('x', { addSpecial: true })).rejects.toMatchObject({ code: expect.any(String) });
    // The BOS probe fails: an error, asked again next time.
    const failing = tokenizer({ probeStatus: 500 });
    await expect(failing.client.tokenize('x')).rejects.toBeDefined();
    const n = failing.bodies.length;
    await expect(failing.client.tokenize('x')).rejects.toBeDefined();
    expect(failing.bodies.length).toBeGreaterThan(n);
    const noModel = new OpenAiClient('trtllm', 'http://trt', { fetch: tokenizer().client['deps'].fetch, clock });
    expect(await noModel.tokenize('Hi', { addSpecial: true })).toEqual([1, 72, 105]);
  });

  it('asks like vLLM: exact lengths and running usage; no Prometheus prefix counters', async () => {
    const c = createInferenceClient('trtllm', 'http://trt', { fetch, clock }, { model: 'm' });
    expect((c as OpenAiClient).requestBody({ promptIds: [1, 2], outputTokens: 8, seed: 3 })).toMatchObject({ min_tokens: 8, ignore_eos: true, stream_options: { include_usage: true, continuous_usage_stats: true } });
    expect(await c.prefixCache?.()).toBeUndefined();
  });
});

describe('an external trtllm-serve', () => {
  it('is recognized by its model card and its /version', async () => {
    const fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) return Response.json({ object: 'list', data: [{ id: 'm', owned_by: 'tensorrt_llm' }] });
      if (url.endsWith('/version')) return Response.json({ version: '1.4.0rc0' });
      return new Response('no', { status: 404 });
    }) as typeof globalThis.fetch;
    const a = new ExternalAdapter({ fetch, clock, createClient: (f, b, o) => createInferenceClient(f, b, { fetch, clock }, o) });
    expect(await a.probe({ kind: 'external', baseUrl: 'http://x:8000/v1' })).toEqual({ flavor: 'trtllm', version: '1.4.0rc0', models: ['m'] });
    expect(await a.capabilities({ kind: 'external', baseUrl: 'http://x:8000' })).toMatchObject({ minTokens: true, tokenIdsInPrompt: true, variant: 'trtllm' });
    const plan = await a.plan({ kind: 'external', baseUrl: 'http://x:8000' }, { identity: modelIdentity() }, P(), { port: 1, marker: 'm' });
    expect(plan.engine).toMatchObject({ name: 'TensorRT-LLM', variant: 'trtllm', version: '1.4.0rc0' });
  });
});

const facts: ModelFactsEx = { blockCount: 36, headCountKv: 8, keyLength: 128, valueLength: 128, contextLength: 40960, paramsB: 8 } as ModelFactsEx;
const gpu = { totalMiB: 32_000, freeMiB: 30_000 };

describe('the VRAM estimate', () => {
  it('a KV pool of the memory left after the weights, one sequence of the context at least', () => {
    expect(runsSafetensors('trtllm-docker')).toBe(true);
    expect(kvElementBytes('trtllm', 'nvfp4')).toBe(NVFP4_KV_BYTES);
    expect(kvElementBytes('trtllm', 'q8_0')).toBe(1);
    expect(kvElementBytes('vllm', 'nvfp4')).toBe(2);
    expect(fitParamsFrom(P({ trtllm: { kvCacheFreeMemoryFraction: 0.5, kvCacheDtype: 'nvfp4' } }))).toEqual({ kvFreeFraction: 0.5, kvCacheType: 'nvfp4' });
    const est = estimateFit({ facts, fileBytes: 9 * 1024 ** 3, gpu, engine: 'trtllm-docker', params: { contextSize: 32_768 } });
    expect(est).toMatchObject({ level: 'perfect', levelNow: 'perfect', contextSize: 32_768, weightsMiB: 9216, basis: 'file-size' });
    expect(est.maxConcurrency).toBeGreaterThan(1);
    // The pool cannot hold the context: no fit, said why.
    const big = estimateFit({ facts, fileBytes: 28 * 1024 ** 3, gpu, engine: 'trtllm-native', params: { maxModelLen: 131_072, contextSize: 4096 } });
    expect(big).toMatchObject({ level: 'no', contextSize: 131_072 });
    expect(big.notes).toContain('vllm.kv-too-small');
    // A busy card: fine on the whole card, not right now.
    const busy = estimateFit({ facts, fileBytes: 9 * 1024 ** 3, gpu: { totalMiB: 32_000, freeMiB: 10_000 }, engine: 'trtllm-docker', params: { contextSize: 32_768, parallel: 4, kvFreeFraction: 0.9 } });
    expect(busy).toMatchObject({ levelNow: 'no' });
    // Weights that do not fit at all; a model whose size is guessed.
    expect(estimateFit({ facts, fileBytes: 40 * 1024 ** 3, gpu, engine: 'trtllm-docker' }).level).toBe('no');
    const guessed = estimateFit({ facts: { ...facts, paramsB: 1 } as ModelFactsEx, gpu, engine: 'trtllm-docker', params: { kvCacheType: 'fp8' } });
    expect(guessed.basis).toBe('params-heuristic');
    const empty = estimateFit({ facts: { ...facts, blockCount: 0 } as ModelFactsEx, fileBytes: 1024 ** 3, gpu, engine: 'trtllm-docker' });
    expect(empty).not.toHaveProperty('maxConcurrency');
  });
});

describe('the tuner', () => {
  it('searches KV auto / fp8 (nvfp4 in "Accurata" when listed) and the tokens per step', () => {
    const s = trtllmSpace({ budget: 'fast', params: P({ threads: 2, trtllm: { kvCacheDtype: 'nvfp4', tensorParallel: 2 }, extraArgs: ['--log_level', 'info'] }), users: 4, prefer: { bt: [8192] } });
    expect(s.kvLadder).toEqual(['auto', 'fp8']);
    expect(s.dimensions.map((d) => [d.key, d.values({})])).toEqual([['bt', [8192, 2048]]]);
    expect(s.base('fp8')).toEqual({ kv: 'fp8', bt: 2048, np: 4 });
    expect(s.contextFor(4, 8192)).toBe(8192);
    // The user's KV type would override the search: left out; their other TensorRT-LLM settings stay.
    expect(s.params({ kv: 'fp8', bt: 8192, np: 4 }, 16_384)).toEqual({ threads: 2, trtllm: { tensorParallel: 2 }, contextSize: 16_384, kvCacheType: 'fp8', batchSize: 8192, parallel: 4, extraArgs: ['--log_level', 'info'], env: {} });
    expect(s.tags({ kv: 'auto' })).toEqual([]);
    const plain = trtllmSpace({ budget: 'thorough', params: P({ trtllm: { kvCacheDtype: 'fp8' } }), choices: { '--kv_cache_dtype': ['auto', 'fp8', 'nvfp4'] } });
    expect(plain.kvLadder).toEqual(['auto', 'fp8', 'nvfp4']);
    expect(plain.params({ kv: 'auto', bt: 2048 }, 4096)).not.toHaveProperty('trtllm');
    expect(plain.base('auto')).toEqual({ kv: 'auto', bt: 2048 });
    expect(trtllmSpace({ budget: 'fast', params: P(), choices: { '--kv_cache_dtype': ['auto'] } }).kvLadder).toEqual(['auto']);
  });

  it('gets the space from the engine’s help, without YaRN launches', async () => {
    const prepared = (caps?: EngineCaps): TunePrepared => ({
      model: { identity: modelIdentity() },
      adapter: { capabilities: async () => (caps ? caps : Promise.reject(new Error('no'))) } as unknown as EngineAdapter,
      engine: { kind: 'trtllm-docker' },
      params: P(),
      launch: { modelBytes: 1_000_000_000 },
      scenario: buildScenario('tune'),
    });
    const deps = { telemetry: { snapshot: async () => [] }, fingerprint: async () => hardware() };
    const caps: EngineCaps = { flags: new Set(), choices: { '--kv_cache_dtype': ['auto', 'fp8'] }, tokenIdsInPrompt: true, timings: false, minTokens: true, fitFlag: false };
    const s = await buildTuneSetup(deps, { engine: { kind: 'trtllm-docker' }, tune: { budget: 'fast', fidelity: false, goal: 'multi', users: 2, yarnTarget: 512_000 } }, prepared(caps));
    expect(s.space.kvLadder).toEqual(['auto', 'fp8']);
    expect(s.space.base('auto')).toEqual({ kv: 'auto', bt: 2048, np: 2 });
    expect(s.space.params({ kv: 'auto', bt: 2048 }, 999_999)).not.toHaveProperty('ropeScaling');
    const none = await buildTuneSetup(deps, { engine: { kind: 'trtllm-native' } }, prepared());
    expect(none.space.kvLadder).toEqual(['auto', 'fp8']);
  });
});

describe('the custom-engine wrapper', () => {
  it('passes the base’s cold-load eviction and removal through', async () => {
    const calls: unknown[] = [];
    const inner = {
      kind: 'trtllm-native',
      detect: async () => ({ kind: 'trtllm-native', available: true, installed: true, problems: [], supported: true }),
      capabilities: async () => ({ flags: new Set(), tokenIdsInPrompt: true, timings: false, minTokens: true, fitFlag: false }),
      plan: async () => ({}) as LaunchPlan,
      start: async () => {
        throw new Error('x');
      },
      evict: async (plan: LaunchPlan) => {
        calls.push(['evict', plan.marker]);
        return { guaranteed: true };
      },
      remove: async (cfg: unknown) => void calls.push(['remove', cfg]),
    } as unknown as EngineAdapter;
    const w = new CustomEngineAdapter(inner, { list: async () => [] });
    expect(await w.evict?.({ marker: 'm' } as LaunchPlan)).toEqual({ guaranteed: true });
    await w.remove?.({ kind: 'trtllm-native' });
    expect(calls).toEqual([['evict', 'm'], ['remove', { kind: 'trtllm-native' }]]);
    const bare = new CustomEngineAdapter({ ...inner, evict: undefined, remove: undefined } as unknown as EngineAdapter, { list: async () => [] });
    expect(bare.evict).toBeUndefined();
    expect(bare.remove).toBeUndefined();
  });
});
