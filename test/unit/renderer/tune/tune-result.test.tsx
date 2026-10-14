import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../../../src/contract/results';
import { renderApp } from '../helpers';
import { exerciseFormatters } from '../bench/charts';
import { seededRuns } from '../bench/fixtures';
import { benchApi } from '../bench/world';
import { attempt, combo, point, TUNE_ID, tunedRun, tuning } from './tune-fixtures';

const charts = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({ setOption: vi.fn((o: Record<string, unknown>) => charts.options.push(o)), resize: vi.fn(), dispose: vi.fn() })),
}));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

const clipboard = { writeText: vi.fn(async (_text: string) => undefined) };

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
});
afterEach(() => {
  charts.options.length = 0;
});

const K = 1024;
const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });
const ranking = () => screen.getByRole('table', { name: /^Classifica delle combinazioni a/ });
/** Data rows of the ranking (named after their configuration; the opened "Misure" rows are not). */
const rankRows = () => within(ranking()).getAllByRole('row').filter((r) => r.hasAttribute('aria-label'));

function open(run: RunResult = tunedRun()) {
  const api = benchApi({ runs: [...seededRuns(), run] });
  return { ...renderApp(`/results/${run.id}`, api), api };
}

describe('tune result', () => {
  it('sums up from the numbers and recommends the fastest at the largest context', async () => {
    open();
    expect(await h1(/Qwen3 8B/)).toBeTruthy();
    expect(screen.getByText('Con cache q4_0 arrivi a 64K, il doppio di q8_0 (32K).')).toBeTruthy();
    // The five answers, in order, each with where it was measured and which configuration.
    const brief = screen.getByRole('list', { name: 'Le risposte principali' });
    expect(within(brief).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '1Al contesto più grande (64K)legge 6.400 tok/s, scrive 60,0 tok/sCache KV q4_0 · flash attention · ub 2048 · b 4096',
      '2Dove legge più in frettaa 1K: 9.800 tok/sCache KV q4_0 · flash attention · ub 2048 · b 4096',
      '3Dove scrive più in frettaa 1K: 92,0 tok/sCache KV f16 · flash attention',
      '4Dove va meglio in tutte e duea 1K: legge 9.000 tok/s, scrive 92,0 tok/sCache KV f16 · flash attention',
      '5Con le impostazioni più fedeli (cache f16)fino a 24K: legge 7.000 tok/s, scrive 74,0 tok/sCache KV f16 · flash attention',
    ]);
    expect(within(brief).getByText('legge 6.400 tok/s, scrive 60,0 tok/s').getAttribute('title')).toBe('a 65.392 token di contesto');
    await userEvent.click(within(brief).getByRole('button', { name: 'Che cos’è «Dove va meglio in tutte e due»?' }));
    expect((await screen.findAllByText(/conta di più la più debole delle due \(media armonica\)/)).length).toBeGreaterThan(0);
    const rec = screen.getByRole('region', { name: 'Combinazione consigliata' });
    expect(within(rec).getByText('Cache KV q4_0 · flash attention · ub 2048 · b 4096')).toBeTruthy();
    expect(within(rec).getByText('64K')).toBeTruthy();
    // Its speeds with the context full, the exact tokens on hover.
    expect(within(rec).getByText('Generazione al contesto massimo (64K)')).toBeTruthy();
    expect(within(rec).getByText('60,0 tok/s').getAttribute('title')).toBe('a 65.392 token di contesto');
    expect(within(rec).getByText('6.400 tok/s')).toBeTruthy();
    expect(within(rec).getByText('10,22 s')).toBeTruthy();
    expect(within(rec).getByText('29,8 GB')).toBeTruthy();
    expect(within(rec).queryByText(/Misurata solo fino a/)).toBeNull();
    // Its preset is in the page header (and on its row of the ranking).
    expect(screen.getAllByRole('group', { name: /^Preset di Qwen3 8B/ }).length).toBeGreaterThan(1);
  });

  it('ranks by generation at the compared depth; any column sorts; shorter ones greyed at the bottom', async () => {
    open();
    await h1(/Qwen3 8B/);
    // Default: every combination with its own largest context full, the largest context first.
    expect(ranking().querySelector('caption')!.textContent).toBe('Classifica delle combinazioni al contesto massimo');
    expect(screen.getByText(/^Ogni configurazione con il proprio contesto massimo pieno; prima il contesto più grande/)).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /^Generazione \(tok\/s\) al contesto massimo/ })).toBeTruthy();
    const atMax = rankRows();
    expect(atMax.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Cache KV q4_0 · flash attention · ub 2048 · b 4096',
      'Cache KV q4_0 · flash attention',
      'Cache KV q8_0 · 8 livelli MoE sulla CPU · flash attention',
      'Cache KV q8_0 · flash attention',
      'Cache KV f16 · flash attention',
    ]);
    expect(within(atMax[0]!).getByText('Consigliata')).toBeTruthy();
    // The best values only among the 64K ones: q8_0 writes faster at its 32K, but that does not compare.
    expect(within(atMax[0]!).getAllByText('il migliore', { exact: false })).toHaveLength(3);
    expect(within(atMax[3]!).queryByText('il migliore', { exact: false })).toBeNull();
    expect(atMax[3]!.textContent).toContain('72,0');
    expect(within(atMax[3]!).getByText('72,0').closest('td')!.getAttribute('title')).toBe('a 32.624 token di contesto');
    expect(screen.getByText(/^In verde il valore migliore di ogni colonna tra le configurazioni con il contesto più grande/)).toBeTruthy();

    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Confronta a' })).getByRole('radio', { name: '16K' }));
    expect(ranking().querySelector('caption')!.textContent).toBe('Classifica delle combinazioni a 16K');
    expect(rankRows().map((r) => r.getAttribute('aria-label'))).toEqual([
      'Cache KV f16 · flash attention',
      'Cache KV q8_0 · flash attention',
      'Cache KV q4_0 · flash attention · ub 2048 · b 4096',
      'Cache KV q4_0 · flash attention',
      'Cache KV q8_0 · 8 livelli MoE sulla CPU · flash attention',
    ]);
    expect(within(rankRows()[2]!).getByText('Consigliata')).toBeTruthy();
    expect(within(rankRows()[1]!).getByText('pari merito con la riga sopra')).toBeTruthy();

    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Confronta a' })).getByRole('radio', { name: '64K' }));
    expect(ranking().querySelector('caption')!.textContent).toBe('Classifica delle combinazioni a 64K');
    const rows = rankRows();
    expect(rows[0]!.textContent).toContain('ub 2048');
    expect(rows[0]!.textContent).toContain('60,0');
    expect(within(rows[0]!).getAllByText('il migliore', { exact: false })).toHaveLength(3);
    expect(rows[3]!.textContent).toContain('arriva solo a 32K');
    expect(rows[4]!.textContent).toContain('arriva solo a 24K');

    const decode = screen.getByRole('columnheader', { name: /Generazione \(tok\/s\)/ });
    await userEvent.click(within(decode).getByRole('button'));
    expect(decode.getAttribute('aria-sort')).toBe('descending');
    await userEvent.click(within(decode).getByRole('button'));
    expect(decode.getAttribute('aria-sort')).toBe('ascending');
    expect(rankRows()[0]!.textContent).toContain('MoE sulla CPU');
    const vram = screen.getByRole('columnheader', { name: /VRAM picco \(GB\)/ });
    await userEvent.click(within(vram).getByRole('button'));
    expect(vram.getAttribute('aria-sort')).toBe('ascending');
    await userEvent.click(within(vram).getByRole('button'));
    expect(vram.getAttribute('aria-sort')).toBe('descending');
    expect(decode.getAttribute('aria-sort')).toBeNull();
    expect(rankRows()[2]!.textContent).toContain('–');
    // Back to "Contesto massimo".
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Confronta a' })).getByRole('radio', { name: 'Contesto massimo' }));
    expect(ranking().querySelector('caption')!.textContent).toBe('Classifica delle combinazioni al contesto massimo');
  });

  it('opens every measurement of a row with its exact command', async () => {
    open();
    await h1(/Qwen3 8B/);
    const row = rankRows()[0]!;
    const toggle = within(row).getByRole('button', { name: 'Misure' });
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const table = screen.getByRole('table', { name: 'Misure di Cache KV q4_0 · flash attention · ub 2048 · b 4096' });
    expect(within(table).getAllByRole('row')).toHaveLength(7);
    expect(within(table).getByText('64K').getAttribute('title')).toBe('65.392');
    expect(screen.getByText(/VRAM picco 29,8 GB · avviato con contesto 65.536 token · 2 ripetizioni per misura/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Comando di Cache KV q4_0 · flash attention · ub 2048 · b 4096' }).textContent).toContain('-ctk q4_0');
    // The offload combination has the engine's own generation figure.
    await userEvent.click(within(rankRows()[2]!).getByRole('button', { name: 'Misure' }));
    expect(screen.getByRole('table', { name: /Misure di .*MoE sulla CPU/ }).textContent).toContain('18,4');
    await userEvent.click(toggle);
    expect(screen.queryByRole('table', { name: 'Misure di Cache KV q4_0 · flash attention · ub 2048 · b 4096' })).toBeNull();
    // No VRAM figure for this one: the line says the rest.
    await userEvent.click(within(rankRows()[1]!).getByRole('button', { name: 'Misure' }));
    expect(screen.getByText(/^avviato con contesto 65.536 token · 2 ripetizioni per misura/)).toBeTruthy();
  });

  it('“Usa questo preset” fills the Benchmark with that combination; “Avvia il server così” opens the start flow with it', async () => {
    const { api, router } = open();
    await h1(/Qwen3 8B/);
    await userEvent.click(await within(rankRows()[1]!).findByRole('button', { name: 'Avvia il server così' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/servers/new'));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.path === '/api/servers/plan').map((c) => c.body)).toContainEqual(
        expect.objectContaining({ params: expect.objectContaining({ kvCacheType: 'q4_0', contextSize: 65536 }) }),
      ),
    );
    act(() => router.history.back());
    await h1(/Qwen3 8B/);
    await userEvent.click(within(rankRows()[0]!).getByRole('button', { name: 'Usa questo preset' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByText('Impostazioni copiate nel Benchmark')).toBeTruthy();
    expect(((await screen.findByLabelText('Contesto (token)')) as HTMLInputElement).value).toBe('65536');
    expect(api.settings.expertMode).toBe(true);
  });

  it('draws speed against context for the top five, all on request, reading speed as a toggle', async () => {
    open();
    await h1(/Qwen3 8B/);
    await waitFor(() => expect(charts.options.length).toBeGreaterThan(0));
    const last = () => charts.options.at(-1) as { series: { name: string; data: unknown[]; lineStyle: { width: number } }[] };
    expect(last().series).toHaveLength(5);
    expect(last().series.find((s) => s.name.includes('ub 2048'))!.lineStyle.width).toBeGreaterThan(2);
    expect(exerciseFormatters(last()).join(' ')).toContain('tok/s');
    await userEvent.click(screen.getByRole('radio', { name: 'Lettura prompt' }));
    await waitFor(() => expect(exerciseFormatters(charts.options.at(-1)).join(' ')).toContain('tok/s'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Mostra tabella' })[0]!);
    const data = screen.getByRole('table', { name: /Velocità al crescere del contesto/ });
    expect(within(data).getByText('Lettura prompt 64K (tok/s)')).toBeTruthy();
  });

  it('lists the dropped launches with the reason, the numbers and the command; capacity and fidelity', async () => {
    open();
    await h1(/Qwen3 8B/);
    await userEvent.click(screen.getByRole('button', { name: /Prove scartate/ }));
    expect(screen.getByText('Con contesto 32K la memoria video non bastava: il motore non è partito.')).toBeTruthy();
    expect(screen.getByText(/Windows ha spostato 2,0 GB nella RAM condivisa/)).toBeTruthy();
    // Its numbers with the depth they were measured at, not the launch's context.
    expect(screen.getByText('contesto 48K · con il contesto riempito a 4K: generazione 31,0 tok/s, lettura 2.400 tok/s · VRAM picco 31,1 GB · RAM condivisa 2,0 GB')).toBeTruthy();
    expect(screen.getByText('Il motore non riconosce un parametro')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Comando della prova 2: Cache KV f16 · flash attention, contesto 32K' })).toBeTruthy();
    const capacity = screen.getByRole('table', { name: 'Contesto massimo per tipo di cache' });
    expect(within(capacity).getAllByRole('row').map((r) => r.textContent)).toEqual([
      'Cache KVStima (token)Massimo trovato (token)Note',
      'f1626K24KMisurato avviando il motore.',
      'q8_040K32KMisurato avviando il motore.',
      'q4_072K64KMisurato avviando il motore.',
    ]);
    expect(screen.getByText(/i primi 87 token su 128 sono identici a quelli con f16; il primo diverso è il n\. 88/)).toBeTruthy();
    expect(screen.getByText(/non un test di qualità/)).toBeTruthy();
  });

  it('reads well when the search stopped early, little was measured, or nothing at all', async () => {
    const t = tuning();
    const sparse = tunedRun({
      stoppedBy: 'budget',
      combinations: [t.combinations[1]!],
      recommended: undefined,
      fastestByDepth: [],
      attempts: [],
      capacity: [
        { kvType: 'f16', inferred: false, skipped: 'estimate' },
        { kvType: 'q8_0', predictedMax: 40 * K, measuredMax: 32 * K, inferred: true },
        { kvType: 'q4_0', inferred: false, skipped: 'no-gain' },
        { kvType: 'auto', predictedMax: 8 * K, inferred: false },
        { kvType: 'fp8', inferred: false, skipped: 'budget' },
      ],
      fidelity: { referenceKv: 'f16', comparedKv: 'q8_0', promptTokens: 1024, tokens: 64, identical: 50 },
    });
    const { unmount } = open(sparse);
    await h1(/Qwen3 8B/);
    expect(screen.getByText('Mi sono fermato prima: tempo finito')).toBeTruthy();
    expect(screen.getByText('Con cache q8_0 arrivi a 32K.')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Le risposte principali' })).getAllByRole('listitem')[0]!.textContent).toContain('legge 6.600 tok/s, scrive 72,0 tok/s');
    // One combination: its own largest context and depths to compare at, no "Prove scartate".
    expect(within(screen.getByRole('radiogroup', { name: 'Confronta a' })).getAllByRole('radio')).toHaveLength(6);
    expect(screen.queryByRole('button', { name: /Prove scartate/ })).toBeNull();
    const capacity = screen.getByRole('table', { name: 'Contesto massimo per tipo di cache' });
    expect(capacity.textContent).toContain('Non provato (la stima della memoria lo escludeva).');
    expect(capacity.textContent).toContain('Dedotto senza avviare il motore');
    expect(capacity.textContent).toContain('Non provato (non serviva): non avrebbe dato più contesto.');
    expect(capacity.textContent).toContain('Nessun contesto è entrato tutto nella memoria video.');
    expect(capacity.textContent).toContain('Non provato (tempo finito).');
    expect(capacity.textContent).toContain('non ci sta');
    expect(capacity.textContent).toContain('automatica');
    // No first divergence reported: the one after the identical ones.
    expect(screen.getByText(/i primi 50 token su 64 sono identici a quelli con f16; il primo diverso è il n\. 51/)).toBeTruthy();
    unmount();

    const single = tunedRun({
      combinations: [combo('f16', 2 * K, [point(K, 50, 900)])],
      recommended: 0,
      fastestByDepth: [],
      fidelity: { referenceKv: 'f16', comparedKv: 'q4_0', promptTokens: 512, tokens: 32, identical: 32 },
      stoppedBy: 'launches',
    });
    const second = open(single);
    await h1(/Qwen3 8B/);
    expect(screen.getByText('Mi sono fermato prima: raggiunto il numero massimo di prove')).toBeTruthy();
    // Measured at 1K only, its context is 2K: "Contesto massimo" says it was not measured there, 1K has the number.
    expect(within(screen.getByRole('radiogroup', { name: 'Confronta a' })).getAllByRole('radio')).toHaveLength(2);
    expect(within(ranking()).getByText('non misurata a 2K')).toBeTruthy();
    const card = screen.getByRole('region', { name: 'Combinazione consigliata' });
    expect(within(card).getAllByText('non misurata')).toHaveLength(3);
    expect(within(card).getByText('Misurata solo fino a 1K: rifai la ricerca per avere la velocità a 2K.')).toBeTruthy();
    expect(screen.getByText(/tutti i 32 token generati sono identici/)).toBeTruthy();
    second.unmount();

    const empty = tunedRun({ combinations: [], recommended: undefined, fastestByDepth: [], capacity: [], attempts: [attempt('capacity', 'f16', 8 * K, 'oom')], fidelity: undefined });
    const third = open(empty);
    await h1(/Qwen3 8B/);
    expect(screen.getByText('Nessuna combinazione è arrivata fino in fondo: guarda le prove scartate qui sotto.')).toBeTruthy();
    expect(screen.getByText('Nessuna combinazione è stata misurata fino in fondo.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Combinazione consigliata' })).toBeNull();
    expect(screen.getByRole('button', { name: /Prove scartate/ })).toBeTruthy();
    third.unmount();
    // The same search ended by an error (saved before the search said so): the summary says how it ended.
    open({ ...empty, status: 'failed', error: { code: 'ENGINE_OOM', message: 'oom' } });
    await h1(/Qwen3 8B/);
    expect(screen.getByText('Il test si è fermato per un errore prima che una combinazione fosse misurata: qui sotto le prove fatte fin lì.')).toBeTruthy();
    expect(screen.getByText('Test interrotto da un errore')).toBeTruthy();
  });

  it('the recommendation says only what was measured; many combinations fold to the top five', async () => {
    const t = tuning();
    const extra = [0, 1].map((i) => ({ ...t.combinations[2]!, params: { ...t.combinations[2]!.params, threads: 8 + i } }));
    const { unmount } = open(tunedRun({ recommended: 3, combinations: [...t.combinations, ...extra] }));
    await h1(/Qwen3 8B/);
    const rec = screen.getByRole('region', { name: 'Combinazione consigliata' });
    expect(within(rec).queryByText('VRAM picco')).toBeNull();
    await waitFor(() => expect(charts.options.length).toBeGreaterThan(0));
    expect((charts.options.at(-1) as { series: unknown[] }).series).toHaveLength(5);
    await userEvent.click(screen.getByRole('button', { name: 'Mostra tutte (7)' }));
    await waitFor(() => expect((charts.options.at(-1) as { series: unknown[] }).series).toHaveLength(7));
    await userEvent.click(screen.getByRole('button', { name: 'Solo le prime 5' }));
    unmount();
    // A recommendation without a sweep (older or partial data): its context, its speeds not measured.
    open(tunedRun({ recommended: 5 }));
    await h1(/Qwen3 8B/);
    const bare = screen.getByRole('region', { name: 'Combinazione consigliata' });
    expect(within(bare).getByText('Contesto massimo')).toBeTruthy();
    expect(within(bare).getAllByText('non misurata')).toHaveLength(3);
    expect(within(bare).queryByText(/Misurata solo fino a/)).toBeNull();
  });

  it('combinations measured without a context sweep (other goals) do not break the page', async () => {
    const t = tuning();
    const run = tunedRun({ combinations: t.combinations.map((c) => ({ ...c, sweep: [] })), fastestByDepth: [], recommended: 0 });
    open(run);
    await h1(/Qwen3 8B/);
    expect(screen.getByText('Nessuna combinazione è stata misurata fino in fondo.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Velocità al crescere del contesto' })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Combinazione consigliata' })).getByText('24K')).toBeTruthy();
  });

  it('without the model in the library every row offers to find it', async () => {
    const api = benchApi({ runs: [tunedRun()], local: [] });
    renderApp(`/results/${TUNE_ID}`, api);
    await h1(/Qwen3 8B/);
    await waitFor(() => expect(within(rankRows()[0]!).getByRole('button', { name: 'Trova il modello' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Usa questo preset' })).toBeNull();
  });
});
