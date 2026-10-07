/**
 * A launch configuration in plain words, the same everywhere (Risultati → Configurazioni, the result
 * page header, the live screen, the tuner): "Contesto 32.768 · cache KV q8_0 · flash attention ·
 * ub 2048 · b 4096". Context and KV cache are always said; everything else only when it differs
 * from the engine's defaults (CONFIG_DEFAULTS); CPU offload, eager and draft are always visible.
 * The wording itself lives in bench/summary.ts (configParts), shared with "Come è stato avviato".
 */
import { useCallback } from 'react';
import { CONFIG_DEFAULTS, LLAMA_DEFAULTS, VLLM_DEFAULTS, configParamsOf, type ConfigParams, type ConfigTag } from '../../../contract/configs';
import type { EngineKind, LaunchParams } from '../../../contract/engines';
import { useI18n, type Formatters } from '../../i18n';
import { configParts } from '../bench/summary';

export { CONFIG_DEFAULTS, LLAMA_DEFAULTS, VLLM_DEFAULTS };

export interface ConfigLabel {
  parts: string[];
  /** The parts joined with " · ", first letter capitalized. */
  text: string;
}

export interface ConfigLabelOptions {
  /** The model's layer count: -ngl at or above it is "all on the GPU" (no offload). */
  blockCount?: number | undefined;
  /** The tuner's tags of a combination (cpu-offload, eager, draft). */
  tags?: readonly ConfigTag[] | undefined;
  /** false = leave the context out (a table with its own Contesto column). */
  context?: boolean;
  /** 'custom' = the KV cache only when it is not the engine's default (a table where every row says it). */
  kv?: 'always' | 'custom';
}

const capitalize = (s: string): string => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/** The label of normalized settings (what GET /api/configs returns). */
export function configLabelOf(kind: EngineKind, p: ConfigParams, f: Pick<Formatters, 't' | 'integer' | 'percent'>, opts: ConfigLabelOptions = {}): ConfigLabel {
  const parts = configParts(kind, p, f, { context: opts.context === false ? 'never' : 'always', kv: opts.kv ?? 'always', ...(opts.tags ? { tags: opts.tags } : {}) });
  if (parts.length) parts[0] = capitalize(parts[0]!);
  return { parts, text: parts.join(' · ') };
}

/** The label of launch params (a run's, a tune combination's, the Benchmark form's). */
export function launchLabelOf(params: LaunchParams, engineKind: EngineKind, f: Pick<Formatters, 't' | 'integer' | 'percent'>, opts: ConfigLabelOptions = {}): ConfigLabel {
  return configLabelOf(engineKind, configParamsOf({ engineKind, params, blockCount: opts.blockCount }), f, opts);
}

/** `(params, engineKind, opts?) => { parts, text }` in the current language. */
export function useConfigLabel(): (params: LaunchParams, engineKind: EngineKind, opts?: ConfigLabelOptions) => ConfigLabel {
  const f = useI18n();
  return useCallback((params: LaunchParams, engineKind: EngineKind, opts?: ConfigLabelOptions) => launchLabelOf(params, engineKind, f, opts), [f]);
}
