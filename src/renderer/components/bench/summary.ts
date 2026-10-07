/** "Come è stato avviato" in one line, for everyone: engine · model · context · GPU layers · options. */
import type { EngineKind, LaunchParams } from '../../../contract/engines';
import type { RunResult, Scenario } from '../../../contract/results';
import type { Formatters } from '../../i18n';
import { engineLabelOf, modelLabelOf } from './format';

const LLAMA: ReadonlySet<EngineKind> = new Set<EngineKind>(['llamacpp-native', 'llamacpp-docker']);
const DOCKER: ReadonlySet<EngineKind> = new Set<EngineKind>(['llamacpp-docker', 'vllm-docker']);

/** Parameter parts of the sentence (shared by the result page and the compare page). */
export function paramParts(kind: EngineKind, p: LaunchParams, blockCount: number | undefined, f: Pick<Formatters, 't' | 'integer' | 'percent'>): string[] {
  const { t, integer } = f;
  const parts: string[] = [];
  const ctx = p.contextSize ?? p.maxModelLen;
  if (ctx !== undefined) parts.push(t('result.launch.context', { n: integer(ctx) }));
  if (LLAMA.has(kind)) {
    // llama.cpp convention: no value, "all" or a count ≥ the model's layers puts everything on the GPU.
    if (p.gpuLayers === undefined || (blockCount !== undefined && p.gpuLayers >= blockCount)) parts.push(t('result.launch.allGpu'));
    else if (p.gpuLayers === 0) parts.push(t('result.launch.cpuOnly'));
    else parts.push(t('result.launch.layers', { n: p.gpuLayers }));
  }
  if (p.flashAttention === 'on') parts.push(t('result.launch.flashAttention'));
  if (p.flashAttention === 'off') parts.push(t('result.launch.flashAttentionOff'));
  if (p.kvCacheType && p.kvCacheType !== 'auto' && p.kvCacheType !== 'f16') parts.push(t('result.launch.kvCache', { type: p.kvCacheType }));
  if (p.parallel !== undefined && p.parallel > 1) parts.push(t('result.launch.parallel', { n: p.parallel }));
  if (p.batchSize !== undefined || p.ubatchSize !== undefined) {
    parts.push(t('result.launch.batch', { batch: p.batchSize ?? '–', ubatch: p.ubatchSize ?? '–' }));
  }
  if (p.threads !== undefined) parts.push(t('result.launch.threads', { n: p.threads }));
  if (p.gpuMemoryUtilization !== undefined) parts.push(t('result.launch.gpuMemory', { pct: f.percent(p.gpuMemoryUtilization, 0) }));
  if (p.dtype) parts.push(p.dtype);
  if (p.quantization) parts.push(p.quantization);
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
      case 'sessions':
        return s.depth > 0
          ? t('benchmark.scenario.sessions', { depth: integer(s.depth), levels: list(s.levels), turns: s.turns })
          : t('benchmark.scenario.sessionsAuto', { levels: list(s.levels), turns: s.turns });
    }
  });
}
