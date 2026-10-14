/**
 * "Confronta a": where the configurations are compared. "Contesto massimo" (the default when any of
 * them got there): each one at its own largest context, with the context full; or one depth (prompt
 * length, or how full the context was) for all. Only measured numbers: a configuration without a
 * point there says so, and nothing is ever interpolated.
 */
import type { ConfigEntry, ConfigSource, DepthPoint } from '../../../contract/configs';
import { fillsContext } from '../../../contract/results';

/** "Contesto massimo": every configuration at its own largest context, with the context full. */
export const AT_MAX = 'max';
/** A depth for all, or each one's own largest context. */
export type CompareAt = number | typeof AT_MAX;

type Measured<P> = { points: readonly P[]; contextSize?: number | undefined };

/** The configuration's numbers at `depth`, when it was measured there. */
export function pointAt(entry: Pick<ConfigEntry, 'points'>, depth: number | undefined): DepthPoint | undefined {
  return depth === undefined ? undefined : entry.points.find((p) => p.depth === depth);
}

const deepestOf = <P extends { depth: number }>(points: readonly P[]): P | undefined =>
  points.reduce<P | undefined>((best, p) => (best === undefined || p.depth > best.depth ? p : best), undefined);

/** Its deepest point, when that fills its context (the context is known). */
export function fullPoint<P extends { depth: number }>(m: Measured<P>): P | undefined {
  const deepest = deepestOf(m.points);
  return deepest !== undefined && m.contextSize !== undefined && fillsContext(deepest.depth, m.contextSize) ? deepest : undefined;
}

/**
 * Its numbers at its largest context: with the context full; a configuration whose context is not
 * known (an external server) at the deepest it measured (the table says that depth).
 */
export function maxPoint<P extends { depth: number }>(m: Measured<P>): P | undefined {
  return m.contextSize === undefined ? deepestOf(m.points) : fullPoint(m);
}

/** Its numbers where the table compares them. */
export function pointFor<P extends { depth: number }>(m: Measured<P>, at: CompareAt | undefined): P | undefined {
  return at === AT_MAX ? maxPoint(m) : m.points.find((p) => p.depth === at);
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

/** "Contesto massimo" when some configuration was measured with its context full; else the depth most of them measured. */
export function defaultAt(entries: readonly Pick<ConfigEntry, 'points' | 'contextSize'>[], choices: readonly number[]): CompareAt | undefined {
  return entries.some((e) => fullPoint(e) !== undefined) ? AT_MAX : defaultDepth(entries, choices);
}

/** The depth a configuration is compared at: `at` itself, or (Contesto massimo) the depth of its own largest context. */
export function depthFor(entry: Pick<ConfigEntry, 'points' | 'contextSize'>, at: CompareAt | undefined): number | undefined {
  return at === AT_MAX ? maxPoint(entry)?.depth : at;
}

/** The newest test of the configuration that measured `depth` (the preset quotes its own numbers), else the newest. */
export function sourceFor(entry: Pick<ConfigEntry, 'sources'>, depth: number | undefined): ConfigSource {
  return entry.sources.find((s) => s.points.some((p) => p.depth === depth && p.decodeTps !== undefined)) ?? entry.sources[0]!;
}
