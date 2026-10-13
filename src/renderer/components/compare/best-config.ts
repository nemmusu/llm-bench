/**
 * "Confronta modelli": for each model measured on this card, its configurations ranked, the best
 * first. Best = the highest measured generation speed at the depth most of its configurations
 * measured (the same depth for all of them: never one number against another context), ties to the
 * larger context, then the newer test. Configurations that spilled into shared memory come last
 * (their numbers are not the card's).
 */
import type { ConfigEntry } from '../../../contract/configs';
import { SAME_THRESHOLD } from '../bench/delta';
import { sourceFor } from '../configs/depths';
import type { CompareRef } from '../../lib/compare-selection';
import { EVERYDAY_DEPTH } from './compare-model';

export interface ModelConfigs {
  /** The model key of the configurations (sha256, repo or weak key). */
  key: string;
  name: string;
  quant?: string;
  /** Best first. */
  configs: ConfigEntry[];
  /** The depth they were ranked at (undefined: none measured a generation speed). */
  depth?: number;
}

const decodeAt = (e: ConfigEntry, depth: number | undefined) => e.points.find((p) => p.depth === depth)?.decodeTps;

/** The depth most of these configurations measured a generation speed at; ties: closest to 512 tokens, then deeper. */
export function rankingDepth(entries: readonly ConfigEntry[]): number | undefined {
  const counts = new Map<number, number>();
  for (const e of entries) for (const p of e.points) if (p.decodeTps !== undefined) counts.set(p.depth, (counts.get(p.depth) ?? 0) + 1);
  const distance = (d: number) => Math.abs(Math.log2(d / EVERYDAY_DEPTH));
  return [...counts].sort((a, b) => b[1] - a[1] || distance(a[0]) - distance(b[0]) || b[0] - a[0])[0]?.[0];
}

/** The configurations of one model, best first (see the file comment). */
export function rankConfigs(entries: readonly ConfigEntry[]): { configs: ConfigEntry[]; depth?: number } {
  const clean = entries.filter((e) => !e.spill);
  const depth = rankingDepth(clean.length ? clean : entries);
  const order = (a: ConfigEntry, b: ConfigEntry): number => {
    if (!!a.spill !== !!b.spill) return a.spill ? 1 : -1;
    const da = decodeAt(a, depth);
    const db = decodeAt(b, depth);
    if (da === undefined || db === undefined) return (da === undefined ? 1 : 0) - (db === undefined ? 1 : 0) || Date.parse(b.latest) - Date.parse(a.latest);
    if (Math.abs(da - db) / Math.max(da, db) >= SAME_THRESHOLD) return db - da;
    return (b.contextSize ?? 0) - (a.contextSize ?? 0) || Date.parse(b.latest) - Date.parse(a.latest);
  };
  return { configs: [...entries].sort(order), ...(depth === undefined ? {} : { depth }) };
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

/** The test to compare for a configuration: the newest one that measured `depth`, else the newest. */
export function refOfConfig(entry: ConfigEntry, depth: number | undefined): CompareRef {
  const s = sourceFor(entry, depth);
  return s.combo === undefined ? { runId: s.runId } : { runId: s.runId, combo: s.combo };
}
