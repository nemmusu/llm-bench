import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../../../src/contract/results';
import { validateCompareSearch } from '../../../../src/renderer/routes/compare';
import { renderApp } from '../helpers';
import { exerciseFormatters } from './charts';
import { IDS, seeded } from './fixtures';
import { apiError, benchApi, deferred } from './world';

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

async function choose(combobox: string, option: RegExp) {
  const trigger = await screen.findByRole('combobox', { name: combobox });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

describe('compare', () => {
  it('picks two runs, shows deltas, overlaid charts and the settings that differ', async () => {
    const api = benchApi();
    const { router } = renderApp('/compare', api);
    expect(await screen.findByText('Scegli i due risultati da mettere a confronto: A è quello di partenza.')).toBeTruthy();
    await choose('Risultato A', /Qwen3 30B A3B/);
    await waitFor(() => expect(router.state.location.search).toEqual({ a: IDS.moe }));
    await choose('Risultato B', /^Qwen3 8B · Q4_K_M · llama\.cpp b11438/);
    await waitFor(() => expect(router.state.location.search).toEqual({ a: IDS.moe, b: IDS.full }));
    const table = await screen.findByRole('table', { name: 'Confronta' });
    expect(within(table).getByRole('row', { name: /Generazione/ }).textContent).toMatch(/−14%|−1\d%/);
    expect(within(table).getAllByText('(migliore)').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('(peggiore)').length).toBeGreaterThan(0);
    await waitFor(() => expect(charts.options.length).toBeGreaterThanOrEqual(2));
    for (const o of charts.options) exerciseFormatters(o);
    for (const b of screen.getAllByRole('button', { name: 'Mostra tabella' })) await userEvent.click(b);
    expect(screen.getByRole('table', { name: /Generazione per lunghezza del testo/ }).textContent).toContain('8192');

    const params = screen.getByRole('table', { name: 'Cosa cambia tra i due' });
    expect(within(params).getByText('Qwen3 30B A3B · Q4_K_M')).toBeTruthy();
    expect(within(params).getAllByText('(diverso)').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('switch', { name: 'Solo le differenze' }));
    expect(within(params).queryByText('Driver')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Scambia A e B' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ a: IDS.full, b: IDS.moe }));
  });

  it('two identical runs: no differences, nothing to chart', async () => {
    const bare = (id: string): RunResult => ({
      ...seeded(IDS.failed),
      id,
      status: 'completed',
      metrics: { ...seeded(IDS.failed).metrics, latency: [], concurrency: [] },
    });
    const api = benchApi({ runs: [bare('x1'), bare('x2')] });
    renderApp('/compare?a=x1&b=x2', api);
    const table = await screen.findByRole('table', { name: 'Confronta' });
    expect(within(table).getByText('uguale')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Generazione per lunghezza del testo' })).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: 'Solo le differenze' }));
    expect(screen.getByText('Nessuna differenza: i due test sono stati avviati allo stesso modo.')).toBeTruthy();
  });

  it('only one completed run, a missing run, and loading', async () => {
    const api = benchApi({ runs: [seeded(IDS.full), seeded(IDS.failed)] });
    const gate = deferred<unknown>();
    api.world.routes['GET /api/runs'] = () => gate.promise;
    const { container, router } = renderApp(`/compare?a=${IDS.full}&b=nope`, api);
    await waitFor(() => expect(container.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0));
    await act(async () => gate.resolve((await import('./fixtures')).summaries([seeded(IDS.full), seeded(IDS.failed)])));
    expect(await screen.findByText('Servono almeno due test completati per fare un confronto.')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Risultato non trovato' })).toBeTruthy();
    const slow = deferred<unknown>();
    api.world.routes[`GET /api/runs/${IDS.gemma}`] = () => slow.promise;
    act(() => void router.navigate({ to: '/compare', search: { a: IDS.gemma, b: IDS.full } }));
    await waitFor(() => expect(container.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0));
    await act(async () => slow.reject(apiError('NETWORK')));
    expect(await screen.findByRole('heading', { name: 'Connessione a internet non disponibile' })).toBeTruthy();
  });

  it('validates the address', () => {
    expect(validateCompareSearch({})).toEqual({});
    expect(validateCompareSearch({ a: 'x', b: '' })).toEqual({ a: 'x' });
    expect(validateCompareSearch({ a: 3, b: 'y' })).toEqual({ b: 'y' });
  });
});
