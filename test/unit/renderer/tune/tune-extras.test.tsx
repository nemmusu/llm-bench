/** The tune feature outside its own pages: results list, server dialog, servers panel, normal results with a sweep and per-user numbers. */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../../../src/contract/results';
import { axisStyle } from '../../../../src/renderer/components/charts/echarts';
import { concurrencyOption } from '../../../../src/renderer/components/charts/builders';
import { depthLinesOption } from '../../../../src/renderer/components/charts/depth-lines';
import { noteText } from '../../../../src/renderer/components/bench/notes';
import { createFormatters } from '../../../../src/renderer/i18n';
import { renderApp } from '../helpers';
import { exerciseFormatters } from '../bench/charts';
import { IDS, seeded, seededRuns } from '../bench/fixtures';
import { benchApi, deferred, serverInfo, serverPlanFor } from '../bench/world';
import { point, stat, TUNE_ID, tunedRun, users } from './tune-fixtures';

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
const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });
const tk = {
  font: 'x',
  fg: '#000',
  fg2: '#111',
  fg3: '#222',
  surface: '#fff',
  elevated: '#fff',
  border: '#eee',
  grid: '#eee',
  axis: '#ddd',
  band: 'x',
  bandAlt: 'y',
  series: ['#1', '#2'],
  accent2: '#3',
};

describe('results list', () => {
  it('shows the cache with the context and how many combinations a tune run measured', async () => {
    const tuned = tunedRun();
    tuned.launch = { ...tuned.launch, params: { ...tuned.launch.params, kvCacheType: 'q4_0', contextSize: 65536 } };
    const one = { ...tunedRun({ combinations: [tunedRun().tuning!.combinations[0]!] }), id: 'one', createdAt: '2026-10-07T08:00:00.000Z' };
    renderApp('/results', benchApi({ runs: [...seededRuns(), tuned, one] }));
    const row = (await screen.findAllByRole('row')).find((r) => r.textContent?.includes('6 combinazioni'))!;
    expect(row.textContent).toContain('Trova le impostazioni migliori · 6 combinazioni');
    expect(within(row).getByText('cache q4_0')).toBeTruthy();
    expect(screen.getByText(/· 1 combinazione( · [\d.]+ punti)?$/)).toBeTruthy();
  });
});

describe('“Avvia solo il server”', () => {
  it('says the context and cache come from the latest tune test, with a link to it', async () => {
    const api = benchApi({ runs: [...seededRuns(), tunedRun()] });
    api.world.serverPlan = () => serverPlanFor({ contextSize: 65536, tuned: { runId: TUNE_ID, createdAt: '2026-10-07T09:00:00.000Z', contextSize: 65536, kvCacheType: 'q4_0' } });
    const { router } = renderApp('/', api);
    await screen.findAllByText('≈ 1 min 35 s');
    await userEvent.click(screen.getByRole('button', { name: 'Avvia solo il server' }));
    expect(await screen.findByText(/Contesto 64K e cache q4_0 dal test «Trova le impostazioni migliori» del 07\/10\./)).toBeTruthy();
    // "Scelte da LLM Bench" says the same.
    expect(screen.getByText('Dal test «Trova le impostazioni migliori» del 07/10: contesto 64K, cache q4_0.')).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: 'Apri il risultato' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/results/${TUNE_ID}`));
  });

  it('while the server starts, the dialog and then its card say what the engine is doing', async () => {
    const api = benchApi();
    const gate = deferred<unknown>();
    api.world.routes['POST /api/servers'] = () => gate.promise;
    const loading = serverInfo('srv1', { port: 8080, engineLabel: 'vLLM v0.12.0', engineKind: 'vllm-docker', loading: { stage: 'weights', elapsedMs: 18_000, done: 3, total: 7, fraction: 0.43 } });
    renderApp('/', api);
    await screen.findAllByText('≈ 1 min 35 s');
    await userEvent.click(screen.getByRole('button', { name: 'Avvia solo il server' }));
    await screen.findByRole('region', { name: 'Comando esatto' });
    await userEvent.click(screen.getByRole('button', { name: 'Avvia' }));
    const starting = await screen.findByRole('dialog', { name: 'Avvio il server…' });
    expect(within(starting).queryByText(/Caricamento dei pesi/)).toBeNull();
    api.world.servers = [loading];
    expect(await within(starting).findByText('Caricamento dei pesi · 3 di 7 parti (43%)', {}, { timeout: 3000 })).toBeTruthy();
    expect(within(starting).getByText('0:18')).toBeTruthy();
    // In the background: its card shows the same line instead of the address.
    await userEvent.click(within(starting).getByRole('button', { name: 'Continua in background' }));
    const card = await screen.findByRole('region', { name: 'Server Qwen3 8B sulla porta 8080' });
    expect(within(card).getByText('Caricamento dei pesi · 3 di 7 parti (43%)')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Copia l’URL base di Qwen3 8B' })).toBeNull();
    api.world.servers = [{ ...loading, loading: undefined }];
    gate.resolve(api.world.servers[0]);
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Server Qwen3 8B sulla porta 8080' })).getByRole('button', { name: 'Copia l’URL base di Qwen3 8B' })).toBeTruthy());
  });
});

describe('normal results with the new measurements', () => {
  function full(): RunResult {
    const run = seeded(IDS.full);
    run.metrics.contextSweep = [point(K, 190, 9000), point(8 * K, 170, 8400), point(32 * K - 144, 140, 6000, undefined, { decodeTpsEngine: stat(141) })];
    run.metrics.concurrency = [
      users(4, { promptTokens: 512, outputTokens: 128, contextPerUser: 8192, perRequestPrefillTpsP50: 1900, perRequestDecodeTpsP5: 38, aggregatePrefillTps: 6100 }),
      users(1, { promptTokens: 512, outputTokens: 128, contextPerUser: 32768, perRequestPrefillTpsP50: 2400, perRequestDecodeTpsP5: 49 }),
      users(2, { promptTokens: 512, outputTokens: 128, contextPerUser: 16384, perRequestPrefillTpsP50: 2200 }),
    ];
    return run;
  }

  it('overview: speed as the context fills up, and what each user gets', async () => {
    renderApp(`/results/${IDS.full}`, benchApi({ runs: [full()] }));
    await h1(/Qwen3 8B/);
    expect(screen.getByRole('heading', { name: 'Velocità al crescere del contesto' })).toBeTruthy();
    expect(screen.getByText('Con 4 utenti ognuno legge a 1.900 tok/s e scrive a 42,5 tok/s (85% di quando è da solo); il primo token arriva in 0,38 s (0,44 s nel caso peggiore). In tutto 170 tok/s.')).toBeTruthy();
    await waitFor(() => expect(charts.options.length).toBeGreaterThanOrEqual(3));
    for (const o of charts.options) exerciseFormatters(o);
    const conc = charts.options.find((o) => JSON.stringify(o).includes('Utente più lento')) as { series: { data: [number, number | null][] }[] };
    expect(conc.series[2]!.data.map((d) => d[1])).toEqual([49, null, 38]);
    // Prompt reading speed against depth (the sweep's own toggle).
    const sweepCard = screen.getByRole('heading', { name: 'Velocità al crescere del contesto' }).closest('div')!.parentElement!.parentElement!;
    const before = charts.options.length;
    await userEvent.click(within(sweepCard).getByRole('radio', { name: 'Lettura prompt' }));
    await waitFor(() => expect(charts.options.length).toBeGreaterThan(before));
    const prefill = charts.options.at(-1) as { series: { data: number[] }[] };
    expect(prefill.series[0]!.data).toEqual([9000, 8400, 6000]);
    expect(exerciseFormatters(prefill).join(' ')).toContain('a 1.024 token di contesto: scrittura 190,0 tok/s, lettura 9.000 tok/s');
    for (const b of screen.getAllByRole('button', { name: 'Mostra tabella' })) await userEvent.click(b);
    const sweep = screen.getByRole('table', { name: /Velocità al crescere del contesto/ });
    expect(within(sweep).getAllByRole('row')[3]!.textContent).toContain('32.624');
    const users4 = screen.getByRole('table', { name: /Più utenti insieme/ });
    expect(within(users4).getAllByRole('row').map((r) => r.firstElementChild!.textContent)).toEqual(['Utenti', '1', '2', '4']);
  });

  it('details: the sweep table and the per-user table with units', async () => {
    renderApp(`/results/${IDS.full}`, benchApi({ runs: [full()] }));
    await h1(/Qwen3 8B/);
    await userEvent.click(screen.getByRole('tab', { name: 'Dettagli' }));
    const sweep = screen.getByRole('table', { name: 'Velocità al crescere del contesto' });
    expect(within(sweep).getByText('Generazione dal motore (tok/s)')).toBeTruthy();
    expect(within(sweep).getByText('32K').getAttribute('title')).toBe('32.624');
    const table = screen.getByRole('table', { name: 'Più utenti' });
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'Utenti',
      'Prompt per utente (token)',
      'Generati per utente (token)',
      'Contesto per utente (token)',
      'Lettura per utente p50 (tok/s)',
      'Scrittura per utente p50 (tok/s)',
      'Scrittura utente più lento p5 (tok/s)',
      'Rispetto a 1 utente (%)',
      'Primo token p50 (ms)',
      'Primo token p95 (ms)',
      'Totale scrittura (tok/s)',
      'Totale lettura (tok/s)',
      'Richieste',
      'Errori',
    ]);
  });

  it('notes of the context sweep in plain words', () => {
    expect(noteText({ code: 'context_sweep_budget', params: { depth: 65536, seconds: 300 } }, f).body).toBe(
      'Il tempo previsto per questa misura (300 s) è finito: le profondità da 65.536 token in su non sono state misurate.',
    );
    expect(noteText({ code: 'context_sweep_skipped', params: { reason: 'unknown_context' } }, f).body).toContain('Non so quanto contesto regge il server');
    expect(noteText({ code: 'context_sweep_skipped', params: { reason: 'context_too_small', contextSize: 2048 } }, f).body).toBe(
      'Con un contesto di 2.048 token non ci sono abbastanza profondità da misurare: salto questa misura.',
    );
  });
});

describe('chart builders', () => {
  it('speed against depth: one line or many (dashed past the palette), the compared depth marked', () => {
    const one = depthLinesOption(tk, [K, 4 * K], [{ name: 'a', values: [1, 2] }], { format: (v) => `${v} t`, depthLabel: (d) => `${d / K}K`, xName: 'x' }) as Record<string, never>;
    expect(one.legend).toBeUndefined();
    expect(exerciseFormatters(one)).toContain('3');
    const tip = (one as unknown as { tooltip: { valueFormatter: (v: unknown) => string } }).tooltip;
    expect(tip.valueFormatter(null)).toBe('–');
    expect(tip.valueFormatter(3)).toBe('3 t');
    const many = depthLinesOption(
      tk,
      [K, 4 * K],
      ['a', 'b', 'c'].map((name) => ({ name, values: [1, null], emphasis: name === 'a' })),
      { format: String, axis: (v) => `~${v}`, depthLabel: String, xName: 'x', marker: 4 * K },
    ) as { series: { lineStyle: { type: string; width: number }; markLine?: { data: { xAxis: number }[] } }[]; legend: object };
    expect(many.legend).toBeTruthy();
    expect(many.series[2]!.lineStyle.type).toBe('dashed');
    expect(many.series[0]!.lineStyle.width).toBeGreaterThan(many.series[1]!.lineStyle.width);
    expect(many.series[0]!.markLine!.data[0]!.xAxis).toBe(1);
    expect(exerciseFormatters(many)).toContain('~3');
    const unmarked = depthLinesOption(tk, [K], [{ name: 'a', values: [1] }], { format: String, depthLabel: String, xName: 'x', marker: 9 }) as { series: { markLine?: unknown }[] };
    expect(unmarked.series[0]!.markLine).toBeUndefined();
    expect(axisStyle(tk).axisTick.show).toBe(false);
  });

  it('users: the slowest line is optional and gaps read as dashes', () => {
    const o = concurrencyOption(tk, [1, 2], [10, 18], [10, 9], { aggregateName: 'T', perUserName: 'U', format: (v) => `${v} t`, xName: 'x', slowest: { name: 'S', values: [9, null] } }) as {
      tooltip: { valueFormatter: (v: unknown) => string };
      series: unknown[];
    };
    expect(o.series).toHaveLength(3);
    expect(o.tooltip.valueFormatter(null)).toBe('–');
    expect(o.tooltip.valueFormatter(undefined)).toBe('–');
    expect(o.tooltip.valueFormatter(4)).toBe('4 t');
  });
});

describe('presets for runs that cannot start a server', () => {
  it('an external endpoint run offers only the settings', async () => {
    const run = { ...tunedRun(), engine: { ...tunedRun().engine, kind: 'external' as const } };
    renderApp(`/results/${TUNE_ID}`, benchApi({ runs: [run] }));
    await h1(/Qwen3 8B/);
    await waitFor(() => expect((screen.getAllByRole('button', { name: 'Usa questo preset' })[0] as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Avvia il server così' })).toBeNull();
    act(() => undefined);
  });
});
