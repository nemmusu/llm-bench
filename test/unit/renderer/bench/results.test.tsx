import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../helpers';
import { HOST, IDS, seeded, seededRuns, summaries } from './fixtures';
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
    // Units in every header; every speed says what it was measured on; the most users served at once (when measured).
    for (const name of ['Generazione (tok/s)', 'Lettura prompt (tok/s)', 'Contesto (token)', 'Più utenti (tok/s)', 'VRAM picco (GB)']) {
      expect(screen.getByRole('columnheader', { name })).toBeTruthy();
    }
    // Over its short numbers the VRAM name stays on one line; the model column takes the room left and cuts long names.
    // "VRAM picco" may wrap like the other headers (nine columns share a 1024 px window).
    expect(screen.getByRole('columnheader', { name: 'VRAM picco (GB)' }).querySelector('.whitespace-normal')?.textContent).toBe('VRAM picco');
    expect(screen.getByRole('columnheader', { name: /^Modello/ }).className).toContain('max-w-0');
    const mistral = (await screen.findByRole('link', { name: /Mistral Small/ })).closest('tr')!;
    expect(within(mistral).getByText('a 512 token di contesto')).toBeTruthy();
    expect(within(mistral).getByText('prompt da 512 token')).toBeTruthy();
    expect(within(mistral).getByText('1.024')).toBeTruthy();
    expect(within(mistral).getAllByText('–').length).toBeGreaterThan(0);
    // The card next to the engine (its backend and the card's full name on hover); the score next to the profile.
    const engine = within(mistral).getByText('llama.cpp b11438 · RTX 5090');
    expect(engine.getAttribute('title')).toBe('llama.cpp b11438 (CUDA 13.4) · NVIDIA GeForce RTX 5090');
    expect(within(mistral).getByRole('link', { name: /Mistral Small/ }).getAttribute('title')).toMatch(/^Mistral Small 3\.2 24B Q4_K_M$/);
    const gemma = screen.getByRole('link', { name: /Gemma 4 31B/ }).closest('tr')!;
    expect(within(gemma).getByText('8.192')).toBeTruthy();
    expect(within(gemma).getByText('prompt da 4K')).toBeTruthy();
    expect(within(gemma).getByText('Standard · 486 punti')).toBeTruthy();
    // What each user got with how many, over the prompt each sent; everyone together in the whole sentence on hover.
    const users = within(gemma).getByText('4 utenti');
    expect(users.parentElement!.textContent).toMatch(/^\d+ ciascuno · 4 utenti$/);
    const cell = users.parentElement!.parentElement!;
    expect(within(cell).getByText('prompt da 512 token')).toBeTruthy();
    expect(cell.getAttribute('title')).toMatch(/^Generazione con 4 utenti insieme, prompt da 512 token ciascuno: [\d,]+ tok\/s per utente, [\d.]+ tok\/s in tutto\.$/);
    // What went wrong sits next to the model.
    const cancelled = screen.getByRole('link', { name: /Qwen3 14B/ }).closest('tr')!;
    expect(within(cancelled).getByText('Annullato')).toBeTruthy();
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
    await userEvent.click(screen.getByRole('button', { name: /Lettura prompt/ }));
    // A model link and a row both open the detail.
    await userEvent.click(screen.getByRole('link', { name: /Gemma 4 31B/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/results/${IDS.gemma}`));
    await userEvent.click(await screen.findByRole('link', { name: 'Tutti i risultati' }));
    const row = (await screen.findByRole('link', { name: /Mistral Small/ })).closest('tr')!;
    await userEvent.click(within(row).getAllByRole('cell')[1]!);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/results/${IDS.quick}`));
  });

  it('several users on older runs: everyone together when each user was not measured, the users alone when neither', async () => {
    const api = benchApi();
    const [gemma, moe, ...rest] = summaries(seededRuns()).filter((r) => r.parallelUsers !== undefined);
    api.world.routes['GET /api/runs'] = () => [
      { ...gemma!, parallelPerUserTps: undefined, parallelTps: 155 },
      { ...moe!, parallelPerUserTps: undefined, parallelTps: undefined, parallelPromptTokens: undefined, vramPeakMiB: 0 },
      ...rest,
    ];
    renderApp('/results', api);
    await screen.findByText(/^\d+ risultati$/);
    const row = (id: string) => document.querySelector(`a[href*="${id}"]`)!.closest('tr')!;
    const together = within(row(gemma!.id)).getByText(`${gemma!.parallelUsers} utenti`).parentElement!;
    expect(together.textContent).toBe(`155 in tutto · ${gemma!.parallelUsers} utenti`);
    expect(together.parentElement!.getAttribute('title')).toBe(`Generazione con ${gemma!.parallelUsers} utenti insieme, prompt da 512 token ciascuno: 155 tok/s in tutto.`);
    const alone = within(row(moe!.id)).getByText(`${moe!.parallelUsers} utenti`).parentElement!;
    expect(alone.textContent).toBe(`${moe!.parallelUsers} utenti`);
    expect(alone.parentElement!.getAttribute('title')).toBeNull();
    expect(alone.parentElement!.children).toHaveLength(1);
    // No memory measured: a dash, not "0,0".
    expect(within(row(moe!.id)).queryByText('0,0')).toBeNull();
    expect(within(row(moe!.id)).getAllByText('–').length).toBeGreaterThan(0);
  });

  it('"Confronta" on each row fills the tray; it opens the comparison, older first', async () => {
    const api = benchApi();
    const { router } = renderApp('/results', api);
    await screen.findByText('9 risultati');
    // Selecting rows (export, delete) is not comparing them.
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona Gemma 4 31B/ }));
    expect(screen.getByText('9 risultati · 1 selezionato')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Da confrontare' })).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona Gemma 4 31B/ }));
    expect(screen.getByText('9 risultati')).toBeTruthy();
    // A failed run measured nothing: nothing to compare.
    const failed = screen.getByRole('link', { name: /Llama 3\.3 70B/ }).closest('tr')!;
    expect(within(failed).queryByRole('button', { name: /^Confronta/ })).toBeNull();
    const gemma = screen.getByRole('button', { name: /^Confronta Gemma 4 31B/ });
    await userEvent.click(gemma);
    expect(gemma.getAttribute('aria-pressed')).toBe('true');
    // The row did not open.
    expect(router.state.location.pathname).toBe('/results');
    const tray = screen.getByRole('region', { name: 'Da confrontare' });
    expect(within(tray).getByText('1 selezionato')).toBeTruthy();
    expect(within(tray).getByText('Scegline almeno un altro')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /^Confronta Qwen3 30B A3B/ }));
    expect(within(tray).getByText('2 selezionati')).toBeTruthy();
    await userEvent.click(within(tray).getByRole('button', { name: 'Confronta' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/compare'));
    expect(router.state.location.search).toEqual({ ids: `${IDS.moe},${IDS.gemma}` });
  });

  it('exports a selection as a .gpubench file', async () => {
    const api = benchApi();
    const bundle = { format: 'gpubench-export', version: 1, runs: [] };
    api.world.routes['POST /api/runs/export'] = () => bundle;
    const saveFile = vi.fn(async (_o: { defaultName: string }) =>'C:\\Users\\me\\scelti.llmbench');
    (window as { gpubench?: unknown }).gpubench = { saveFile, platform: 'win32', setTitleBarTheme: async () => undefined };
    renderApp('/results', api);
    await screen.findByText('9 risultati');
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleziona Gemma 4 31B/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Esporta (1)' }));
    expect(await screen.findByText('Esportato 1 risultato in C:\\Users\\me\\scelti.llmbench')).toBeTruthy();
    expect(saveFile.mock.calls[0]![0]).toMatchObject({ defaultName: expect.stringMatching(/^llmbench_\d{4}-\d\d-\d\d\.llmbench$/) as string });
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
    expect(await screen.findByText('Questo file non è un’esportazione di LLM Bench.')).toBeTruthy();
    answer = 'too_new';
    await upload(file('{}'));
    expect(await screen.findByText('Il file viene da una versione più recente di LLM Bench: aggiorna l’app per aprirlo.')).toBeTruthy();
    answer = 'other';
    await upload(file('{}'));
    expect(await screen.findByText('Spazio su disco esaurito')).toBeTruthy();
    answer = 'not_export';
    await upload(file('{}'));
    await waitFor(() => expect(screen.getAllByText('Questo file non è un’esportazione di LLM Bench.').length).toBeGreaterThan(0));
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
    // One card in the whole history: no need to repeat it on every row.
    expect(screen.getByText('llama.cpp b11438')).toBeTruthy();
    expect(HOST).toBe('WORKSTATION');
  });
});
