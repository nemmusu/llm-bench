import type { DataTableColumnMeta } from '../ui/data-table';

/** Numeric columns of the configuration tables: right-aligned figures, a little tighter (many columns). */
export const NUMERIC: DataTableColumnMeta = { numeric: true, className: 'px-2' };

/**
 * "Generazione (tok/s)" as a table header: the name, and its unit quieter on a second line (narrow
 * numeric columns). What follows the unit stays with it: "Generazione (tok/s) a 32K" reads
 * "Generazione" over "(tok/s) a 32K".
 */
export function UnitHeader({ text, nowrap }: { text: string; nowrap?: boolean }) {
  const m = /^(.*\S)\s+\(([^()]+)\)(.*)$/.exec(text);
  if (!m) return <>{text}</>;
  // The name may wrap ("Lettura / prompt"): many columns share the width of a laptop screen. Over a
  // column of short numbers (VRAM) it stays on one line instead of standing three lines tall.
  return (
    <span className="inline-flex flex-col leading-4">
      <span className={nowrap ? 'whitespace-nowrap' : 'whitespace-normal'}>{m[1]}</span>
      <span className="text-[11px] font-normal text-fg-3">({m[2]})</span>
      {/* Where the numbers were measured ("al contesto massimo", "a 32K") on a line of its own, over a column of short numbers. */}
      {m[3] && <span className="text-[11px] font-normal text-fg-3">{m[3]}</span>}
    </span>
  );
}
