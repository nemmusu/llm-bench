import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as echarts from 'echarts/core';
import { bridge, fail, libApi, patchPointer, renderLib, run, sample, system, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeEach(() => patchPointer());
afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

describe('monitor', () => {
  it('live tiles, three-minute charts with tables, throttling and other GPU users', async () => {
    const api = libApi(world({ snapshot: [sample(1000, { throttle: ['gpu_idle', 'sw_thermal_slowdown'] })] }));
    let t = 1000;
    api.on('GET /api/telemetry/snapshot', () => [sample((t += 1000), { utilPct: 50, throttle: ['gpu_idle', 'sw_thermal_slowdown'] })]);
    renderLib('/monitor', api);
    expect(await h1('Monitor GPU')).toBeTruthy();
    const tiles = await screen.findByRole('region', { name: 'Valori dal vivo' });
    expect(await within(tiles).findByText('50')).toBeTruthy();
    expect(within(tiles).getByText('3,0')).toBeTruthy();
    expect(within(tiles).getByText('di 31,8 GB')).toBeTruthy();
    expect(within(tiles).getByText('di 575 W')).toBeTruthy();
    expect(within(tiles).getByText('Memoria: 14.000 MHz')).toBeTruthy();
    expect(within(tiles).getByText('4.0')).toBeTruthy();
    expect(within(tiles).getByText('Massimo 5.0 x16')).toBeTruthy();
    expect(screen.getByText('temperatura alta')).toBeTruthy();
    expect(screen.queryByText(/gpu_idle/)).toBeNull();
    // Charts get a fixed three-minute axis.
    await waitFor(() => expect(vi.mocked(echarts.init).mock.results.length).toBeGreaterThan(4));
    const chart = vi.mocked(echarts.init).mock.results[0]!.value as { setOption: ReturnType<typeof vi.fn> };
    await waitFor(() => expect(chart.setOption).toHaveBeenCalled());
    const option = chart.setOption.mock.calls.at(-1)![0] as { xAxis: { min: number } };
    expect(option.xAxis.min).toBe(-180);
    await userEvent.click(screen.getAllByRole('button', { name: 'Mostra tabella' })[1]!);
    const table = screen.getByRole('table', { name: 'Dati del grafico «Memoria video (GB)»' });
    expect(within(table).getByText('-0:00')).toBeTruthy();
    const users = screen.getByRole('list', { name: 'Altri programmi che usano la GPU' });
    expect(within(users).getByText('llama-server.exe')).toBeTruthy();
    expect(within(users).getByText('2,0 GB')).toBeTruthy();
    expect(within(users).getAllByText('Server LLM')).toHaveLength(2);
    expect(within(users).getByText('Macchina virtuale')).toBeTruthy();
    expect(within(users).getByText('Programma')).toBeTruthy();
    expect(within(users).getAllByText('memoria non nota')).toHaveLength(3);
    expect(screen.getByText(/possono falsare i risultati/)).toBeTruthy();
    expect(screen.getByText('AMD Ryzen 9 9950X3D')).toBeTruthy();
    expect(screen.getByText('Driver 617.14 · CUDA 13.4')).toBeTruthy();
  });

  it('missing readings show dashes; no users; no NVIDIA telemetry at all', async () => {
    const api = libApi(
      world({
        system: system({ otherGpuUsers: [], gpus: [{ ...system().gpus[0]!, powerLimitW: undefined, pcieGenMax: undefined, driverVersion: undefined, cudaVersion: undefined }] }),
        snapshot: [sample(1, { utilPct: null, memUsedMiB: null, memTotalMiB: null, powerW: null, tempC: null, smClockMHz: null, memClockMHz: null, pcieGen: null, pcieWidth: null })],
      }),
    );
    renderLib('/monitor', api);
    const tiles = await screen.findByRole('region', { name: 'Valori dal vivo' });
    await waitFor(() => expect(within(tiles).getAllByText('–')).toHaveLength(6));
    expect(screen.getByText('Nessun altro programma sta usando la GPU.')).toBeTruthy();
    expect(screen.getByText('Driver – · CUDA –')).toBeTruthy();
    api.w.snapshot = [];
    renderLib('/monitor', libApi(world({ snapshot: [], system: system({ gpus: [] }) })));
    expect(await screen.findByRole('heading', { name: 'Telemetria non disponibile' })).toBeTruthy();
  });

  it('a failing snapshot is explained', async () => {
    const api = libApi(world({ system: system({ gpus: [], cpu: { model: 'x', cores: 1, threads: 1 } }) }));
    api.on('GET /api/telemetry/snapshot', () => fail('GPU_NOT_FOUND', 503));
    renderLib('/monitor', api);
    expect(await screen.findByText('Nessuna scheda video NVIDIA trovata')).toBeTruthy();
  });

  it('a GPU listed but not readable', async () => {
    renderLib('/monitor', libApi(world({ snapshot: [] })));
    expect(await screen.findByRole('heading', { name: 'Telemetria non disponibile' })).toBeTruthy();
    expect(screen.getByText('NVIDIA GeForce RTX 5090')).toBeTruthy();
  });

  it('PCIe maximum without width', async () => {
    renderLib('/monitor', libApi(world({ system: system({ gpus: [{ ...system().gpus[0]!, pcieWidthMax: undefined }] }) })));
    expect(await screen.findByText('Massimo 5.0 x–')).toBeTruthy();
  });

  it('a GPU with an unknown total memory', async () => {
    const api = libApi(world({ system: system({ gpus: [{ ...system().gpus[0]!, memoryTotalMiB: 0 }] }), snapshot: [sample(1, { memTotalMiB: null })] }));
    renderLib('/monitor', api);
    const tiles = await screen.findByRole('region', { name: 'Valori dal vivo' });
    await within(tiles).findByText('12');
    expect(within(tiles).queryByText(/^di /)).toBeTruthy();
  });
});

describe('settings', () => {
  it('appearance, expert mode, interval and language', async () => {
    const api = libApi();
    renderLib('/settings', api);
    expect(await h1('Impostazioni')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Scuro' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Compatta' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Modalità esperto' }));
    await waitFor(() => expect(api.w.settings).toMatchObject({ theme: 'dark', density: 'compact', expertMode: true }));
    const interval = screen.getByRole('combobox', { name: 'Letture della GPU durante i test' });
    interval.focus();
    fireEvent.keyDown(interval, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: '1 al secondo' }));
    await waitFor(() => expect(api.w.settings.telemetryIntervalMs).toBe(1000));
    const lang = screen.getByRole('combobox', { name: 'Lingua' });
    lang.focus();
    fireEvent.keyDown(lang, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'English' }));
    expect(await h1('Settings')).toBeTruthy();
    expect(screen.getByText('Real cold measurements')).toBeTruthy();
    await waitFor(() => expect(api.w.settings.language).toBe('en'));
  });

  it('folders: results, models, extra folders, known locations; each change rescans', async () => {
    const b = bridge({ pickFolder: vi.fn(async () => 'D:\\Shared') });
    const api = libApi();
    renderLib('/settings', api);
    expect(await screen.findByText('C:\\Data\\LLM Bench\\results')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Scegli cartella… Cartella dei risultati' }));
    await waitFor(() => expect(api.w.settings.resultsDir).toBe('D:\\Shared'));
    b.pickFolder.mockResolvedValueOnce('E:\\Models');
    await userEvent.click(screen.getByRole('button', { name: 'Scegli cartella… Cartella dei modelli' }));
    await waitFor(() => expect(api.w.settings.modelsDir).toBe('E:\\Models'));
    expect(await screen.findByText('E:\\Models')).toBeTruthy();
    b.pickFolder.mockResolvedValueOnce('F:\\More');
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi cartella' }));
    const list = await screen.findByRole('list', { name: 'Altre cartelle con modelli' });
    expect(within(list).getByText('F:\\More')).toBeTruthy();
    // The same folder again: scanned again, and said so.
    b.pickFolder.mockResolvedValueOnce('F:\\More');
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi cartella' }));
    expect(await screen.findByText('La cartella è già nell’elenco: l’ho ricontrollata')).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: 'Togli F:\\More' }));
    await waitFor(() => expect(api.w.settings.extraModelDirs).toEqual([]));
    await userEvent.click(screen.getByRole('switch', { name: 'Cerca anche nelle cartelle note' }));
    await waitFor(() => expect(api.w.settings.scanKnownLocations).toBe(false));
    expect(api.calls.filter((c) => c.path === '/api/models/rescan')).toHaveLength(5);
    b.pickFolder.mockResolvedValue(null);
    for (const name of ['Scegli cartella… Cartella dei risultati', 'Scegli cartella… Cartella dei modelli', 'Aggiungi cartella']) await userEvent.click(screen.getByRole('button', { name }));
    // A rescan that fails says why (the folder is already listed: only the rescan runs).
    b.pickFolder.mockResolvedValueOnce('G:\\Again');
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi cartella' }));
    expect(await within(await screen.findByRole('list', { name: 'Altre cartelle con modelli' })).findByText('G:\\Again')).toBeTruthy();
    api.on('POST /api/models/rescan', () => fail('DISK_FULL', 507));
    b.pickFolder.mockResolvedValueOnce('G:\\Again');
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi cartella' }));
    expect(await screen.findByText('Spazio su disco esaurito')).toBeTruthy();
    api.on('PUT /api/settings', () => fail('VALIDATION'));
    await userEvent.click(screen.getByRole('switch', { name: 'Cerca anche nelle cartelle note' }));
    expect(await screen.findByText('Alcuni valori non sono validi')).toBeTruthy();
  });

  it('folders without the desktop bridge show the defaults and do nothing', async () => {
    const api = libApi(world({ system: system(), settings: { ...world().settings, modelsDir: 'G:\\M' } }));
    api.on('GET /api/system', () => fail('INTERNAL', 500));
    renderLib('/settings', api);
    expect(await screen.findByText('G:\\M')).toBeTruthy();
    expect(screen.getByText('Cartella predefinita')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Scegli cartella… Cartella dei risultati' }));
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('Hugging Face token: saved securely, never shown, removable; insecure and failed saves', async () => {
    const b = bridge();
    const api = libApi();
    renderLib('/settings', api);
    const field = await screen.findByLabelText('Token di accesso');
    expect((screen.getByRole('button', { name: 'Salva' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(field, '  hf_abc  ');
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }));
    expect(b.saveHfToken).toHaveBeenCalledWith('hf_abc');
    expect(await screen.findByText('Salvato in modo sicuro')).toBeTruthy();
    expect(screen.queryByDisplayValue('hf_abc')).toBeNull();
    await waitFor(() => expect(api.w.settings.hasHfToken).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Rimuovi' }));
    expect(b.clearHfToken).toHaveBeenCalled();
    await waitFor(() => expect(api.w.settings.hasHfToken).toBe(false));
    b.saveHfToken.mockResolvedValueOnce({ ok: true, secure: false });
    await userEvent.type(await screen.findByLabelText('Token di accesso'), 'hf_plain');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Salvato, ma senza cifratura')).toBeTruthy();
    expect(screen.getByText(/non ha un portachiavi/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Rimuovi' }));
    b.saveHfToken.mockResolvedValueOnce({ ok: false, secure: false });
    await userEvent.type(await screen.findByLabelText('Token di accesso'), 'hf_rejected');
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }));
    expect(await screen.findByText('Non sono riuscito a salvare il token')).toBeTruthy();
  });

  it('a token cannot be saved without the desktop bridge', async () => {
    renderLib('/settings', libApi());
    await userEvent.type(await screen.findByLabelText('Token di accesso'), 'hf_x');
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }));
    expect((await screen.findAllByText('Non sono riuscito a salvare il token')).length).toBeGreaterThan(0);
  });

  it('real cold measurements on Windows: explained opt-in, UAC declined, opt-out', async () => {
    const api = libApi();
    let declined = true;
    api.on('POST /api/cache/windows-task', () => (declined ? fail('CANCELLED', 409) : { method: 'windows-standby', automatic: false, windowsTaskInstalled: true }));
    renderLib('/settings', api);
    const sw = await screen.findByRole('switch', { name: 'Misure a freddo reali' });
    await userEvent.click(sw);
    const ask = await screen.findByRole('alertdialog', { name: 'Attivare le misure a freddo reali?' });
    expect(within(ask).getByText(/«PurgeStandby» di LLM Bench/)).toBeTruthy();
    await userEvent.click(within(ask).getByRole('button', { name: 'Attiva' }));
    expect(await screen.findByText('Richiesta di Windows annullata: non è cambiato nulla.')).toBeTruthy();
    declined = false;
    await userEvent.click(sw);
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Attiva' }));
    expect(await screen.findByText('Misure a freddo reali attivate')).toBeTruthy();
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    await userEvent.click(sw);
    const off = await screen.findByRole('alertdialog', { name: 'Disattivare le misure a freddo reali?' });
    await userEvent.click(within(off).getByRole('button', { name: 'Annulla' }));
    await userEvent.click(sw);
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disattiva' }));
    expect(await screen.findByText('Misure a freddo reali disattivate')).toBeTruthy();
    api.on('DELETE /api/cache/windows-task', () => fail('INTERNAL', 500));
    await userEvent.click(sw);
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Attiva' }));
    await userEvent.click(sw);
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disattiva' }));
    expect(await screen.findByText('Si è verificato un errore imprevisto')).toBeTruthy();
  });

  it('cold measurements: automatic on Linux, unavailable elsewhere, unknown on error', async () => {
    renderLib('/settings', libApi(world({ cold: { method: 'linux-fadvise', automatic: true } })));
    expect(await screen.findByText('Automatico')).toBeTruthy();
    expect(screen.getByText('Su Linux lo faccio da solo, senza permessi speciali.')).toBeTruthy();
  });

  it('cold measurements unavailable or failing', async () => {
    const { unmount } = renderLib('/settings', libApi(world({ cold: { method: 'none', automatic: false } })));
    expect(await screen.findByText('Non disponibile')).toBeTruthy();
    unmount();
    const api = libApi();
    api.on('GET /api/cache/cold', () => fail('INTERNAL', 500));
    renderLib('/settings', api);
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/cache/cold')).toBe(true));
    expect(await screen.findAllByText('–')).toBeTruthy();
  });

  it('exports every result and imports a file', async () => {
    const b = bridge();
    const api = libApi(world({ runs: [run('a'), run('b')] }));
    renderLib('/settings', api);
    expect(await screen.findByText('2 risultati in un file .llmbench')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Esporta…' }));
    expect(await screen.findByText('Esportati 2 risultati')).toBeTruthy();
    expect(api.calls.find((c) => c.path === '/api/runs/export')?.body).toEqual({ ids: ['a', 'b'] });
    expect(b.saveFile.mock.calls[0]![0]).toMatchObject({ content: '{"format":"gpubench","version":1,"runs":[]}' });
    b.saveFile.mockResolvedValueOnce(null);
    await userEvent.click(screen.getByRole('button', { name: 'Esporta…' }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    await userEvent.click(screen.getByRole('button', { name: 'Importa…' }));
    expect(click).toHaveBeenCalled();
    await userEvent.upload(input, new File(['{"format":"gpubench"}'], 'r.gpubench', { type: 'application/json' }));
    expect(await screen.findByText('Importati 2 risultati (già presenti: 1)')).toBeTruthy();
    api.on('POST /api/runs/import', (body) => (body && Object.keys(body as object).length ? { imported: 0, skipped: 0 } : fail('VALIDATION')));
    await userEvent.upload(input, new File(['not json'], 'bad.gpubench'));
    expect(await screen.findByText('Alcuni valori non sono validi')).toBeTruthy();
    fireEvent.change(input, { target: { files: [] } });
  });

  it('nothing to export', async () => {
    renderLib('/settings', libApi());
    expect(await screen.findByText('Ancora nessun risultato da esportare.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Esporta…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('export errors; one result reads in the singular', async () => {
    bridge();
    const api = libApi(world({ runs: [run('a')] }));
    api.on('POST /api/runs/export', () => fail('RUN_NOT_FOUND', 404));
    renderLib('/settings', api);
    expect(await screen.findByText('1 risultato in un file .llmbench')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Esporta…' }));
    expect(await screen.findByText('Risultato non trovato')).toBeTruthy();
  });

  it('about: version, credits with links, data folder', async () => {
    const b = bridge();
    renderLib('/settings', libApi());
    expect(await screen.findByText('versione 0.1.0')).toBeTruthy();
    expect(screen.getByText('Le idee per la stima della memoria video vengono da llmfit.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'llmfit' }));
    expect(b.openExternal).toHaveBeenCalledWith('https://github.com/AlexsJones/llmfit');
    await userEvent.click(screen.getByRole('button', { name: 'Apri la cartella' }));
    expect(b.revealPath).toHaveBeenCalledWith('C:\\Data\\LLM Bench');
  });

  it('one result exports in the singular', async () => {
    bridge();
    renderLib('/settings', libApi(world({ runs: [run('only')] })));
    await userEvent.click(await screen.findByRole('button', { name: 'Esporta…' }));
    expect(await screen.findByText('Esportato 1 risultato')).toBeTruthy();
  });
});
