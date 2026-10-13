import type { CustomEngineInfo } from '../../../contract/custom-engines';
import type { EngineConfig } from '../../../contract/engines';
import type { Formatters } from '../../i18n';
import { customEngineLabel } from '../engines/custom-engine-check';

/** "llama.cpp", "vLLM (Docker)", or a custom engine as the Benchmark names it ("llama.cpp · PrismML"). */
export function engineNameOf(config: Pick<EngineConfig, 'kind' | 'customEngineId'>, customs: readonly CustomEngineInfo[], f: Pick<Formatters, 't'>): string {
  const custom = config.customEngineId !== undefined ? customs.find((c) => c.engine.id === config.customEngineId) : undefined;
  return custom ? customEngineLabel(f.t, custom.engine) : f.t(`benchmark.engines.${config.kind}`);
}

/**
 * A running server's engine with its build: "llama.cpp b10997 (cuda-13.4)" as the core says it, or
 * "llama.cpp · PrismML b123" for a custom engine (the core names it by its own name only).
 */
export function serverEngineName(s: { engineLabel: string; request: { engine: Pick<EngineConfig, 'kind' | 'customEngineId'> } }, customs: readonly CustomEngineInfo[], f: Pick<Formatters, 't'>): string {
  const id = s.request.engine.customEngineId;
  const custom = id !== undefined ? customs.find((c) => c.engine.id === id) : undefined;
  if (!custom) return s.engineLabel;
  const build = s.engineLabel.startsWith(custom.engine.name) ? s.engineLabel.slice(custom.engine.name.length).trim() : '';
  return [customEngineLabel(f.t, custom.engine), build].filter(Boolean).join(' ');
}
