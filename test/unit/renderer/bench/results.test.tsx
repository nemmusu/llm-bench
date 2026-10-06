import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../helpers';
import { HOST, IDS, seeded, seededRuns } from './fixtures';
import { apiError, benchApi, deferred } from './world';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

async function choose(combobox: string, option: string) {
  const trigger = screen.getByRole('combobox', { name: combobox });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

function file(content: string): File {
  return new File([content], 'runs.gpubench', { type: 'application/json' });
}

describe('results list', () => {
  it('lists, filters and opens runs', async () => {
    const older = { ...seeded(IDS.full), id: '01K6A00000000000000000000A', createdAt: '2026-09-01T10:00:00.000Z' };
    older.metrics.latency = older.metrics.latency.map((p) => ({ ...p, decodeTps: { ...p.decodeTps, median: p.decodeTps.median * 0.9 } }));
    // Started with the engine's default context: nothing to show.
    older.launch = { ...older.launch, argv: ['llama-server'], params: { extraArgs: [], env: {} } };
    const api = benchApi({ runs: [...seededRuns(), older] });
    const { router } = renderApp('/results', api);
    expect(await screen.findByText('10 risultati')).toBeTruthy();
    expect(screen.getByText('Altro PC')).toBeTruthy();
    // Speeds with their unit, the context of each test, and the most users served at once (when measured).
    expect(screen.getByRole('columnheader', { name: /Contesto/ })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /Utenti paralleli/ })).toBeTruthy();
    const mistral = (await screen.findByRole('link', { name: /Mistral Small/ })).closest('tr')!;
    expect(within(mistral).getAllByText('tok/s').length).toBe(2);
    expect(within(mistral).getByText('1024')).toBeTruthy();
    expect(within(mistral).getAllByText('–').length).toBeGreaterThan(0);
    const gemma = screen.getByRole('link', { name: /Gemma 4 31B/ }).closest('tr')!;
    expect(within(gemma).getByText('8192')).toBeTruthy();
    expect(within(gemma).getByText('4 utenti')).toBeTruthy();
    expect(within(gemma).getByText(/^[\d.]+ tok\/s in tutto$/)).toBeTruthy();
    expect(screen.getAllByText('Annullato').length).toBeGreaterThan(0);
    await userEvent.type(screen.getByRole('textbox', { name: 'Cerca' }), 'gemma');
    expect(screen.getByText('1 risultato')).toBeTruthy();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Cerca' }));
    await choose('Modello', 'Qwen3 8B');
    expect(screen.getByText('3 risultati')).toBeTruthy();
    await choose('Scheda video', 'RTX 3070');
    expect(screen.getByText('1 risultato')).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: 'Solo questo PC' }));
    expect(await screen.findByRole('heading', { name: 'Nessun risultato con questi filtri' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Togli i filtri' }));
    await choose('Motore', 'vLLM (Docker)');
    expect(screen.getByText('1 risultato')).toBeTruthy();
    await choose('Motore', 'Tutti i motori');
    await choose('Stato', 'Non riuscito');
    expect(screen.getByText('1 risultato')).toBeTruthy();
    await choose('Stato', 'Tutti gli stati');
    // Header sorting.
    await userEvent.click(screen.getByRole('button', { name: /Punteggio/ }));
    // A model link and a row both open the detail.
    await userEvent.click(screen.getByRole('link', { name: /Gemma 4 31B/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/results/${IDS.gemma}`));
    await userEvent.click(await screen.findByRole('link', { name: 'Tutti i risultati' }));
    const row = (await screen.findByRole('link', { name: /Mistral Small/ })).closest('tr')!;
    await userEvent.click(within(row).getAllByRole('cell')[1]!);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/results/${IDS.quick}`));
  });

  it('compares two selected runs, older first', async () => {
    const api = benchApi();
    const { router } = renderApp('/results', api);
    await screen.findByText('9 risultati');
    expect((screen.getByRole('button', { name: 'Confronta' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona Gemma 4 31B/ }));
    expect(screen.getByText('9 risultati · 1 selezionato')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona Qwen3 30B A3B/ }));
    expect(screen.getByText('9 risultati · 2 selezionati')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona Mistral/ }));
    expect((screen.getByRole('button', { name: 'Confronta' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona Mistral/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Confronta' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/compare'));
    expect(router.state.location.search).toEqual({ a: IDS.moe, b: IDS.gemma });
  });

  it('exports a selection as a .gpubench file', async () => {
    const api = benchApi();
    const bundle = { format: 'gpubench-export', version: 1, runs: [] };
    api.world.routes['POST /api/runs/export'] = () => bundle;
    const saveFile = vi.fn(async (_o: { defaultName: string }) =>'C:\\Users\\me\\scelti.gpubench');
    (window as { gpubench?: unknown }).gpubench = { saveFile, platform: 'win32', setTitleBarTheme: async () => undefined };
    renderApp('/results', api);
    await screen.findByText('9 risultati');
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona Gemma 4 31B/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Esporta (1)' }));
    expect(await screen.findByText('Esportato 1 risultato in C:\\Users\\me\\scelti.gpubench')).toBeTruthy();
    expect(saveFile.mock.calls[0]![0]).toMatchObject({ defaultName: expect.stringMatching(/^gpubench_\d{4}-\d\d-\d\d\.gpubench$/) as string });
    saveFile.mockResolvedValueOnce(null as never);
    await userEvent.click(screen.getByRole('button', { name: 'Esporta (1)' }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(2));
    api.world.routes['POST /api/runs/export'] = () => {
      throw apiError('DISK_FULL');
    };
    await userEvent.click(screen.getByRole('button', { name: 'Esporta (1)' }));
    expect(await screen.findByText('Spazio su disco esaurito')).toBeTruthy();
    api.world.routes['POST /api/runs/export'] = () => bundle;
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona Mistral/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Esporta (2)' }));
    expect(await screen.findByText(/^Esportati 2 risultati in C:/)).toBeTruthy();
  });

  it('deletes after confirmation, reporting failures', async () => {
    const api = benchApi();
    renderApp('/results', api);
    await screen.findByText('9 risultati');
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona Gemma 4 31B/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Elimina (1)' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Eliminare questo risultato?' });
    await userEvent.click(within(ask).getByRole('button', { name: 'Elimina' }));
    expect(await screen.findByText('Risultato eliminato')).toBeTruthy();
    expect(await screen.findByText('8 risultati')).toBeTruthy();
    api.world.routes['DELETE /api/runs/*'] = () => {
      throw apiError('RUN_NOT_FOUND');
    };
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona Mistral/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Elimina (1)' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Elimina' }));
    expect(await screen.findByText('Non sono riuscito a eliminare il risultato')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona Mistral/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona gpt-oss/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Elimina (2)' }));
    await userEvent.click(within(await screen.findByRole('alertdialog', { name: 'Eliminare 2 risultati?' })).getByRole('button', { name: 'Elimina' }));
    expect(await screen.findByText('Non sono riuscito a eliminare 2 risultati')).toBeTruthy();
    delete api.world.routes['DELETE /api/runs/*'];
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona Mistral/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona gpt-oss/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Elimina (2)' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Elimina' }));
    expect(await screen.findByText('Eliminati 2 risultati')).toBeTruthy();
  });

  it('imports .gpubench files and explains bad ones', async () => {
    const api = benchApi();
    let answer: 'ok' | 'one' | 'not_export' | 'too_new' | 'other' = 'ok';
    api.world.routes['POST /api/runs/import'] = () => {
      if (answer === 'not_export') throw apiError('VALIDATION', { reason: 'not_export' });
      if (answer === 'too_new') throw apiError('VALIDATION', { reason: 'export_too_new' });
      if (answer === 'other') throw apiError('DISK_FULL');
      return answer === 'one' ? { imported: 1, skipped: 0 } : { imported: 3, skipped: 1 };
    };
    const { container } = renderApp('/results', api);
    await screen.findByText('9 risultati');
    const input = container.ownerDocument.querySelector<HTMLInputElement>('input[type=file]')!;
    const upload = async (f?: File) => {
      await act(async () => {
        fireEvent.change(input, { target: { files: f ? [f] : [] } });
      });
    };
    const click = vi.spyOn(input, 'click');
    await userEvent.click(screen.getByRole('button', { name: 'Importa' }));
    expect(click).toHaveBeenCalled();
    await upload(file('{"format":"gpubench-export","version":1,"runs":[]}'));
    expect(await screen.findByText('Importati 3 risultati (1 già presenti)')).toBeTruthy();
    answer = 'one';
    await upload(file('{}'));
    expect(await screen.findByText('Importato 1 risultato (0 già presenti)')).toBeTruthy();
    await upload(file('not json'));
    expect(await screen.findByText('Questo file non è un’esportazione di GPU Bench.')).toBeTruthy();
    answer = 'too_new';
    await upload(file('{}'));
    expect(await screen.findByText('Il file viene da una versione più recente di GPU Bench: aggiorna l’app per aprirlo.')).toBeTruthy();
    answer = 'other';
    await upload(file('{}'));
    expect(await screen.findByText('Spazio su disco esaurito')).toBeTruthy();
    answer = 'not_export';
    await upload(file('{}'));
    await waitFor(() => expect(screen.getAllByText('Questo file non è un’esportazione di GPU Bench.').length).toBeGreaterThan(0));
    await upload();
    expect(api.calls.filter((c) => c.path === '/api/runs/import')).toHaveLength(5);
  });

  it('empty, loading, failing and refreshed lists', async () => {
    const api = benchApi({ runs: [] });
    const gate = deferred<unknown>();
    api.world.routes['GET /api/runs'] = () => gate.promise;
    const { container } = renderApp('/results', api);
    await waitFor(() => expect(container.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0));
    await act(async () => gate.reject(apiError('INTERNAL', undefined, 500)));
    expect(await screen.findByRole('heading', { name: 'Si è verificato un errore imprevisto' })).toBeTruthy();
    delete api.world.routes['GET /api/runs'];
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(await screen.findByRole('heading', { name: 'Ancora nessun risultato' })).toBeTruthy();
    // The core says the folder changed (a run finished, another PC synced): the list refreshes.
    api.world.runs = [seeded(IDS.full)];
    act(() => api.emit({ type: 'runs.changed' }));
    expect(await screen.findByText('1 risultato')).toBeTruthy();
    expect(screen.queryByText('Altro PC')).toBeNull();
    expect(HOST).toBe('WORKSTATION');
  });
});
