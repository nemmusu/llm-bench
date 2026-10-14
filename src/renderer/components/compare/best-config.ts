/**
 * "Confronta modelli": for each model measured on this card, its configurations ranked, the best
 * first, where Configurazioni compares them by default. "Contesto massimo" when some configuration was
 * measured with its context full (as the tune ranking): the largest context first, then the fastest
 * generation with that context full. Else the highest generation speed at the depth most of them
 * measured (the same depth for all of them: never one number against another context), ties to the
 * larger context, then the newer test. Configurations that spilled into shared memory come last (their
 * numbers are not the card's).
 */
import type { ConfigEntry } from '../../../contract/configs';
import { SAME_THRESHOLD } from '../bench/delta';
import { AT_MAX, depthFor, fullPoint, pointFor, sourceFor, type CompareAt } from '../configs/depths';
import type { CompareRef } from '../../lib/compare-selection';
import { tokensK } from '../../lib/speed-at';
import { EVERYDAY_DEPTH, missingSpeed, type CompareFormatters } from './compare-model';

export interface ModelConfigs {
  /** The model key of the configurations (sha256, repo or weak key). */
  key: string;
  name: string;
  quant?: string;
  /** Best first. */
  configs: ConfigEntry[];
  /** Where they were ranked (undefined: none measured a generation speed). */
  at?: CompareAt;
}

/** The depth most of these configurations measured a generation speed at; ties: closest to 512 tokens, then deeper. */
export function rankingDepth(entries: readonly ConfigEntry[]): number | undefined {
  const counts = new Map<number, number>();
  for (const e of entries) for (const p of e.points) if (p.decodeTps !== undefined) counts.set(p.depth, (counts.get(p.depth) ?? 0) + 1);
  const distance = (d: number) => Math.abs(Math.log2(d / EVERYDAY_DEPTH));
  return [...counts].sort((a, b) => b[1] - a[1] || distance(a[0]) - distance(b[0]) || b[0] - a[0])[0]?.[0];
}

/** Where the configurations of one model are ranked: "Contesto massimo" when one got there with its context full, else rankingDepth. */
export function rankingAt(entries: readonly ConfigEntry[]): CompareAt | undefined {
  return entries.some((e) => fullPoint(e)?.decodeTps !== undefined) ? AT_MAX : rankingDepth(entries);
}

/** Its generation speed where the configurations are ranked. */
export function decodeAt(e: ConfigEntry, at: CompareAt | undefined): number | undefined {
  return pointFor(e, at)?.decodeTps;
}

/** The configurations of one model, best first (see the file comment). */
export function rankConfigs(entries: readonly ConfigEntry[]): { configs: ConfigEntry[]; at?: CompareAt } {
  const clean = entries.filter((e) => !e.spill);
  const at = rankingAt(clean.length ? clean : entries);
  const newer = (a: ConfigEntry, b: ConfigEntry) => Date.parse(b.latest) - Date.parse(a.latest);
  const order = (a: ConfigEntry, b: ConfigEntry): number => {
    if (!!a.spill !== !!b.spill) return a.spill ? 1 : -1;
    const da = decodeAt(a, at);
    const db = decodeAt(b, at);
    if (da === undefined || db === undefined) return (da === undefined ? 1 : 0) - (db === undefined ? 1 : 0) || (b.contextSize ?? 0) - (a.contextSize ?? 0) || newer(a, b);
    // At the largest context, speeds compare only between the same context: the larger one first.
    if (at === AT_MAX && a.contextSize !== b.contextSize) return (b.contextSize ?? 0) - (a.contextSize ?? 0);
    if (Math.abs(da - db) / Math.max(da, db) >= SAME_THRESHOLD) return db - da;
    return (b.contextSize ?? 0) - (a.contextSize ?? 0) || newer(a, b);
  };
  return { configs: [...entries].sort(order), ...(at === undefined ? {} : { at }) };
}

/** Every model with its ranked configurations, by name. */
export function modelsOf(entries: readonly ConfigEntry[]): ModelConfigs[] {
  const groups = new Map<string, ConfigEntry[]>();
  for (const e of entries) groups.set(e.model.key, [...(groups.get(e.model.key) ?? []), e]);
  return [...groups].map(([key, list]) => {
    const m = list[0]!.model;
    return { key, name: m.name, ...(m.quant ? { quant: m.quant } : {}), ...rankConfigs(list) };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** The first configuration's words: "La più veloce al contesto massimo: …", "La più veloce a 1K: …". */
export function bestConfigLabel(at: CompareAt | undefined, config: string, f: CompareFormatters): string {
  if (at === undefined) return config;
  return at === AT_MAX ? f.t('compare.card.fastestMax', { config }) : f.t('compare.card.fastestAt', { depth: tokensK(at, f), config });
}

/**
 * A configuration's generation speed where the configurations are ranked, with the context it was
 * measured at: "61,2 tok/s con il contesto pieno a 256K", "54,6 tok/s a 1K"; or why there is none
 * ("non misurata a 256K", "arriva solo a 32K").
 */
export function configSpeedWords(e: ConfigEntry, at: CompareAt | undefined, f: CompareFormatters): string | undefined {
  if (at === undefined) return undefined;
  const p = pointFor(e, at);
  if (p?.decodeTps === undefined) return missingSpeed({ points: e.points, maxContext: e.contextSize }, at, f);
  const value = `${f.number(p.decodeTps, 1)} tok/s`;
  return f.t(at === AT_MAX && e.contextSize !== undefined ? 'compare.card.speedFull' : 'compare.card.speedAt', { value, depth: tokensK(p.depth, f) });
}

/** A configuration as a choice of a picker: its words (the first: "La più veloce…"), and its speed with its context under them. */
export function configOption(e: ConfigEntry, first: boolean, words: string, at: CompareAt | undefined, f: CompareFormatters): { value: string; label: string; text: string; description?: string } {
  const speed = configSpeedWords(e, at, f);
  return { value: e.id, label: first ? bestConfigLabel(at, words, f) : words, text: words, ...(speed === undefined ? {} : { description: speed }) };
}

/** The test to compare for a configuration: the newest one that measured it where it is ranked, else the newest. */
export function refOfConfig(entry: ConfigEntry, at: CompareAt | undefined): CompareRef {
  const s = sourceFor(entry, depthFor(entry, at));
  return s.combo === undefined ? { runId: s.runId } : { runId: s.runId, combo: s.combo };
}
