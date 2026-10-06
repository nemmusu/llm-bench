/** Export formats of one run, and of a selection of runs (.gpubench bundle). */
import type { RunResult } from '../../../contract/results';
import { slug } from '../../components/bench/format';
import type { Formatters } from '../../i18n';
import { runToCsv } from './csv';
import { reportToHtml } from './html';
import { reportToMarkdown } from './markdown';
import { reportOf } from './report';
import type { SaveRequest } from './save';

export const EXPORT_FORMATS = ['csvIt', 'csv', 'json', 'markdown', 'html'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const EXT: Record<ExportFormat, { ext: string; mime: string; name: string }> = {
  csvIt: { ext: 'csv', mime: 'text/csv;charset=utf-8', name: 'CSV' },
  csv: { ext: 'csv', mime: 'text/csv;charset=utf-8', name: 'CSV' },
  json: { ext: 'json', mime: 'application/json', name: 'JSON' },
  markdown: { ext: 'md', mime: 'text/markdown;charset=utf-8', name: 'Markdown' },
  html: { ext: 'html', mime: 'text/html;charset=utf-8', name: 'HTML' },
};

/** "gpubench_Qwen3-8B-Q4_K_M_2026-10-06_01K6Y7Q2.csv" */
export function exportFileName(run: Pick<RunResult, 'id' | 'createdAt' | 'model'>, ext: string): string {
  return `gpubench_${slug(run.model.displayName)}_${run.createdAt.slice(0, 10)}_${run.id.slice(0, 8)}.${ext}`;
}

export function exportContent(run: RunResult, format: ExportFormat, f: Formatters): string {
  const labels = { powershell: f.t('codeblock.powershell'), bash: f.t('codeblock.bash') };
  switch (format) {
    case 'csvIt':
      return runToCsv(run, f, 'excel-it');
    case 'csv':
      return runToCsv(run, f, 'standard');
    case 'json':
      return `${JSON.stringify(run, null, 2)}\n`;
    case 'markdown':
      return reportToMarkdown(reportOf(run, f), labels);
    case 'html':
      return reportToHtml(reportOf(run, f), { lang: f.lang, labels });
  }
}

export function exportRequest(run: RunResult, format: ExportFormat, f: Formatters): SaveRequest {
  const { ext, mime, name } = EXT[format];
  return { defaultName: exportFileName(run, ext), content: exportContent(run, format, f), mime, filters: [{ name, extensions: [ext] }] };
}

/** The .gpubench bundle returned by POST /api/runs/export, ready to save. */
export function bundleRequest(bundle: unknown, now: Date): SaveRequest {
  return {
    defaultName: `gpubench_${now.toISOString().slice(0, 10)}.gpubench`,
    content: `${JSON.stringify(bundle, null, 2)}\n`,
    mime: 'application/json',
    filters: [{ name: 'GPU Bench', extensions: ['gpubench'] }],
  };
}
