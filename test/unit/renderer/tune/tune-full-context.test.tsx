/**
 * "Trova le impostazioni migliori" read at the context full: every speed of a one-user combination is
 * the one measured with its largest context full. The real NInfer run of the report (saved before the
 * search measured the context full first: nothing measured beyond 64K of 256K, the time ran out after
 * 17 starts of ~1,5 min each) must read coherently with what it has; a run of the new shape shows its
 * full-context numbers everywhere.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runResultSchema, type RunResult, type Tuning } from '../../../../src/contract/results';
import { loadTime } from '../../../../src/renderer/components/tune/tune-format';
import {
  capacityAtLeast,
  drawnPoints,
  launchedCapacity,
  limitFound,
  medianLoadSeconds,
  rankAtMax,
  recommendedIndex,
  sameLargestContext,
} from '../../../../src/renderer/components/tune/tune-logic';
import { capacitySentence } from '../../../../src/renderer/components/tune/tune-format';
import { glossaryTerms, PartialBadge } from '../../../../src/renderer/components/tune/tune-sections';
import { createFormatters } from '../../../../src/renderer/i18n';
import { renderApp, renderUi } from '../helpers';
import { seededRuns } from '../bench/fixtures';
import { benchApi } from '../bench/world';
import { attempt, combo, params, point, tunedRun, users } from './tune-fixtures';

const charts = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({ setOption: vi.fn((o: Record<string, unknown>) => charts.options.push(o)), resize: vi.fn(), dispose: vi.fn() })),
}));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});
afterEach(() => {
  charts.options.length = 0;
});

const K = 1024;
const f = createFormatters('it');
const FILE = path.resolve(import.meta.dirname, '../../../fixtures/runs/tune/2026-10-14_11-54-04_01M4X46BTJW9EH2YHE32Q7N9ZM.json');
/** The real run, sanitized (user paths, host), as LLM Bench 0.4.0 saved it. */
const real = (): RunResult => runResultSchema.parse(JSON.parse(readFileSync(FILE, 'utf8')));

const h1 = () => screen.findByRole('heading', { level: 1 });
const ranking = () => screen.getByRole('table', { name: /^Classifica delle combinazioni a/ });
const rankRows = () => within(ranking()).getAllByRole('row').filter((r) => r.hasAttribute('aria-label'));
const compareAt = (name: string) => userEvent.click(within(screen.getByRole('radiogroup', { name: 'Confronta a' })).getByRole('radio', { name }));

function open(run: RunResult) {
  const api = benchApi({ runs: [...seededRuns(), run] });
  return { ...renderApp(`/results/${run.id}`, api), api };
}

interface ChartOption {
  xAxis: { data: string[] };
  series: { name: string; data: (number | null)[]; markLine?: unknown }[];
  tooltip: { formatter: (params: unknown) => string };
}
const lastChart = () => charts.options.at(-1) as unknown as ChartOption;
/** The tooltip of the last chart at one depth (index), as plain text. */
function tooltipAt(index: number): string {
  const o = lastChart();
  const params = o.series.map((s, i) => ({ seriesIndex: i, dataIndex: index, seriesName: s.name, color: '#000', value: s.data[index] }));
  return o.tooltip.formatter(params).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('the real NInfer search that ran out of time (saved before the context full was measured)', () => {
  it('sums up without a speed from another depth as the headline, and says why the time ran out', async () => {
    const { router } = open(real());
    await h1();
    expect(
      screen.getByText(/^Con cache rk8v4 arrivi a 256K\. Al contesto massimo \(256K\) la velocità non è stata misurata\. Misurata solo fino a 64K: lì la più veloce a scrivere è cache KV rk8v4.* \(83,0 tok\/s a 64K\)\.$/),
    ).toBeTruthy();
    expect(screen.getByText('Mi sono fermato prima: tempo finito')).toBeTruthy();
    expect(screen.getByText('Ogni avvio del motore ha richiesto in media 1 min 36 s.')).toBeTruthy();
    expect(screen.getByText(/^Il motore \(Docker o WSL\) legge il modello da una cartella di Windows/)).toBeTruthy();

    const rec = screen.getByRole('region', { name: 'Combinazione consigliata' });
    expect(within(rec).getByText('256K')).toBeTruthy();
    expect(within(rec).getByText('Generazione al contesto massimo (256K)')).toBeTruthy();
    expect(within(rec).getAllByText('non misurata')).toHaveLength(3);
    expect(within(rec).queryByText(/tok\/s/)).toBeNull();
    expect(within(rec).getByText('Misurata solo fino a 64K (tempo finito): rifai la ricerca per avere la velocità a 256K.')).toBeTruthy();

    // The way forward: the engines page, where the model can be moved.
    await userEvent.click(screen.getByRole('button', { name: 'Apri Motori' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
  });

  it('ranks at the largest context: no number from another depth, each row says where it was not measured', async () => {
    open(real());
    await h1();
    expect(ranking().querySelector('caption')!.textContent).toBe('Classifica delle combinazioni al contesto massimo');
    const rows = rankRows();
    expect(rows.map((r) => /Cache KV (\w+)/.exec(r.getAttribute('aria-label')!)![1])).toEqual(['rk8v4', 'nvfp4', 'int8', 'bf16']);
    expect(within(rows[0]!).getByText('Consigliata')).toBeTruthy();
    expect(rows.map((r) => within(r).getByText(/^non misurata a/).textContent)).toEqual(['non misurata a 256K', 'non misurata a 256K', 'non misurata a 128K', 'non misurata a 64K']);
    expect(within(ranking()).queryByText('il migliore', { exact: false })).toBeNull();
    expect(within(ranking()).queryByText(/arriva solo/)).toBeNull();

    // At 64K: int8 (128K) and bf16 (64K) hold that much, they were simply not measured there.
    await compareAt('64K');
    const at64 = rankRows();
    expect(screen.getByRole('columnheader', { name: /^Generazione \(tok\/s\) a 64K/ })).toBeTruthy();
    expect(at64[0]!.textContent).toContain('83,0');
    expect(at64[1]!.textContent).toContain('74,7');
    expect(within(at64[2]!).getByText('non misurata a 64K')).toBeTruthy();
    expect(within(at64[3]!).getByText('non misurata a 64K')).toBeTruthy();
  });

  it('the chart reaches the contexts launched, partial lines end where measured, the tooltip says "non misurata"', async () => {
    open(real());
    await h1();
    await waitFor(() => expect(charts.options.length).toBeGreaterThan(0));
    const o = lastChart();
    expect(o.xAxis.data).toEqual(['1K', '64K', '128K', '256K']);
    expect(o.series.map((s) => s.data)).toEqual([
      [expect.closeTo(84.9, 1), expect.closeTo(83, 1), null, null],
      [expect.closeTo(122.4, 1), expect.closeTo(74.7, 1), null, null],
      [expect.closeTo(59.6, 1), null, null, null],
      [expect.closeTo(71, 1), null, null, null],
    ]);
    expect(o.series[0]!.markLine).toBeUndefined();
    const at256 = tooltipAt(3);
    expect(at256).toContain('a 262.144 token di contesto · Generazione');
    expect(at256.match(/non misurata/g)).toHaveLength(2);
    expect(at256).toContain('arriva solo a 128K');
    expect(at256).toContain('arriva solo a 64K');
    expect(tooltipAt(1)).toMatch(/83,0 tok\/s .*74,7 tok\/s .*non misurata .*non misurata/);
    await userEvent.click(screen.getAllByRole('button', { name: 'Mostra tabella' })[0]!);
    const table = screen.getByRole('table', { name: /Velocità al crescere del contesto/ });
    expect(within(table).getAllByRole('row')[3]!.textContent).toMatch(/59,6non misuratanon misurataarriva solo a 128K$/);
  });

  it('capacity: "almeno" where the contexts in between were never tried; a type launched later is not "deduced"', async () => {
    open(real());
    await h1();
    const capacity = screen.getByRole('table', { name: 'Contesto massimo per tipo di cache' });
    expect(within(capacity).getAllByRole('row').map((r) => r.textContent)).toEqual([
      'Cache KVStima (token)Massimo trovato (token)Note',
      'bf16159,8Kalmeno 64KAlmeno 64K: a 118K non entra più, in mezzo non provato.',
      'int8256Kalmeno 128KAlmeno 128K: a 236K non entra più, in mezzo non provato.',
      'rk8v4256K256KArriva al contesto massimo del modello.',
      'nvfp4256K256KArriva al contesto massimo del modello.',
    ]);
  });

  it('the glossary has the words of NInfer’s settings only; dropped launches say the depth of their numbers', async () => {
    open(real());
    await h1();
    const glossary = screen.getByText('Cosa vogliono dire:').parentElement!;
    expect(glossary.textContent).toBe('Cosa vogliono dire:Cache KVContestoDecodifica speculativaRAM condivisa');
    await userEvent.click(screen.getByRole('button', { name: /Prove scartate/ }));
    // The sweep launch that failed: its 1K, 4K and 16K numbers, said at 16K (not at its 256K context).
    expect(screen.getByText(/^contesto 256K · con il contesto riempito a 16K: generazione [\d,]+ tok\/s, lettura [\d.]+ tok\/s · VRAM picco/)).toBeTruthy();
  });
});

/** A search of the new shape: every combination measured with its context full first. */
function fullTuning(): Partial<Tuning> {
  const q8 = combo('q8_0', 256 * K, [point(K, 60, 2000), point(64 * K, 50, 1900), point(128 * K, 45, 1700), point(261_200, 40, 1500)], { vramPeakMiB: 30_000 });
  const q4 = combo('q4_0', 256 * K, [point(K, 62, 2100), point(64 * K, 51, 1950), point(128 * K, 44, 1600), point(262_000, 39.5, 1400)]);
  // A text prompt refused as too long and sent again shorter: still the context full.
  const short = combo('q8_0', 256 * K, [point(K, 58, 1900), point(240_000, 38, 1300)], { partial: 'budget', params: params({ ubatchSize: 1024 }) });
  const f16 = combo('f16', 128 * K, [point(K, 70, 2400), point(64 * K, 55, 2200), point(130_900, 48, 2000)]);
  const cut = combo('q4_0', 256 * K, [point(K, 61, 2000), point(64 * K, 50, 1900)], { partial: 'budget', params: params({ ubatchSize: 2048 }) });
  return {
    stoppedBy: 'budget',
    limitSeconds: 600,
    expectedLoadSeconds: 15,
    combinations: [q8, q4, short, f16, cut],
    recommended: 0,
    fastestByDepth: [],
    depths: [K, 64 * K, 128 * K, 256 * K],
    capacity: [
      { kvType: 'q8_0', predictedMax: 256 * K, measuredMax: 256 * K, inferred: false, bound: 'model' },
      { kvType: 'f16', predictedMax: 140 * K, measuredMax: 128 * K, inferred: false, bound: 'found', failedAt: 136 * K },
      { kvType: 'q4_0', predictedMax: 256 * K, measuredMax: 256 * K, inferred: true, skipped: 'no-gain', bound: 'model' },
    ],
    attempts: [attempt('capacity', 'q8_0', 256 * K, 'ok', { loadMs: 20_000 }), attempt('capacity', 'f16', 136 * K, 'oom', { loadMs: 30_000 })],
    fidelity: undefined,
  };
}

describe('a search of the new shape (the context full measured first)', () => {
  it('every view reads the speeds with the context full, the exact tokens on hover', async () => {
    open(tunedRun(fullTuning()));
    await h1();
    expect(screen.getByText('Con cache q8_0 arrivi a 256K, il doppio di f16 (128K). Al contesto massimo (256K) la più veloce a scrivere è cache KV q8_0: 40,0 tok/s.')).toBeTruthy();
    expect(screen.getByText('Ogni avvio del motore ha richiesto in media 25 s; ne erano previsti 15 s.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apri Motori' })).toBeNull();
    const rec = screen.getByRole('region', { name: 'Combinazione consigliata' });
    expect(within(rec).getByText('40,0 tok/s').getAttribute('title')).toBe('a 261.200 token di contesto');
    expect(within(rec).getByText('1.500 tok/s')).toBeTruthy();
    expect(within(rec).getByText('174,13 s')).toBeTruthy();

    // Largest context first, the recommendation on top, ties only between rows with the same context.
    const rows = rankRows();
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Cache KV q8_0 · flash attention',
      'Cache KV q4_0 · flash attention',
      'Cache KV q8_0 · flash attention · ub 1024',
      'Cache KV f16 · flash attention',
      'Cache KV q4_0 · flash attention · ub 2048',
    ]);
    expect(rows.map((r) => r.querySelector('td')!.textContent)).toEqual(['1', '≈ pari merito con la riga sopra2', '3', '4', '–']);
    expect(within(rows[0]!).getAllByText('il migliore', { exact: false }).length).toBeGreaterThan(0);
    // f16 writes faster at its 128K, but that does not compare with 256K.
    expect(within(rows[3]!).queryByText('il migliore', { exact: false })).toBeNull();
    expect(within(rows[2]!).getByText('38,0').closest('td')!.getAttribute('title')).toBe('a 240.000 token di contesto');
    expect(within(rows[4]!).getByText('non misurata a 256K')).toBeTruthy();

    // The chart: the full points on their context, the shortened one too, its exact tokens in the tooltip.
    await waitFor(() => expect(charts.options.length).toBeGreaterThan(0));
    expect(lastChart().xAxis.data).toEqual(['1K', '64K', '128K', '256K']);
    const at256 = tooltipAt(3);
    expect(at256).toContain('40,0 tok/s (contesto pieno: 261.200 token)');
    expect(at256).toContain('38,0 tok/s (contesto pieno: 240.000 token)');
    expect(at256).toContain('arriva solo a 128K');
    expect(at256).toContain('non misurata');
    await userEvent.click(screen.getAllByRole('button', { name: 'Mostra tabella' })[0]!);
    expect(screen.getByRole('table', { name: /Velocità al crescere del contesto/ }).textContent).toContain('40,0 (contesto pieno: 261.200 token)');

    // A refined limit is "found"; a type never launched is still deduced.
    const capacity = screen.getByRole('table', { name: 'Contesto massimo per tipo di cache' });
    expect(capacity.textContent).toContain('Limite trovato: a 136K non entra più.');
    expect(capacity.textContent).toContain('Dedotto senza avviare il motore');
    expect(screen.getByText('Cosa vogliono dire:').parentElement!.textContent).toBe('Cosa vogliono dire:Cache KVContestoFlash attentionub / b');
  });

  it('at one depth: "arriva solo a" a smaller context, "non misurata a" one large enough; the chart marks it', async () => {
    open(tunedRun(fullTuning()));
    await h1();
    await compareAt('256K');
    const rows = rankRows();
    expect(screen.getByRole('columnheader', { name: /^Generazione \(tok\/s\) a 256K/ })).toBeTruthy();
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('40,0'),
      expect.stringContaining('39,5'),
      // Not measured there, deepest first: the shortened full prompt (240.000 tokens), f16, the one cut at 64K.
      expect.stringContaining('non misurata a 256K'),
      expect.stringContaining('arriva solo a 128K'),
      expect.stringContaining('non misurata a 256K'),
    ]);
    await waitFor(() => expect(lastChart().series[0]!.markLine).toBeTruthy());
  });

  it('a preset quotes the speed its row is compared on: with the context full, else none', async () => {
    open(tunedRun(fullTuning()));
    await h1();
    await userEvent.click(await within(rankRows()[0]!).findByRole('button', { name: 'Usa questo preset' }));
    expect((await screen.findByRole('region', { name: 'Preset' })).textContent).toContain('scrive 40 tok/s a 256K token, 256K di contesto');
  });

  it('a row never measured with its context full quotes no speed', async () => {
    open(tunedRun(fullTuning()));
    await h1();
    await userEvent.click(await within(rankRows()[4]!).findByRole('button', { name: 'Usa questo preset' }));
    const banner = await screen.findByRole('region', { name: 'Preset' });
    expect(banner.textContent).toContain('256K di contesto');
    expect(banner.textContent).not.toContain('tok/s');
  });

  it('"Più utenti": a partly measured configuration says so without a context to speak of', async () => {
    const shared = combo('q8_0', 32 * K, [], { params: params({ kvCacheType: 'q8_0', contextSize: 32 * K, parallel: 4 }), concurrency: [users(1), users(4)], partial: 'budget' });
    const run = tunedRun({ goal: 'multi', multi: { users: 4, perUserContext: 8 * K, promptTokens: 8000, outputTokens: 128, turns: 3 }, combinations: [shared], recommended: 0, capacity: [] });
    open(run);
    await h1();
    const badge = within(screen.getByRole('table', { name: 'Classifica delle configurazioni con 4 utenti' })).getByText('Misurata in parte (tempo finito)');
    await userEvent.hover(badge);
    await waitFor(() => expect(screen.getAllByText(/^La ricerca si è fermata prima di finire questa combinazione/).length).toBeGreaterThan(0));
  });
});

describe('the pieces, one by one', () => {
  it('"Misurata in parte" says what is missing', async () => {
    const full = combo('q8_0', 64 * K, [point(64 * K - 144, 50, 1000)]);
    const { unmount } = renderUi(<PartialBadge why="budget" combo={full} />);
    await userEvent.hover(screen.getByText('Misurata in parte (tempo finito)'));
    await waitFor(() => expect(screen.getAllByText(/^Misurata con il suo contesto massimo pieno \(64K\), ma la ricerca/).length).toBeGreaterThan(0));
    unmount();
    renderUi(<PartialBadge why="launches" combo={combo('q8_0', 64 * K, [point(K, 50, 1000)])} />);
    await userEvent.hover(screen.getByText('Misurata in parte (troppe prove)'));
    await waitFor(() => expect(screen.getAllByText(/^La ricerca si è fermata prima di misurare questa combinazione con il suo contesto massimo pieno \(64K\)/).length).toBeGreaterThan(0));
  });

  it('the ranking at the largest context: the recommendation first in its group, ties only within a context', () => {
    const fast = combo('q8_0', 64 * K, [point(64 * K - 144, 50, 1000)]);
    const same = combo('q4_0', 32 * K, [point(32 * K - 144, 49.8, 1000)]);
    const cut = combo('q4_0', 64 * K, [point(K, 90, 1000)]);
    const rows = rankAtMax({ combinations: [cut, same, fast, combo('f16', 8 * K, [])], recommended: 0 });
    expect(rows.map((r) => [r.index, r.rank, r.tie])).toEqual([
      [2, 1, undefined],
      // 49,8 against 50: within the noise, but at a smaller context: no tie.
      [1, 2, undefined],
      [0, undefined, undefined],
    ]);
    expect(sameLargestContext(rows).map((r) => r.index)).toEqual([2, 0]);
    // Without a recommendation, two not measured that far with the same context keep their order.
    expect(rankAtMax({ combinations: [cut, cut, combo('q8_0', 128 * K, [point(K, 1, 1)])], recommended: undefined }).map((r) => r.index)).toEqual([2, 0, 1]);
    expect(sameLargestContext([])).toEqual([]);
  });

  it('the recommendation without the core’s pick prefers those measured with the context full', () => {
    const deepOnly = combo('q8_0', 64 * K, [point(32 * K, 90, 1000)]);
    const full = combo('q4_0', 64 * K, [point(64 * K - 144, 50, 1000)]);
    expect(recommendedIndex({ combinations: [deepOnly, full], recommended: undefined })).toBe(1);
    expect(recommendedIndex({ combinations: [deepOnly, combo('f16', 64 * K, [point(32 * K, 80, 1000)])], recommended: undefined })).toBe(0);
  });

  it('points drawn on the context: the full one replaces a grid point there', () => {
    const c = combo('q8_0', 64 * K, [point(K, 1, 1), point(64 * K - 144, 2, 2)]);
    expect([...drawnPoints(c).keys()]).toEqual([K, 64 * K]);
    expect([...drawnPoints(combo('q8_0', 256 * K, [point(K, 1, 1), point(240_000, 2, 2)])).entries()].map(([d, p]) => [d, p.promptTokens])).toEqual([
      [K, K],
      [256 * K, 240_000],
    ]);
  });

  it('capacity as the saved fields say it', () => {
    const base = { kvType: 'int8' as const, inferred: false };
    expect(limitFound({ ...base, measuredMax: 128 * K, bound: 'found', failedAt: 136 * K })).toBe(true);
    expect(limitFound({ ...base, measuredMax: 128 * K, bound: 'found', failedAt: 236 * K })).toBe(false);
    expect(limitFound({ ...base, measuredMax: 32 * K, bound: 'found', failedAt: 40 * K })).toBe(true);
    expect(capacityAtLeast({ ...base, measuredMax: 128 * K, bound: 'found', failedAt: 236 * K })).toBe(true);
    expect(capacityAtLeast({ ...base, bound: 'budget' })).toBe(false);
    expect(capacityAtLeast({ ...base, measuredMax: 128 * K, bound: 'model' })).toBe(false);
    // The best one only "almeno": no comparison; the next one only "almeno": none either.
    expect(capacitySentence({ capacity: [{ ...base, measuredMax: 128 * K, bound: 'found', failedAt: 236 * K }, { ...base, kvType: 'bf16', measuredMax: 64 * K, bound: 'found', failedAt: 72 * K }] }, f)).toBe(
      'Con cache int8 arrivi almeno a 128K.',
    );
    expect(capacitySentence({ capacity: [{ ...base, measuredMax: 256 * K, bound: 'model' }, { ...base, kvType: 'bf16', measuredMax: 64 * K, bound: 'found', failedAt: 118 * K }] }, f)).toBe(
      'Con cache int8 arrivi a 256K.',
    );
    const t = { capacity: [{ ...base, measuredMax: 64 * K, inferred: true }, { ...base, kvType: 'q4_0' as const, measuredMax: 64 * K, inferred: true }], attempts: [attempt('variant', 'int8', 64 * K, 'ok')] };
    expect(launchedCapacity(t).map((c) => c.inferred)).toEqual([false, true]);
  });

  it('engine starts: the median, said to the second', () => {
    expect(medianLoadSeconds([])).toBeUndefined();
    expect(medianLoadSeconds([{ loadMs: 10_000 }, {}, { loadMs: 30_000 }, { loadMs: 20_000 }, { loadMs: 40_000 }])).toBe(25);
    expect(medianLoadSeconds([{ loadMs: 95_545 }])).toBeCloseTo(95.545);
    expect(loadTime(0.2, f)).toBe('1 s');
    expect(loadTime(15, f)).toBe('15 s');
    expect(loadTime(95.545, f)).toBe('1 min 36 s');
  });

  it('the glossary words of each engine’s settings', () => {
    const vllm = (over: Parameters<typeof params>[0]) => ({ ...combo('auto', 32 * K, []), params: params(over) });
    const t = { combinations: [vllm({ extraArgs: ['--max-num-batched-tokens', '8192'] }), vllm({ extraArgs: ['--enforce-eager'] }), { ...vllm({}), tags: ['draft' as const] }], attempts: [] };
    expect(glossaryTerms('vllm-docker', t)).toEqual(['kv', 'context', 'batchTokens', 'eager', 'speculative']);
    const llama = { combinations: [{ ...combo('q8_0', 32 * K, []), params: params({ extraArgs: ['--n-cpu-moe', '8'] }) }], attempts: [attempt('capacity', 'q8_0', 64 * K, 'spill')] };
    // Its launch had flash attention on (the attempts' labels count too).
    expect(glossaryTerms('llamacpp-native', llama)).toEqual(['kv', 'context', 'fa', 'offload', 'shared']);
    const tagged = { combinations: [{ ...combo('q8_0', 32 * K, []), params: params(), tags: ['cpu-offload' as const, 'eager' as const] }], attempts: [] };
    expect(glossaryTerms('llamacpp-native', tagged)).toEqual(['kv', 'context', 'eager', 'offload']);
    const draft = { combinations: [{ ...combo('q8_0', 32 * K, []), params: params({ extraArgs: ['--draft-max', '8'] }) }], attempts: [] };
    expect(glossaryTerms('llamacpp-native', draft)).toEqual(['kv', 'context', 'speculative']);
  });
});
