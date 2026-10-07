/**
 * Launch settings in words, one wording everywhere: the result page sentence ("Come è stato
 * avviato"), the configuration labels (config-label.ts) and the Configurazioni table.
 */
import { CONFIG_DEFAULTS, configParamsOf, configTagsOf, engineFamilyOf, type ConfigParams, type ConfigTag } from '../../../contract/configs';
import type { EngineKind, LaunchParams } from '../../../contract/engines';
import type { RunResult, Scenario } from '../../../contract/results';
import type { Formatters } from '../../i18n';
import { engineLabelOf, modelLabelOf } from './format';

const DOCKER: ReadonlySet<EngineKind> = new Set<EngineKind>(['llamacpp-docker', 'vllm-docker']);

export interface ConfigPartsOptions {
  /** Say the context even when it is the engine's default ("contesto predefinito"); otherwise only a known one. */
  context?: 'always' | 'known' | 'never';
  /** Say the KV cache type even when it is the default (f16 for llama.cpp, auto for vLLM). */
  kv?: 'always' | 'custom';
  /** llama.cpp: say "tutto in GPU" when every layer is on the GPU (the default). */
  allGpu?: boolean;
  /** Slower-by-design traits (the tuner's tags); the ones the settings already show are not repeated. */
  tags?: readonly ConfigTag[];
}

/** "{name}" of a draft model or a vLLM speculative config (its model, else its method). */
function speculativeName(p: ConfigParams): string | undefined {
  if (p.draftModel) return p.draftModel;
  try {
    const spec = JSON.parse(p.speculative ?? '') as { model?: unknown; method?: unknown };
    const name = spec.model ?? spec.method;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalized settings (contract/configs.ts) as parts: context, KV cache, GPU layers and CPU offload,
 * flash attention, ub, b, slots, then the rest. Engine defaults are left out unless asked for.
 */
export function configParts(kind: EngineKind, p: ConfigParams, f: Pick<Formatters, 't' | 'integer' | 'percent'>, opts: ConfigPartsOptions = {}): string[] {
  const { t, integer } = f;
  const family = engineFamilyOf(kind);
  const parts: string[] = [];
  // An external server's own settings are unknown: nothing is "default" there.
  const known = family !== 'external';
  const context = opts.context ?? 'known';
  if (p.contextSize !== undefined && context !== 'never') parts.push(t('result.launch.context', { n: integer(p.contextSize) }));
  else if (context === 'always' && known) parts.push(t('result.launch.contextDefault'));
  const defaultCache = family === 'vllm' ? CONFIG_DEFAULTS.vllm.cacheType : CONFIG_DEFAULTS.llamacpp.cacheType;
  const k = p.cacheTypeK ?? defaultCache;
  const v = p.cacheTypeV ?? defaultCache;
  if (k !== v) parts.push(t('result.launch.kvCacheSplit', { k, v }));
  else if ((opts.kv === 'always' && known) || k !== defaultCache) parts.push(t('result.launch.kvCache', { type: k }));
  if (family === 'llamacpp') {
    // llama.cpp convention: no value, "all" or a count ≥ the model's layers puts everything on the GPU.
    if (p.gpuLayers === 0) parts.push(t('result.launch.cpuOnly'));
    else if (p.gpuLayers !== undefined) parts.push(t('result.launch.layers', { n: p.gpuLayers }));
    else if (opts.allGpu) parts.push(t('result.launch.allGpu'));
  }
  if (p.cpuMoe === 'all') parts.push(t('result.launch.cpuMoeAll'));
  else if (p.cpuMoe !== undefined) parts.push(t('result.launch.cpuMoe', { n: p.cpuMoe }));
  if (p.flashAttention === 'on') parts.push(t('result.launch.flashAttention'));
  if (p.flashAttention === 'off') parts.push(t('result.launch.flashAttentionOff'));
  if (p.ubatchSize !== undefined) parts.push(t('result.launch.ubatch', { n: integer(p.ubatchSize) }));
  if (p.batchSize !== undefined) parts.push(t('result.launch.batch', { n: integer(p.batchSize) }));
  if (p.maxNumBatchedTokens !== undefined) parts.push(t('result.launch.batchTokens', { n: integer(p.maxNumBatchedTokens) }));
  if (p.parallel !== undefined && p.parallel > 1) parts.push(t('result.launch.parallel', { n: p.parallel }));
  if (p.threads !== undefined) parts.push(t('result.launch.threads', { n: p.threads }));
  if (p.gpuMemoryUtilization !== undefined) parts.push(t('result.launch.gpuMemory', { pct: f.percent(p.gpuMemoryUtilization, 0) }));
  if (p.enforceEager) parts.push(t('result.launch.eager'));
  const spec = speculativeName(p);
  if (spec) parts.push(t('result.launch.speculativeWith', { name: spec }));
  else if (p.speculative !== undefined || p.draftMax !== undefined) parts.push(t('result.launch.speculative'));
  if (p.dtype) parts.push(p.dtype);
  if (p.quantization) parts.push(p.quantization);
  if (p.other.length) parts.push(t('result.launch.extraArgs', { args: p.other.join(' ') }));
  const shown = new Set(configTagsOf(p));
  if (p.draftMax !== undefined) shown.add('draft');
  for (const tag of opts.tags ?? []) {
    if (shown.has(tag)) continue;
    shown.add(tag);
    parts.push(t(tag === 'cpu-offload' ? 'result.launch.offload' : tag === 'eager' ? 'result.launch.eager' : 'result.launch.speculative'));
  }
  return parts;
}

/**
 * Parameter parts of the result page sentence: the settings in configuration words, then the extra
 * arguments exactly as typed and the environment (how it was started, not only what it changes).
 */
export function paramParts(kind: EngineKind, p: LaunchParams, blockCount: number | undefined, f: Pick<Formatters, 't' | 'integer' | 'percent'>): string[] {
  const { t } = f;
  const parts = configParts(kind, configParamsOf({ engineKind: kind, params: { ...p, extraArgs: [] }, blockCount }), f, { allGpu: true });
  if (p.extraArgs.length) parts.push(t('result.launch.extraArgs', { args: p.extraArgs.join(' ') }));
  const envCount = Object.keys(p.env).length;
  if (envCount) parts.push(t('result.launch.envCount', { n: envCount }));
  return parts;
}

/** The whole sentence as parts, e.g. ["llama.cpp b11438 (CUDA 13.4)", "Qwen3 8B · Q4_K_M", "contesto 8.192", "tutto in GPU"]. */
export function launchSummaryParts(run: Pick<RunResult, 'engine' | 'model' | 'launch'>, f: Pick<Formatters, 't' | 'integer' | 'percent'>): string[] {
  const engine = engineLabelOf(run.engine) + (DOCKER.has(run.engine.kind) ? ' · Docker' : '');
  return [engine, modelLabelOf(run.model), ...paramParts(run.engine.kind, run.launch.params, run.model.facts?.blockCount, f)];
}

/** The test plan in plain words: "1 caricamento a caldo", "prompt da 512 token · 128 generati · 3 ripetizioni"… */
export function scenarioLines(scenario: Scenario, f: Pick<Formatters, 't' | 'integer' | 'locale'>): string[] {
  const { t, integer } = f;
  const list = (items: readonly number[]) => new Intl.ListFormat(f.locale, { type: 'conjunction' }).format(items.map(integer));
  return scenario.steps.map((s) => {
    switch (s.kind) {
      case 'load':
        return t(s.cache === 'cold' ? (s.reps === 1 ? 'benchmark.scenario.cold1' : 'benchmark.scenario.cold') : s.reps === 1 ? 'benchmark.scenario.warm1' : 'benchmark.scenario.warm', { n: s.reps });
      case 'latency':
        return t('benchmark.scenario.latency', { prompts: list(s.promptTokens), output: integer(s.outputTokens), reps: s.reps });
      case 'concurrency':
        return t('benchmark.scenario.concurrency', { levels: list(s.levels) });
      case 'llama-bench':
        return t('benchmark.scenario.llamaBench');
      case 'context-sweep':
        return t('benchmark.scenario.contextSweep');
    }
  });
}
