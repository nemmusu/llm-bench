/**
 * The echarts mock of the benchmark-flow tests keeps every option it is given, so tests can call
 * the formatters (tooltips, labels) the screens put in them.
 */
export interface Captured {
  options: Record<string, unknown>[];
}

type Fn = (...args: unknown[]) => unknown;

/** Calls every formatter-like function found in an option with plausible arguments. */
export function exerciseFormatters(option: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown, key: string) => {
    if (typeof node === 'function') {
      const fn = node as Fn;
      if (key === 'formatter') {
        // Axis-tooltip formatters get the hovered points; label formatters a value or a param object.
        const points = [0, 1, 2].map((i) => ({ seriesIndex: i, data: [1, 50] }));
        const gaps = [0, 1, 2].map((i) => ({ seriesIndex: i, data: [1, null] }));
        for (const arg of [points, gaps, 3, { value: [4, 40] }]) {
          try {
            out.push(String(fn(arg)));
          } catch {
            /* not this shape */
          }
        }
      } else if (key === 'valueFormatter') {
        out.push(String(fn(12)));
      }
      return;
    }
    if (Array.isArray(node)) node.forEach((n) => visit(n, key));
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) visit(v, k);
  };
  visit(option, '');
  return out;
}
