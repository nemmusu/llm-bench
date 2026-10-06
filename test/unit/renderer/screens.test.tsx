import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOCK_RUN_ID, mockRunSummaries } from '../../../src/renderer/mock/runs';
import { fakeApi, renderApp } from './helpers';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({
  AxisPointerComponent: {},
  DataZoomComponent: {},
  GridComponent: {},
  LegendComponent: {},
  MarkAreaComponent: {},
  MarkLineComponent: {},
  TooltipComponent: {},
}));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

describe('welcome', () => {
  it('first launch redirects to the wizard and walks through it', async () => {
    const api = fakeApi({ onboardingDone: false });
    renderApp('/', api);
    expect(await h1('Benvenuto in GPU Bench')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Navigazione principale' })).toBeNull();
    expect(await screen.findByText('Driver NVIDIA')).toBeTruthy();
    expect(screen.getByText('Versione 617.14 · CUDA 13.4')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Installa · 480 MB/ })).toBeTruthy();
    expect((await screen.findByLabelText('Versione 0.1.0')).textContent).toBe('v0.1.0');
    expect(screen.getByRole('button', { name: 'Indietro' }).hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Continua' }));
    expect(await screen.findByRole('heading', { name: 'Configurazione consigliata', level: 2 })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Indietro' }));
    expect(await screen.findByRole('heading', { name: 'Controllo del sistema', level: 2 })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Continua' }));
    await userEvent.click(screen.getByRole('button', { name: 'Usa questa configurazione' }));
    expect(await screen.findByRole('heading', { name: 'Tutto pronto!' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Vai al Benchmark' }));
    expect(await h1('Benchmark')).toBeTruthy();
    expect(api.settings.onboardingDone).toBe(true);
    expect(api.settings.lastModelId).toBe('qwen3-8b-q4km');
  });

  it('can be skipped', async () => {
    const api = fakeApi({ onboardingDone: false });
    renderApp('/welcome', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Salta, lo farò dopo' }));
    expect(await h1('Benchmark')).toBeTruthy();
    await waitFor(() => expect(api.settings.onboardingDone).toBe(true));
  });
});

describe('benchmark', () => {
  it('shows the three choices, the hero and the GPU', async () => {
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Pronto a misurare la tua RTX 5090' })).toBeTruthy();
    expect(await screen.findByText('Prima scarico llama.cpp: 480 MB in tutto.')).toBeTruthy();
    expect(screen.getByText('Verrà installato: 480 MB')).toBeTruthy();
    expect(screen.getByText('Entra perfettamente')).toBeTruthy();
    expect(screen.getByText('Provato su questa GPU · 191 tok/s')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'VRAM' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Durata' })).toBeTruthy();
    expect(await screen.findByText('Ultimi risultati')).toBeTruthy();
  });

  it('picks a model that must be downloaded', async () => {
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: /Cambia modello: Qwen3 8B/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Scegli un modello' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /Llama 3\.1 8B Instruct/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Conferma' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Verrà scaricato: 4,6 GB')).toBeTruthy();
    expect(screen.getByText(/Prima scarico llama\.cpp e Llama 3\.1 8B Instruct/)).toBeTruthy();
  });

  it('changes duration and starts the run', async () => {
    const api = fakeApi({ onboardingDone: true });
    renderApp('/', api);
    await userEvent.click(await screen.findByRole('radio', { name: /Standard/ }));
    expect(screen.getByText(/Caricamento a freddo e a caldo/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Avvia benchmark' }));
    expect(await h1('Test in corso')).toBeTruthy();
    await waitFor(() => expect(api.settings.lastProfile).toBe('standard'));
  });

  it('expert mode shows every parameter and the exact command', async () => {
    const pickFile = vi.fn(async () => 'C:\\llama\\llama-server.exe');
    (window as { gpubench?: unknown }).gpubench = { platform: 'win32', pickFile, setTitleBarTheme: async () => undefined };
    const api = fakeApi({ onboardingDone: true });
    renderApp('/', api);
    await userEvent.click(await screen.findByRole('switch', { name: 'Modalità esperto' }));
    expect(await screen.findByRole('heading', { name: 'Parametri avanzati' })).toBeTruthy();
    const code = screen.getByLabelText('Anteprima comando', { selector: 'pre' });
    expect(code.textContent).toContain('--ctx-size 8192');
    fireEvent.change(screen.getByLabelText('Contesto (token)'), { target: { value: '16384' } });
    expect(code.textContent).toContain('--ctx-size 16384');
    fireEvent.change(screen.getByLabelText('Argomenti extra'), { target: { value: '--mlock' } });
    fireEvent.change(screen.getByLabelText('Variabili d’ambiente'), { target: { value: 'CUDA_VISIBLE_DEVICES=1' } });
    expect(code.textContent).toContain('--mlock');
    expect(code.textContent).toContain("$env:CUDA_VISIBLE_DEVICES = '1'");
    await userEvent.click(screen.getByRole('button', { name: 'Sfoglia…' }));
    await waitFor(() => expect(code.textContent).toContain('C:\\llama\\llama-server.exe'));
    await waitFor(() => expect(api.settings.expertMode).toBe(true));
  });

  it('expert mode with a Docker engine shows the image field', async () => {
    renderApp('/', fakeApi({ onboardingDone: true, expertMode: true, lastEngine: { kind: 'vllm-docker' }, lastProfile: 'custom' }));
    expect(await screen.findByLabelText('Immagine Docker')).toBeTruthy();
    expect(screen.getByText('Ottimo con molti utenti insieme. Richiede Docker.', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText(/Installato/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Immagine Docker'), { target: { value: 'vllm/vllm-openai:nightly' } });
    expect(screen.getByLabelText('Anteprima comando', { selector: 'pre' }).textContent).toContain('vllm/vllm-openai:nightly');
  });

  it('browse does nothing without the desktop bridge or when cancelled', async () => {
    renderApp('/', fakeApi({ onboardingDone: true, expertMode: true }));
    await userEvent.click(await screen.findByRole('button', { name: 'Sfoglia…' }));
    (window as { gpubench?: unknown }).gpubench = { platform: 'linux', pickFile: async () => null };
    await userEvent.click(screen.getByRole('button', { name: 'Sfoglia…' }));
    expect((screen.getByLabelText('Eseguibile personalizzato') as HTMLInputElement).value).toBe('');
  });
});

describe('live run', () => {
  it('shows phases, gauges, telemetry and log, and cancels after confirmation', async () => {
    const info = vi.spyOn(toast, 'message');
    renderApp(`/run/${MOCK_RUN_ID}`);
    expect(await h1('Test in corso')).toBeTruthy();
    const phases = screen.getByRole('list', { name: 'Fasi del test' });
    expect(within(phases).getAllByRole('listitem')).toHaveLength(9);
    expect(within(phases).getByText('Generazione').closest('li')!.getAttribute('aria-current')).toBe('step');
    expect(screen.getByRole('meter', { name: 'Generazione' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Avanzamento del test' })).toBeTruthy();
    expect(screen.getByText(/Il modello sta scrivendo testo di prova/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mostra tabella' }));
    expect(screen.getByRole('table')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Nascondi il log del server' }));
    expect(screen.queryByLabelText('Log del server', { selector: 'pre' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Mostra il log del server' }));
    expect(screen.getByLabelText('Log del server', { selector: 'pre' }).textContent).toContain('tokens per second');
    await userEvent.click(screen.getByRole('button', { name: 'Annulla test' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Vuoi annullare il test?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continua il test' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Annulla test' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Annulla il test' }));
    expect(await h1('Benchmark')).toBeTruthy();
    void info;
  });
});

describe('result', () => {
  it('explains the run in plain words with KPIs, charts and warnings', async () => {
    renderApp(`/results/${MOCK_RUN_ID}`);
    expect(await h1(/Qwen3 8B/)).toBeTruthy();
    expect(screen.getByText('1012')).toBeTruthy();
    expect(screen.getByText(/Scrive circa 133 parole al secondo/)).toBeTruthy();
    expect(screen.getByRole('img', { name: /Tu leggi circa 4 parole/ })).toBeTruthy();
    expect(screen.getByText('Altri programmi stavano usando la GPU')).toBeTruthy();
    expect(screen.getByText(/llama-server\.exe \(PID 18244\) occupava 2,3 GB/)).toBeTruthy();
    const kpis = screen.getByRole('region', { name: 'Numeri principali' });
    for (const label of ['Generazione', 'Lettura prompt', 'Primo token', 'Efficienza', 'Caricamento a freddo', 'Caricamento a caldo', 'VRAM di picco', 'Più utenti']) {
      expect(within(kpis).getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('Ottima')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Lettura prompt' }));
    expect(screen.getByRole('heading', { name: 'Più utenti insieme' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Scheda video durante il test' })).toBeTruthy();
    const tableButtons = screen.getAllByRole('button', { name: 'Mostra tabella' });
    for (const b of tableButtons) await userEvent.click(b);
    expect(screen.getAllByRole('table').length).toBe(3);
  });

  it('validity actions lead somewhere useful', async () => {
    const { router } = renderApp(`/results/${MOCK_RUN_ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Attiva misure a freddo reali' }));
    expect(await h1('Impostazioni')).toBeTruthy();
    act(() => void router.navigate({ to: '/results/$runId', params: { runId: MOCK_RUN_ID } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Rifai il test' }));
    expect(await h1('Benchmark')).toBeTruthy();
    const other = mockRunSummaries.find((s) => s.validity.includes('throttling'))!;
    act(() => void router.navigate({ to: '/results/$runId', params: { runId: other.id } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Apri Monitor GPU' }));
    expect(await h1('Monitor GPU')).toBeTruthy();
  });

  it('details tab shows sortable tables', async () => {
    renderApp(`/results/${MOCK_RUN_ID}`);
    await userEvent.click(await screen.findByRole('tab', { name: 'Dettagli' }));
    const table = screen.getByRole('table', { name: 'Velocità per lunghezza del prompt' });
    const promptHeader = within(table).getByRole('columnheader', { name: /Prompt/ });
    expect(promptHeader.getAttribute('aria-sort')).toBe('ascending');
    await userEvent.click(within(promptHeader).getByRole('button'));
    expect(promptHeader.getAttribute('aria-sort')).toBe('descending');
    expect(screen.getByRole('table', { name: 'Caricamento del modello' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Sistema' }).textContent).toContain('AMD Ryzen 9 9950X3D');
    expect(screen.getByRole('table', { name: 'Più utenti' })).toBeTruthy();
  });

  it('launch tab: summary, command, re-run, reuse and serve-only', async () => {
    const success = vi.spyOn(toast, 'success');
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { router } = renderApp(`/results/${MOCK_RUN_ID}`);
    await userEvent.click(await screen.findByRole('tab', { name: 'Come è stato avviato' }));
    expect(screen.getByText('contesto 8192')).toBeTruthy();
    expect(screen.getByText('tutto in GPU')).toBeTruthy();
    expect(screen.getByLabelText('Mostra comando', { selector: 'pre' }).textContent).toContain('--n-gpu-layers 99');
    await userEvent.click(screen.getByRole('button', { name: 'Nascondi comando' }));
    expect(screen.queryByLabelText('Mostra comando', { selector: 'pre' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Mostra comando' }));
    await userEvent.click(screen.getByRole('button', { name: 'Avvia solo il server così' }));
    const dialog = await screen.findByRole('dialog', { name: 'Avvia solo il server' });
    expect(within(dialog).getByText('http://127.0.0.1:41873/v1')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Copia' }));
    expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:41873/v1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avvia il server' }));
    await userEvent.click(screen.getByRole('button', { name: 'Usa queste impostazioni' }));
    expect(await h1('Benchmark')).toBeTruthy();
    expect(success).toHaveBeenCalledWith('Impostazioni copiate nel Benchmark');
    act(() => void router.navigate({ to: '/results/$runId', params: { runId: MOCK_RUN_ID } }));
    await userEvent.click(await screen.findByRole('tab', { name: 'Come è stato avviato' }));
    await userEvent.click(screen.getByRole('button', { name: 'Rifai questo benchmark' }));
    expect(await h1('Benchmark')).toBeTruthy();
  });

  it('log tab and export menu', async () => {
    const success = vi.spyOn(toast, 'success');
    renderApp(`/results/${MOCK_RUN_ID}`);
    await userEvent.click(await screen.findByRole('tab', { name: 'Log' }));
    expect(screen.getByLabelText('Log del server (estratto)', { selector: 'pre' }).textContent).toContain('ggml_cuda_init');
    await userEvent.click(screen.getByRole('button', { name: 'Esporta' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'CSV per Excel (italiano)' }));
    expect(success).toHaveBeenCalledWith('Esportazione pronta: CSV per Excel (italiano)');
  });

  it('a run without warnings, score or success', async () => {
    const vllm = mockRunSummaries.find((s) => s.engineKind === 'vllm-docker')!;
    const failed = mockRunSummaries.find((s) => s.status === 'failed')!;
    const clean = mockRunSummaries.find((s) => s.validity.length === 0 && s.status === 'completed')!;
    const { router } = renderApp(`/results/${vllm.id}`);
    expect(await screen.findByText('Il punteggio si calcola solo con i profili standard.')).toBeTruthy();
    act(() => void router.navigate({ to: '/results/$runId', params: { runId: failed.id } }));
    expect(await screen.findByText('Non riuscito')).toBeTruthy();
    act(() => void router.navigate({ to: '/results/$runId', params: { runId: clean.id } }));
    await screen.findByText(clean.modelName, { selector: 'span' });
    expect(screen.queryByText('Da sapere su questo risultato')).toBeNull();
  });
});

describe('results list', () => {
  it('lists, filters and opens runs', async () => {
    renderApp('/results');
    expect(await h1('Risultati')).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Risultati' });
    expect(within(table).getAllByRole('row')).toHaveLength(mockRunSummaries.length + 1);
    expect(screen.getByText('Altro PC')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Cerca' }), { target: { value: 'gemma' } });
    expect(screen.getByText('1 risultati')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Cerca' }), { target: { value: 'nessuno' } });
    expect(screen.getByText('Nessuna riga da mostrare.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Cerca' }), { target: { value: '' } });
    await userEvent.click(within(table).getByRole('button', { name: /Generazione/ }));
    await userEvent.click(within(table).getByRole('button', { name: /Punteggio/ }));
    await userEvent.click(within(table).getByRole('button', { name: /Lettura prompt/ }));
    await userEvent.click(within(table).getByRole('button', { name: /VRAM picco/ }));
    await userEvent.click(within(table).getAllByRole('row')[1]!);
    expect(await h1(/./)).toBeTruthy();
  });

  it('model links open the detail', async () => {
    renderApp('/results');
    const table = await screen.findByRole('table', { name: 'Risultati' });
    await userEvent.click(within(table).getAllByRole('link', { name: /Gemma 4 31B/ })[0]!);
    expect(await h1(/Gemma 4 31B/)).toBeTruthy();
  });
});

describe('other pages', () => {
  it('compare highlights differences', async () => {
    renderApp('/compare');
    expect(await h1('Confronta')).toBeTruthy();
    expect(screen.getAllByText('(migliore)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('(peggiore)').length).toBeGreaterThan(0);
    expect(screen.getByRole('table', { name: 'Parametri di avvio' })).toBeTruthy();
  });

  it('models: library, recommendations, search and downloads', async () => {
    const api = fakeApi({ onboardingDone: true });
    renderApp('/models', api);
    expect(await h1('Modelli')).toBeTruthy();
    expect(await screen.findByText('C:\\models\\Qwen3-8B-Q4_K_M.gguf')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: /Consigliati/ }));
    expect(screen.getByRole('button', { name: /Scarica · 4,6 GB/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: /Cerca su Hugging Face/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Cerca' }), { target: { value: 'qwen' } });
    expect(screen.getByRole('heading', { name: 'Cerca tra migliaia di modelli' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: /Download/ }));
    expect(screen.getByRole('progressbar', { name: 'Qwen3 30B A3B · Q4_K_M' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: /Sul tuo PC/ }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Fai il benchmark' })[1]!);
    expect(await h1('Benchmark')).toBeTruthy();
    await waitFor(() => expect(api.settings.lastModelId).toBe('gemma4-31b-q4km'));
  });

  it('engines list their state and fixes', async () => {
    renderApp('/engines');
    expect(await h1('Motori')).toBeTruthy();
    expect(await screen.findByText('Non disponibile su questo sistema')).toBeTruthy();
    expect(screen.getAllByText('Docker non avviato')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Installa · 480 MB/ })).toBeTruthy();
    expect(screen.getByText('Da configurare')).toBeTruthy();
  });

  it('monitor shows live tiles, charts and GPU users', async () => {
    renderApp('/monitor');
    expect(await h1('Monitor GPU')).toBeTruthy();
    expect(await screen.findByText('llama-server.exe')).toBeTruthy();
    expect(screen.getByText('Non avviato da GPU Bench')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Mostra tabella' })[0]!);
    expect(screen.getByRole('table', { name: 'Dati del grafico «Utilizzo (%)»' })).toBeTruthy();
  });

  it('settings change appearance and options', async () => {
    const pickFolder = vi.fn(async () => 'D:\\Risultati');
    const saveHfToken = vi.fn(async () => ({ ok: true, secure: true }));
    (window as { gpubench?: unknown }).gpubench = { platform: 'win32', pickFolder, saveHfToken, setTitleBarTheme: async () => undefined };
    const api = fakeApi({ onboardingDone: true });
    renderApp('/settings', api);
    expect(await h1('Impostazioni')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Scuro' }));
    await waitFor(() => expect(api.settings.theme).toBe('dark'));
    await userEvent.click(screen.getByRole('radio', { name: 'Compatta' }));
    await waitFor(() => expect(api.settings.density).toBe('compact'));
    await userEvent.click(screen.getByRole('switch', { name: 'Modalità esperto' }));
    await waitFor(() => expect(api.settings.expertMode).toBe(true));
    await userEvent.click(screen.getByRole('switch', { name: 'Misure a freddo reali (Windows)' }));
    await waitFor(() => expect(api.settings.coldCacheOptIn).toBe(true));
    await userEvent.click(screen.getAllByRole('button', { name: 'Scegli cartella…' })[0]!);
    await waitFor(() => expect(api.settings.resultsDir).toBe('D:\\Risultati'));
    pickFolder.mockResolvedValueOnce(null as unknown as string);
    await userEvent.click(screen.getAllByRole('button', { name: 'Scegli cartella…' })[1]!);
    expect(api.settings.modelsDir).toBe('');
    fireEvent.change(screen.getByLabelText('Token di accesso'), { target: { value: 'hf_abc' } });
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }));
    expect(saveHfToken).toHaveBeenCalledWith('hf_abc');
    await waitFor(() => expect(api.settings.hasHfToken).toBe(true));
    expect(screen.getByRole('combobox', { name: 'Lingua' }).textContent).toContain('Italiano');
  });

  it('settings without the desktop bridge', async () => {
    renderApp('/settings', fakeApi({ onboardingDone: true, resultsDir: 'E:\\Shared' }));
    expect(await screen.findByText('E:\\Shared')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Scegli cartella…' })[0]!);
    fireEvent.change(screen.getByLabelText('Token di accesso'), { target: { value: 'hf_x' } });
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Sistema' }));
  });
});
