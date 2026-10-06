/** "+23% / −5%" between two measurements, with whether the change is good news. */

export interface DeltaView {
  /** Relative change of b against a (0.23 = +23%). */
  change: number;
  /** Formatted with a real minus sign, e.g. "+23%" or "−5%". */
  text: string;
  direction: 'up' | 'down' | 'same';
  good: boolean;
}

/** Changes smaller than this are shown as "uguale". */
export const SAME_THRESHOLD = 0.005;

/** (b − a) / a, or undefined when either side is missing or a is zero. */
export function relativeChange(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined || a === 0) return undefined;
  return (b - a) / a;
}

export function deltaView(
  a: number | undefined,
  b: number | undefined,
  higherIsBetter: boolean,
  percent: (ratio: number, digits?: number) => string,
): DeltaView | undefined {
  const change = relativeChange(a, b);
  if (change === undefined) return undefined;
  if (Math.abs(change) < SAME_THRESHOLD) return { change, text: percent(0, 0), direction: 'same', good: true };
  const up = change > 0;
  const digits = Math.abs(change) < 0.1 ? 1 : 0;
  return {
    change,
    text: `${up ? '+' : '−'}${percent(Math.abs(change), digits)}`,
    direction: up ? 'up' : 'down',
    good: up === higherIsBetter,
  };
}
