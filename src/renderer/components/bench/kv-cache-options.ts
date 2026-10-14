/**
 * The "Tipo di cache KV" choices of the Benchmark's expert panel and of the server form: automatic,
 * f16, q8_0, q4_0 and, for a llama.cpp fork, the types its --help lists that upstream llama.cpp lacks
 * (turbo4, turbo3…), each with its size ("3,125 bit per valore") or "stima non disponibile" when LLM
 * Bench does not know it (the estimate then counts it as f16).
 */
import type { CustomEngine, CustomEngineInfo } from '../../../contract/custom-engines';
import { forkKvTypes, llamaKvBits, llamaKvChoices } from '../../../contract/kv-cache';
import type { Formatters } from '../../i18n';
import type { SelectOption } from '../ui/select';

/**
 * Options for a build that lists `listed` (undefined = upstream llama.cpp). A value chosen before that
 * this build does not list (another fork's type) stays visible, so the field never shows blank.
 */
export function kvCacheOptions(listed: readonly string[] | undefined, current: string, f: Pick<Formatters, 't' | 'number'>): SelectOption[] {
  const own = new Set(forkKvTypes(listed));
  const types = llamaKvChoices(listed);
  if (current !== 'default' && !types.includes(current)) types.push(current);
  return [
    { value: 'default', label: f.t('common.auto') },
    ...types.map((type): SelectOption => {
      if (!own.has(type)) return { value: type, label: type };
      const bits = llamaKvBits(type);
      if (bits === undefined) return { value: type, label: type, description: f.t('benchmark.expert.kvNoEstimate') };
      // As many decimals as the size has: 2, 4,25, 3,125.
      const digits = (String(bits).split('.')[1] ?? '').length;
      return { value: type, label: type, description: f.t('benchmark.expert.kvBits', { bits: f.number(bits, digits) }) };
    }),
  ];
}

/** The -ctk values the chosen custom engine's check read from its --help (undefined: not a fork, or not checked yet). */
export function customKvCacheTypes(infos: readonly CustomEngineInfo[] | undefined, custom: Pick<CustomEngine, 'id'> | undefined): string[] | undefined {
  if (!custom) return undefined;
  return infos?.find((i) => i.engine.id === custom.id)?.check.kvCacheTypes;
}
