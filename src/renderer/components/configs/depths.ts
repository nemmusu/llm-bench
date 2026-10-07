/**
 * "Confronta a": the depth (prompt length, or how full the context was) the configurations are
 * compared at. Only measured numbers: a configuration without a point at that depth says so, and
 * nothing is ever interpolated.
 */
import type { ConfigEntry, ConfigSource, DepthPoint } from '../../../contract/configs';

/** The configuration's numbers at `depth`, when it was measured there. */
export function pointAt(entry: Pick<ConfigEntry, 'points'>, depth: number | undefined): DepthPoint | undefined {
  return depth === undefined ? undefined : entry.points.find((p) => p.depth === depth);
}

/** How many configurations measured each depth. */
function coverage(entries: readonly Pick<ConfigEntry, 'points'>[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const e of entries) for (const p of e.points) counts.set(p.depth, (counts.get(p.depth) ?? 0) + 1);
  return counts;
}

/** Depths at least two configurations measured (all depths when fewer than two configurations share any), shallow first. */
export function depthChoices(entries: readonly Pick<ConfigEntry, 'points'>[]): number[] {
  const counts = [...coverage(entries).entries()];
  const shared = counts.filter(([, n]) => n >= 2);
  return (shared.length ? shared : counts).map(([d]) => d).sort((a, b) => a - b);
}

/** The depth most configurations measured; on a tie, the shortest (closest to everyday prompts). */
export function defaultDepth(entries: readonly Pick<ConfigEntry, 'points'>[], choices: readonly number[]): number | undefined {
  const counts = coverage(entries);
  let best: number | undefined;
  for (const d of choices) if (best === undefined || counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/** The newest test of the configuration that measured `depth` (the preset quotes its own numbers), else the newest. */
export function sourceFor(entry: Pick<ConfigEntry, 'sources'>, depth: number | undefined): ConfigSource {
  return entry.sources.find((s) => s.points.some((p) => p.depth === depth && p.decodeTps !== undefined)) ?? entry.sources[0]!;
}
