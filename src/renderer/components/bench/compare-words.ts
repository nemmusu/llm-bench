/**
 * Differences in words, like a person would write them: "2,2 volte più veloce", "+16%", "−54%",
 * "2,2 volte di più". Ratios of at least 2 (or at most ½) read as "N volte", smaller changes as a
 * percentage; whether it is good news depends on the metric.
 */
import type { Formatters } from '../../i18n';
import { deltaView, type DeltaView } from './delta';

/** What the number is: a speed (faster/slower), an amount (more/less) or a time (shorter/longer). */
export type DeltaKind = 'speed' | 'amount' | 'time';

/** Below this share of reused context, the later messages read everything again ("riletto da capo"). */
export const REREAD_SHARE = 0.01;

/** "2,2" (one decimal below 10, none from 10 on; "2" rather than "2,0"). */
function times(n: number, number: Formatters['number']): string {
  const rounded = n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
  return number(rounded, Number.isInteger(rounded) ? 0 : 1);
}

export function deltaWords(
  a: number | undefined,
  b: number | undefined,
  o: { higherIsBetter: boolean; kind: DeltaKind },
  f: Pick<Formatters, 't' | 'number' | 'percent'>,
): DeltaView | undefined {
  const base = deltaView(a, b, o.higherIsBetter, f.percent);
  if (!base || base.direction === 'same') return base;
  const ratio = (b as number) / (a as number);
  if (!(ratio >= 2 || (ratio > 0 && ratio <= 0.5))) return base;
  const up = ratio > 1;
  const words = { speed: ['faster', 'slower'], amount: ['more', 'less'], time: ['longer', 'shorter'] } as const;
  const key = words[o.kind][up ? 0 : 1];
  return { ...base, text: f.t(`longConversations.compare.${key}`, { n: times(up ? ratio : 1 / ratio, f.number) }) };
}
