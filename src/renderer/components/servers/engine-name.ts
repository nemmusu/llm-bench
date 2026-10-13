import type { CustomEngineInfo } from '../../../contract/custom-engines';
import type { EngineConfig } from '../../../contract/engines';
import type { Formatters } from '../../i18n';

/** "llama.cpp", "vLLM (Docker)", "llama.cpp · PrismML fork" (a fork), "Il mio server" (a command template). */
export function engineNameOf(config: Pick<EngineConfig, 'kind' | 'customEngineId'>, customs: readonly CustomEngineInfo[], f: Pick<Formatters, 't'>): string {
  const base = f.t(`benchmark.engines.${config.kind}`);
  const custom = config.customEngineId !== undefined ? customs.find((c) => c.engine.id === config.customEngineId) : undefined;
  if (!custom) return base;
  return config.kind === 'command' ? custom.engine.name : f.t('servers.flow.engine.custom', { base, name: custom.engine.name });
}
