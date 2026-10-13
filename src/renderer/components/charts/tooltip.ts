/**
 * Tooltips that say what a number was measured on: a first line with the context ("a 32.768 token di
 * contesto") and then one line per series, or one plain sentence. Text is escaped: model names and
 * settings come from files.
 */
import type { ChartTokens } from './echarts';

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface TooltipRow {
  name: string;
  value: string;
  /** Series color (a small dot before the name). */
  color?: string;
}

/** A bold head and one "name ……… value" line per row. */
export function tooltipHtml(tk: ChartTokens, head: string, rows: readonly TooltipRow[]): string {
  const lines = rows
    .map(
      (r) =>
        `<div style="display:flex;gap:12px;justify-content:space-between;align-items:center"><span style="color:${tk.fg2}">${
          r.color ? `<span style="display:inline-block;width:8px;height:8px;border-radius:4px;margin-right:6px;background:${r.color}"></span>` : ''
        }${escapeHtml(r.name)}</span><b>${escapeHtml(r.value)}</b></div>`,
    )
    .join('');
  return `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(head)}</div>${lines}`;
}

/** One sentence ("a 32.768 token di contesto: scrittura 54,6 tok/s, lettura 2.244 tok/s"). */
export function tooltipSentence(text: string): string {
  return `<div style="max-width:320px;white-space:normal">${escapeHtml(text)}</div>`;
}

/** What ECharts passes to an axis tooltip formatter (the fields used here). */
export interface AxisParam {
  dataIndex: number;
  seriesName: string;
  color: string;
  value: unknown;
}

/** The y value of an axis tooltip parameter: a plain number, or the second item of [x, y]. */
export function yOf(value: unknown): number | null {
  const v = Array.isArray(value) ? value[1] : value;
  return v === null || v === undefined ? null : Number(v);
}
