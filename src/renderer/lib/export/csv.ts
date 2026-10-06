/**
 * CSV exports of one run, in "long" form (one measurement per row) so a spreadsheet can filter
 * and pivot it. Two dialects:
 *  - excel-it: `;` separator, decimal comma, UTF-8 BOM (Excel with Italian regional settings
 *    opens it correctly with a double click);
 *  - standard: `,` separator, decimal point, no BOM (RFC 4180).
 */
import type { RunResult, Stat } from '../../../contract/results';
import { engineLabelOf, modelLabelOf } from '../../components/bench/format';
import { noteText } from '../../components/bench/notes';
import type { Formatters } from '../../i18n';

export type CsvStyle = 'excel-it' | 'standard';
export type CsvCell = string | number | undefined;

const BOM = '﻿';
const EOL = '\r\n';

/** Plain number without grouping; at most 4 decimals; decimal comma for excel-it. */
export function csvNumber(n: number, style: CsvStyle): string {
  const text = String(Math.round(n * 10_000) / 10_000);
  return style === 'excel-it' ? text.replace('.', ',') : text;
}

/** One cell: numbers per dialect, text quoted when needed and neutralized against formula injection. */
export function csvCell(value: CsvCell, style: CsvStyle): string {
  if (value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? csvNumber(value, style) : '';
  const sep = style === 'excel-it' ? ';' : ',';
  // A leading = + - @ (or tab/CR) would make a spreadsheet evaluate the text as a formula.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return safe.includes(sep) || /["\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[], style: CsvStyle): string {
  const sep = style === 'excel-it' ? ';' : ',';
  const lines = [header, ...rows].map((r) => r.map((c) => csvCell(c, style)).join(sep));
  return (style === 'excel-it' ? BOM : '') + lines.join(EOL) + EOL;
}

/** Section, metric, prompt tokens, users, value, min, max, stddev, CV, N, unit. */
type Row = [string, string, number | undefined, number | undefined, CsvCell, CsvCell, CsvCell, CsvCell, CsvCell, CsvCell, string];

const statRow = (section: string, metric: string, s: Stat, unit: string, prompt?: number, users?: number): Row => [
  section,
  metric,
  prompt,
  users,
  s.median,
  s.min,
  s.max,
  s.stddev,
  s.cv,
  s.n,
  unit,
];

const valueRow = (section: string, metric: string, value: CsvCell, unit = '', prompt?: number, users?: number): Row => [
  section,
  metric,
  prompt,
  users,
  value,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  unit,
];

/** Every measurement of the run as rows. */
export function csvRows(run: RunResult, f: Pick<Formatters, 't' | 'integer' | 'number' | 'percent'>): Row[] {
  const { t } = f;
  const m = run.metrics;
  const gpu = run.hardware.gpus[0];
  const info = t('export.csv.sectionRun');
  const rows: Row[] = [
    valueRow(info, t('export.csv.id'), run.id),
    valueRow(info, t('results.columns.date'), run.createdAt),
    valueRow(info, t('results.columns.status'), t(`result.status.${run.status}`)),
    valueRow(info, t('results.columns.profile'), t(`benchmark.profiles.${run.scenario.profile}`)),
    valueRow(info, t('results.columns.model'), modelLabelOf(run.model)),
    valueRow(info, 'sha256', run.model.sha256),
    valueRow(info, t('results.columns.engine'), engineLabelOf(run.engine)),
    valueRow(info, t('results.columns.gpu'), gpu?.name),
    valueRow(info, t('result.details.driver'), gpu?.driverVersion),
    valueRow(info, t('result.details.host'), run.hardware.hostLabel),
    valueRow(info, 'GPU Bench', run.app.version),
  ];
  if (run.error) rows.push(valueRow(info, t('export.csv.error'), `${run.error.code}: ${run.error.message}`));

  const lat = t('result.details.latency');
  for (const p of m.latency) {
    const at = (metric: string, s: Stat, unit: string) => rows.push(statRow(lat, metric, s, unit, p.promptTokens));
    at(t('metrics.ttft.label'), p.ttftMs, 'ms');
    at(t('metrics.prefill.label'), p.prefillTps, 'tok/s');
    if (p.prefillTpsEngine) at(`${t('metrics.prefill.label')} (${t('export.csv.engineSide')})`, p.prefillTpsEngine, 'tok/s');
    at(t('metrics.decode.label'), p.decodeTps, 'tok/s');
    if (p.decodeTpsEngine) at(`${t('metrics.decode.label')} (${t('export.csv.engineSide')})`, p.decodeTpsEngine, 'tok/s');
    at(t('export.csv.total'), p.totalMs, 'ms');
    rows.push(valueRow(lat, t('result.details.itlP50'), p.itlP50Ms, 'ms', p.promptTokens));
    rows.push(valueRow(lat, t('result.details.itlP95'), p.itlP95Ms, 'ms', p.promptTokens));
  }

  const load = t('result.details.load');
  if (m.load.coldMs) rows.push(statRow(load, t('result.details.cold'), m.load.coldMs, 'ms'));
  if (m.load.warmMs) rows.push(statRow(load, t('result.details.warm'), m.load.warmMs, 'ms'));
  if (m.load.containerOverheadMs) rows.push(statRow(load, t('result.details.container'), m.load.containerOverheadMs, 'ms'));
  if (m.load.coldReadBytesPerSec !== undefined) rows.push(valueRow(load, t('result.details.diskRead'), m.load.coldReadBytesPerSec / 1e6, 'MB/s'));
  if (m.firstTokenAfterLoadMs !== undefined) rows.push(valueRow(load, t('result.details.firstToken'), m.firstTokenAfterLoadMs, 'ms'));

  const conc = t('result.details.concurrency');
  for (const c of m.concurrency) {
    rows.push(valueRow(conc, t('result.aggregate'), c.aggregateTps, 'tok/s', undefined, c.level));
    rows.push(valueRow(conc, t('result.perUser'), c.perRequestDecodeTpsP50, 'tok/s', undefined, c.level));
    rows.push(valueRow(conc, t('result.details.ttftP50'), c.ttftP50Ms, 'ms', undefined, c.level));
    rows.push(valueRow(conc, t('result.details.ttftP95'), c.ttftP95Ms, 'ms', undefined, c.level));
    rows.push(valueRow(conc, t('result.details.errors'), c.errors, '', undefined, c.level));
  }

  for (const b of m.llamaBench) rows.push([t('result.details.llamaBench'), b.test, undefined, undefined, b.tps, undefined, undefined, b.stddev, undefined, undefined, 'tok/s']);

  const vram = t('metrics.vramPeak.label');
  const v = m.vram;
  for (const [label, value] of [
    [t('result.details.vramBaseline'), v.baselineMiB],
    [t('result.details.vramPeakTotal'), v.peakMiB],
    [t('result.details.vramDelta'), v.deltaMiB],
    [t('result.details.vramProcess'), v.processPeakMiB],
    [t('result.details.vramEstimate'), v.estimateMiB],
  ] as const) {
    if (value !== undefined) rows.push(valueRow(vram, label, value, 'MiB'));
  }

  const energy = t('result.details.energy');
  if (m.energy.avgPowerW !== undefined) rows.push(valueRow(energy, t('metrics.avgPower.label'), m.energy.avgPowerW, 'W'));
  if (m.energy.maxPowerW !== undefined) rows.push(valueRow(energy, t('result.details.maxPower'), m.energy.maxPowerW, 'W'));
  if (m.energy.tokensPerJoule !== undefined) rows.push(valueRow(energy, t('metrics.efficiency.label'), m.energy.tokensPerJoule, 'tok/J'));
  if (m.thermals.maxTempC !== undefined) rows.push(valueRow(energy, t('result.details.maxTemp'), m.thermals.maxTempC, '°C'));
  if (m.score) rows.push(valueRow(info, t('metrics.score.label'), m.score.value));

  const notes = t('result.validityTitle');
  for (const flag of run.validity) rows.push(valueRow(notes, t(`validity.${flag}.title`), flag));
  for (const n of run.notes) rows.push(valueRow(notes, noteText(n, f).title, n.code));
  return rows;
}

export function csvHeader(f: Pick<Formatters, 't'>): string[] {
  const { t } = f;
  return [
    t('export.csv.section'),
    t('result.details.measure'),
    t('export.csv.prompt'),
    t('result.users'),
    t('export.csv.value'),
    t('result.details.min'),
    t('result.details.max'),
    t('export.csv.stddev'),
    t('result.details.cv'),
    t('result.details.n'),
    t('export.csv.unit'),
  ];
}

export function runToCsv(run: RunResult, f: Pick<Formatters, 't' | 'integer' | 'number' | 'percent'>, style: CsvStyle): string {
  return toCsv(csvHeader(f), csvRows(run, f), style);
}
