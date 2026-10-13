/** "Avvia un server": the one start flow, opened from the Benchmark page, a result, the Models page or a preset. */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerInfo, ServerPlan, StartServerRequest } from '../../../../src/contract/api';
import type { CustomEngineInfo } from '../../../../src/contract/custom-engines';
import type { DownloadJob } from '../../../../src/contract/models';
import { renderApp } from '../helpers';
import { apiError, benchApi, curatedModel, deferred, localModel, serverInfo, serverPlanFor, serverPreset } from '../bench/world';
import { engineChoices } from '../../../../src/renderer/components/servers/server-flow';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

const clipboard = { writeText: vi.fn(async (_t: string) => undefined) };
beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { gpubench?: unknown }).gpubench;
});

type Api = ReturnType<typeof benchApi>;
const posted = (api: Api, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);
const lastPlan = (api: Api) => posted(api, '/api/servers/plan').at(-1)?.body as StartServerRequest;
const job = (over: Partial<DownloadJob> = {}): DownloadJob => ({ id: 'j', label: 'g', files: [], dest: 'x', state: 'running', bytesDone: 0, createdAt: '2026-10-06T00:00:00.000Z', ...over });
const notInstalled = () => benchApi().world.engines.map((e) => (e.kind === 'llamacpp-native' ? { ...e, installed: false, available: false } : e));
const avvia = () => screen.getByRole('button', { name: /^(Avvia|Scarica e avvia)$/ });

async function choose(combobox: string, option: string | RegExp) {
  const trigger = screen.getByRole('combobox', { name: combobox });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

/** The flow, opened straight (no draft): the first model on the PC, llama.cpp. */
async function openFlow(api: Api) {
  const r = renderApp('/servers/new', api);
  await screen.findByRole('heading', { level: 1, name: 'Avvia un server' });
  await screen.findByRole('region', { name: 'Comando esatto' });
  return r;
}

/** "Avvia solo il server" on the Benchmark page. */
async function fromBenchmark(api: Api) {
  const r = renderApp('/', api);
  await screen.findAllByText('≈ 1 min 35 s');
  await userEvent.click(screen.getByRole('button', { name: 'Avvia solo il server' }));
  await screen.findByRole('heading', { level: 1, name: 'Avvia un server' });
  await screen.findByRole('region', { name: 'Comando esatto' });
  return r;
}

describe('Avvia un server: from the Benchmark page to a running server', () => {
  it('the model and engine chosen there, GPU Bench’s settings, the plan; Avvia starts it on the plan’s port and opens the Server page', async () => {
    const api = benchApi();
    const success = vi.spyOn(toast, 'success');
    const { router } = await fromBenchmark(api);
    expect(screen.getByRole('button', { name: /Cambia modello: qwen3-8b model Q4_K_M/ })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Motore' }).textContent).toContain('llama.cpp');
    // Beginners send no settings: the core picks them for this card.
    expect(lastPlan(api)).toEqual({ engine: { kind: 'llamacpp-native' }, model: { localId: 'qwen3-8b' }, network: 'local' });
    expect(screen.getByRole('radio', { name: /Scelte da GPU Bench/ }).getAttribute('data-state')).toBe('checked');
    expect(screen.getByText('L’ho scelto perché entri bene nella tua scheda video.')).toBeTruthy();
    expect(screen.getByText('Entra perfettamente')).toBeTruthy();
    expect(screen.getByText('http://127.0.0.1:8080/v1')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Comando esatto' }).textContent).toContain('-c 32768');
    expect(screen.queryByText('Prima di avviarlo preparo')).toBeNull();
    await userEvent.click(avvia());
    // Always the plan's port, so it is the same port every time.
    await waitFor(() => expect(posted(api, '/api/servers')[0]!.body).toEqual({ engine: { kind: 'llamacpp-native' }, model: { localId: 'qwen3-8b' }, network: 'local', port: 8080 }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/servers'));
    expect(success).toHaveBeenCalledWith('Il server di qwen3-8b model è pronto');
    expect(await screen.findByRole('region', { name: 'Server Qwen3 8B sulla porta 8080' })).toBeTruthy();
    // The Benchmark page's choices are remembered.
    await waitFor(() => expect(api.settings).toMatchObject({ lastEngine: { kind: 'llamacpp-native' }, lastModelId: 'qwen3-8b' }));
  });

  it('installs and downloads what is missing first, asks about a busy GPU, then starts', async () => {
    const api = benchApi({ engines: notInstalled(), local: [], curated: [curatedModel('gemma-12b')] });
    api.world.routes['POST /api/engines/llamacpp-native/install'] = () => ({ ok: true });
    api.world.routes['POST /api/downloads'] = () => job({ id: 'd1' });
    await openFlow(api);
    expect(await screen.findByText('Prima di avviarlo preparo')).toBeTruthy();
    expect(screen.getByText('Installo llama.cpp')).toBeTruthy();
    expect(screen.getByText('Scarico gemma-12b · Q4_K_M')).toBeTruthy();
    expect(screen.getByText('Il modello da usare. Resta sul PC anche dopo.')).toBeTruthy();
    // Once everything is in place, the fresh preview sees another server on the GPU.
    api.world.serverPlan = () => serverPlanFor({ warnings: [{ code: 'VRAM_BUSY', params: { names: 'ollama.exe', pids: '77' } }] });
    await userEvent.click(screen.getByRole('button', { name: 'Scarica e avvia' }));
    const progress = await screen.findByRole('dialog', { name: 'Preparo il server' });
    expect(within(progress).getByText('Appena è tutto pronto il server parte da solo.')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'done', bytesDone: 1, bytesTotal: 1 }));
    await waitFor(() => expect(posted(api, '/api/downloads')).toHaveLength(1));
    api.world.local = [localModel('gemma-12b')];
    act(() => api.emit({ type: 'download.update', job: job({ id: 'd1', state: 'done', bytesDone: 1, bytesTotal: 1 }) }));
    const busy = await screen.findByRole('dialog', { name: 'La scheda video è già occupata' });
    expect(within(busy).getByText(/Posso avviare il server lo stesso/)).toBeTruthy();
    expect(within(busy).getByText('ollama.exe (PID 77)')).toBeTruthy();
    await userEvent.click(within(busy).getByRole('button', { name: 'Continua comunque' }));
    await waitFor(() => expect(posted(api, '/api/servers')).toHaveLength(1));
    // The same request: the core finds the copy just downloaded.
    expect(posted(api, '/api/servers')[0]!.body).toMatchObject({ engine: { kind: 'llamacpp-native' }, model: { repo: 'org/gemma-12b-GGUF', file: 'gemma-12b.gguf' }, port: 8080 });
  });

  it('a failed install says it could not prepare the server', async () => {
    const api = benchApi({ engines: notInstalled() });
    api.world.routes['POST /api/engines/llamacpp-native/install'] = () => {
      throw apiError('GITHUB_RATE_LIMITED');
    };
    await openFlow(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Scarica e avvia' }));
    expect(await screen.findByRole('dialog', { name: 'Non sono riuscito a preparare il server' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'GitHub ha limitato le richieste' })).toBeTruthy();
  });

  it('no preview possible: said, and nothing to start or save', async () => {
    const api = benchApi();
    api.world.serverPlan = () => {
      throw apiError('NETWORK', undefined, 0);
    };
    renderApp('/servers/new', api);
    expect(await screen.findByRole('heading', { name: 'Connessione a internet non disponibile' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Avvia' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Salva come preset' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a start that fails says why, and lets the choices be changed', async () => {
    const failing = benchApi();
    failing.world.routes['POST /api/servers'] = () => {
      throw apiError('RUN_IN_PROGRESS', { runId: '01K6Y7Q2ZC4M8N3B5V9R1T0XWE' }, 409);
    };
    await openFlow(failing);
    await userEvent.click(avvia());
    const dialog = await screen.findByRole('dialog', { name: 'Il server non è partito' });
    expect(within(dialog).getByRole('heading', { name: 'C’è già un test in corso' })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cambia le scelte' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('"Continua in background": the Server page follows it; when it is ready (or fails) a message says so', async () => {
    const api = benchApi();
    const started = deferred<ServerInfo>();
    api.world.routes['POST /api/servers'] = () => started.promise;
    const success = vi.spyOn(toast, 'success');
    const { router } = await openFlow(api);
    await userEvent.click(avvia());
    const dialog = await screen.findByRole('dialog', { name: 'Avvio il server…' });
    expect(within(dialog).getByText('Avvio il motore e carico il modello…')).toBeTruthy();
    // The core lists it while it loads: its loading line shows in the dialog.
    api.world.servers = [serverInfo('late', { port: 8080, loading: { stage: 'weights', elapsedMs: 3000, fraction: 0.4, done: 2, total: 5 } })];
    await waitFor(() => expect(within(dialog).getByRole('progressbar')).toBeTruthy());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continua in background' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/servers'));
    await act(async () => started.resolve(serverInfo('late')));
    await waitFor(() => expect(success).toHaveBeenCalledWith('Il server di qwen3-8b model è pronto'));
  });

  it('a start in the background that fails says so in a message', async () => {
    const error = vi.spyOn(toast, 'error');
    const later = benchApi();
    const failing = deferred<ServerInfo>();
    later.world.routes['POST /api/servers'] = () => failing.promise;
    await openFlow(later);
    await userEvent.click(avvia());
    await userEvent.click(await screen.findByRole('button', { name: 'Continua in background' }));
    await act(async () => failing.reject(apiError('ENGINE_OOM')));
    await waitFor(() => expect(error).toHaveBeenCalledWith('Il server non è partito', { description: 'Memoria della scheda video insufficiente' }));
  });

  it('the Benchmark page’s expert parameters arrive in "Comandi personalizzati", as chosen', async () => {
    const api = benchApi();
    api.settings.expertMode = true;
    api.settings.lastParams = { contextSize: 16384, extraArgs: ['--metrics'], env: {} };
    await fromBenchmark(api);
    expect(screen.getByRole('tab', { name: 'Comandi personalizzati' }).getAttribute('data-state')).toBe('active');
    expect((screen.getByLabelText('Contesto (token)') as HTMLInputElement).value).toBe('16384');
    expect((screen.getByLabelText('Argomenti extra') as HTMLTextAreaElement).value).toBe('--metrics');
    await waitFor(() => expect(lastPlan(api).params).toMatchObject({ contextSize: 16384, extraArgs: ['--metrics'] }));
    expect(await screen.findByText('Viene dalle impostazioni scelte.')).toBeTruthy();
  });
});

describe('Avvia un server: where the settings come from', () => {
  it('"Le migliori dai tuoi test": GPU Bench’s choice from the latest tune, and this model’s configurations with their numbers', async () => {
    const api = benchApi();
    const tuned = { runId: '01K6Y7Q2ZC4M8N3B5V9R1T0XWE', createdAt: '2026-10-07T10:00:00.000Z', contextSize: 65536, kvCacheType: 'q4_0' as const, otherBuild: { build: 'b10997', current: 'b11438' } };
    api.world.serverPlan = (body) => serverPlanFor({ ...((body as StartServerRequest).params ? { params: (body as StartServerRequest).params! } : { tuned }), port: 8080 });
    await openFlow(api);
    expect(await screen.findByText(/Dal test «Trova le impostazioni migliori» del 07\/10: contesto 64K, cache q4_0\./)).toBeTruthy();
    expect(screen.getByText(/Contesto 64K e cache q4_0 dal test «Trova le impostazioni migliori» del 07\/10\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Apri il risultato' }).getAttribute('href')).toBe('/results/01K6Y7Q2ZC4M8N3B5V9R1T0XWE');
    expect(screen.getByText('Il test è stato fatto con b10997; ora usi b11438: fai un ricontrollo rapido.')).toBeTruthy();
    // The configurations of this model on this card, fastest first, with their speed at their deepest point.
    const tested = screen.getAllByRole('radio').filter((r) => / tok\/s a /.test(r.textContent ?? ''));
    expect(tested.length).toBeGreaterThan(0);
    await userEvent.click(tested[0]!);
    // The test's own settings are read and sent.
    await waitFor(() => expect(lastPlan(api).params?.contextSize).toBeDefined());
    expect(screen.getByText('Viene dalle impostazioni scelte.')).toBeTruthy();
    // Saved as a preset with where it comes from.
    await userEvent.click(screen.getByRole('button', { name: 'Salva come preset' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salva come preset' });
    expect(within(dialog).getByText('Ricorda modello, motore, impostazioni, argomenti extra e porta 8080.')).toBeTruthy();
    await userEvent.clear(within(dialog).getByLabelText('Nome'));
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Dal test');
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(posted(api, '/api/servers/presets')).toHaveLength(1));
    expect(posted(api, '/api/servers/presets')[0]!.body).toMatchObject({ name: 'Dal test', autoStart: true, port: 8080, network: 'local', model: { localId: 'qwen3-8b' }, source: { kind: 'config' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('GPU Bench’s own choice saved as a preset says it came from the tune', async () => {
    const api = benchApi();
    const tuned = { runId: 'r-tune', createdAt: '2026-10-07T10:00:00.000Z', contextSize: 65536, kvCacheType: 'q4_0' as const, goal: 'multi' as const, users: 4 };
    api.world.serverPlan = () => serverPlanFor({ tuned });
    await openFlow(api);
    expect(await screen.findByText(/per 4 utenti dal test/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Salva come preset' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(posted(api, '/api/servers/presets')[0]!.body).toMatchObject({ name: 'qwen3-8b model', source: { kind: 'tuned', runId: 'r-tune' } }));
  });

  it('a name already used is said next to the field', async () => {
    const api = benchApi();
    api.world.presets = [serverPreset('p1', { name: 'Chat', model: { localId: 'other' } })];
    await openFlow(api);
    await userEvent.click(screen.getByRole('button', { name: 'Salva come preset' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salva come preset' });
    const name = within(dialog).getByLabelText('Nome');
    await userEvent.clear(name);
    expect((within(dialog).getByRole('button', { name: 'Salva' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(name, 'chat');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva' }));
    expect(await within(dialog).findByText('C’è già un preset con questo nome.')).toBeTruthy();
    // Enter in the field saves too.
    fireEvent.submit(name.closest('form')!);
    await waitFor(() => expect(posted(api, '/api/servers/presets')).toHaveLength(2));
    await userEvent.type(name, ' 2');
    expect(within(dialog).queryByText('C’è già un preset con questo nome.')).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('"I tuoi preset": a preset of this model brings its settings, port and network', async () => {
    const api = benchApi();
    api.world.presets = [serverPreset('p1', { name: 'Rete', port: 8095, network: 'lan' }), serverPreset('p2', { name: 'Altro modello', model: { localId: 'st' } }), serverPreset('p3', { name: 'Senza porta', port: undefined })];
    await openFlow(api);
    await userEvent.click(screen.getByRole('tab', { name: 'I tuoi preset' }));
    expect(screen.getByText('Gli altri preset sono nella pagina Server.')).toBeTruthy();
    expect(screen.getByText(/Porta automatica/)).toBeTruthy();
    // No preset chosen yet: nothing to start.
    expect((avvia() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: /Rete/ }));
    expect((screen.getByLabelText('Porta') as HTMLInputElement).value).toBe('8095');
    await waitFor(() => expect(lastPlan(api)).toMatchObject({ port: 8095, network: 'lan', params: { contextSize: 16384, kvCacheType: 'q8_0' } }));
    expect(await screen.findByText('Altri dispositivi della tua rete potranno usare il modello')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: /Senza porta/ }));
    expect((screen.getByLabelText('Porta') as HTMLInputElement).value).toBe('');
  });

  it('"I tuoi preset" is empty for a model without presets', async () => {
    const api = benchApi();
    await openFlow(api);
    await userEvent.click(screen.getByRole('tab', { name: 'I tuoi preset' }));
    expect(screen.getByText('Nessun preset per questo modello.')).toBeTruthy();
    expect(screen.queryByText('Gli altri preset sono nella pagina Server.')).toBeNull();
  });

  it('NInfer: its built-in presets, ready to start or save as one’s own', async () => {
    const ninfer = localModel('qwen38', { format: 'ninfer', displayName: 'Qwen3.8-27B-nvfp4', file: 'qwen.ninfer', quant: 'NVFP4', facts: { name: 'qwen3.8-27b' } });
    const api = benchApi({ local: [ninfer] });
    await openFlow(api);
    expect(screen.getByRole('combobox', { name: 'Motore' }).textContent).toContain('NInfer (WSL)');
    await userEvent.click(screen.getByRole('tab', { name: 'I tuoi preset' }));
    expect(screen.getAllByText('Predefinito')).toHaveLength(2);
    await userEvent.click(screen.getByRole('radio', { name: /Provata su RTX 5090/ }));
    await waitFor(() => expect(lastPlan(api)).toMatchObject({ engine: { kind: 'ninfer-wsl' }, params: { contextSize: 65536, parallel: 2, ninfer: { kvDtype: 'int8' } } }));
    await userEvent.click(screen.getByRole('tab', { name: 'Comandi personalizzati' }));
    expect(screen.getByLabelText('Contesto (token)')).toBeTruthy();
    expect(screen.queryByLabelText('Livelli in GPU')).toBeNull();
  });

  it('"Comandi personalizzati": starts from the chosen settings; invalid values stop the start; a fork’s missing flags are said', async () => {
    const api = benchApi();
    api.world.serverPlan = (body) => {
      const req = body as StartServerRequest;
      return serverPlanFor({
        ...(req.params ? { params: req.params, contextSize: req.params.contextSize ?? 32768 } : {}),
        warnings: [{ code: 'flag_unsupported', params: { engine: 'PrismML', flags: '-ub', settings: 'ubatchSize' } }],
      });
    };
    await openFlow(api);
    await userEvent.click(screen.getByRole('tab', { name: 'Comandi personalizzati' }));
    expect((screen.getByLabelText('Contesto (token)') as HTMLInputElement).value).toBe('32768');
    expect(screen.getByText('PrismML non accetta alcune impostazioni')).toBeTruthy();
    expect(screen.getByText('Lascio fuori dal comando -ub: vale il valore predefinito del motore.')).toBeTruthy();
    await userEvent.clear(screen.getByLabelText('Contesto (token)'));
    await userEvent.type(screen.getByLabelText('Contesto (token)'), 'tanto');
    expect(screen.getAllByText('Valore non valido: lo ignoro finché non lo correggi.').length).toBeGreaterThan(0);
    expect((avvia() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(screen.getByLabelText('Contesto (token)'));
    await userEvent.type(screen.getByLabelText('Contesto (token)'), '8192');
    await userEvent.type(screen.getByLabelText('Variabili d’ambiente'), 'non valida');
    expect(screen.getByText('Usa NOME=valore, una per riga.')).toBeTruthy();
    await userEvent.clear(screen.getByLabelText('Variabili d’ambiente'));
    await userEvent.type(screen.getByLabelText('Variabili d’ambiente'), 'A=1');
    await userEvent.type(screen.getByLabelText('Argomenti extra'), '--metrics');
    await choose('Tipo di cache KV', 'q4_0');
    await choose('Flash attention', 'Attivo');
    await userEvent.type(screen.getByLabelText('Batch'), '1024');
    await waitFor(() => expect(lastPlan(api).params).toMatchObject({ contextSize: 8192, kvCacheType: 'q4_0', flashAttention: 'on', batchSize: 1024, extraArgs: ['--metrics'], env: { A: '1' } }));
    // Back to "Le migliori dai tuoi test" and to the form again: what was typed stays.
    await userEvent.click(screen.getByRole('tab', { name: 'Le migliori dai tuoi test' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Comandi personalizzati' }));
    expect((screen.getByLabelText('Contesto (token)') as HTMLInputElement).value).toBe('8192');
  });

  it('vLLM and SGLang take their own parameters', async () => {
    const api = benchApi({ local: [localModel('st', { format: 'safetensors', repo: 'Qwen/Qwen3-8B-FP8', file: undefined })] });
    await openFlow(api);
    expect(screen.getByRole('combobox', { name: 'Motore' }).textContent).toContain('vLLM (Docker)');
    await userEvent.click(screen.getByRole('tab', { name: 'Comandi personalizzati' }));
    await userEvent.type(screen.getByLabelText('Contesto massimo (token)'), '8192');
    await userEvent.type(screen.getByLabelText('Memoria GPU da usare'), '0,8');
    await waitFor(() => expect(lastPlan(api).params).toMatchObject({ maxModelLen: 8192, gpuMemoryUtilization: 0.8 }));
  });
});

describe('Avvia un server: model, engine, port and network', () => {
  it('the model picker groups what reads each model; a Hugging Face model offers vLLM and SGLang', async () => {
    const api = benchApi();
    await openFlow(api);
    await userEvent.click(screen.getByRole('button', { name: /Cambia modello/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Scegli un modello' });
    expect(within(dialog).getByText('GGUF · llama.cpp')).toBeTruthy();
    expect(within(dialog).getByText('Hugging Face · vLLM e SGLang')).toBeTruthy();
    expect(within(dialog).getAllByText('Da scaricare').length).toBeGreaterThan(0);
    await userEvent.click(within(dialog).getByRole('radio', { name: /^st model/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Conferma' }));
    await waitFor(() => expect(lastPlan(api).engine).toEqual({ kind: 'vllm-docker' }));
    const trigger = screen.getByRole('combobox', { name: 'Motore' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('SGLang (Docker)'), expect.stringContaining('vLLM')]));
    // vLLM installed on the system is not supported on this PC.
    expect(options.find((o) => /^vLLM(?! \()/.test(o.textContent ?? ''))?.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(options.find((o) => /SGLang \(Docker\)/.test(o.textContent ?? ''))!);
    await waitFor(() => expect(lastPlan(api).engine).toEqual({ kind: 'sglang-docker' }));
    // Picked a suggestion to download: said under the model.
    await userEvent.click(screen.getByRole('button', { name: /Cambia modello/ }));
    const again = await screen.findByRole('dialog', { name: 'Scegli un modello' });
    await userEvent.click(within(again).getAllByRole('radio', { name: /gemma-12b/ })[0]!);
    await userEvent.click(within(again).getByRole('button', { name: 'Annulla' }));
    await userEvent.click(screen.getByRole('button', { name: /Cambia modello/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Scegli un modello' })).getAllByRole('radio', { name: /gemma-12b/ })[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Conferma' }));
    expect(await screen.findByText('Da scaricare')).toBeTruthy();
  });

  it('custom engines: a fork of llama.cpp under its base, with the settings it does not take', async () => {
    const fork: CustomEngineInfo = {
      engine: { schema: 1, id: 'prismml', name: 'PrismML fork', base: 'llamacpp', run: { mode: 'native', path: 'C:\\prism\\llama-server.exe' }, extraArgs: [], env: {}, notes: '' },
      kind: 'llamacpp-native',
      config: { kind: 'llamacpp-native', customEngineId: 'prismml' },
      check: { kind: 'llamacpp-native', status: { kind: 'llamacpp-native', available: true, installed: true, problems: [], supported: true }, flagCount: 120, missing: [{ flag: '-ub', setting: 'ubatchSize', effect: 'default' }, { flag: '-m', setting: 'model', effect: 'required' }] },
    };
    const command: CustomEngineInfo = {
      engine: { schema: 1, id: 'mine', name: 'Il mio server', base: 'openai-server', run: { mode: 'command', template: 'srv --port {port}', api: 'chat' }, extraArgs: [], env: {}, notes: '' },
      kind: 'command',
      config: { kind: 'command', customEngineId: 'mine' },
      check: { kind: 'command', status: { kind: 'command', available: true, installed: true, problems: [], supported: true }, flagCount: 0, missing: [] },
    };
    const vllmFork: CustomEngineInfo = { ...fork, engine: { ...fork.engine, id: 'v', name: 'vLLM fork', base: 'vllm', run: { mode: 'docker', image: 'me/vllm:1' } }, kind: 'vllm-docker', config: { kind: 'vllm-docker', customEngineId: 'v' } };
    const api = benchApi({ custom: [fork, command, vllmFork] });
    await openFlow(api);
    await choose('Motore', 'llama.cpp · PrismML fork');
    await waitFor(() => expect(lastPlan(api).engine).toEqual({ kind: 'llamacpp-native', customEngineId: 'prismml' }));
    expect(screen.getByText('PrismML fork non accetta -ub: per queste impostazioni vale il suo valore predefinito.')).toBeTruthy();
    // A command template is the user's own program: it cannot be shared on the network.
    await choose('Motore', 'Programma con API OpenAI · Il mio server');
    expect((screen.getByRole('switch', { name: 'Rendi raggiungibile dalla rete locale' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Questo motore è un tuo programma: non posso condividerlo in rete con una chiave.')).toBeTruthy();
    expect(screen.queryByRole('option', { name: /vLLM fork/ })).toBeNull();
    // Grouped as the Benchmark lists them: each fork right under its base, the user's own programs last.
    const unsupported = { kind: 'llamacpp-docker' as const, available: false, installed: false, problems: [], supported: false };
    const dockerFork: CustomEngineInfo = { ...fork, engine: { ...fork.engine, id: 'd', name: 'Docker fork', run: { mode: 'docker', image: 'me/llama:1' } }, kind: 'llamacpp-docker', config: { kind: 'llamacpp-docker', customEngineId: 'd' } };
    expect(engineChoices('gguf', [unsupported], [command, fork, dockerFork, vllmFork], 'win32').map((c) => [c.key, c.base, c.disabled])).toEqual([
      ['builtin:llamacpp-native', undefined, false],
      ['custom:prismml', 'llamacpp', false],
      ['builtin:llamacpp-docker', undefined, true],
      ['custom:d', 'llamacpp', true],
      ['custom:mine', 'openai-server', false],
    ]);
  });

  it('the port: automatic, chosen, invalid, or already in use (by another program or by one of ours)', async () => {
    const api = benchApi();
    api.world.serverPlan = (body) => {
      const req = body as StartServerRequest;
      const port = req.port ?? 8080;
      const warnings: ServerPlan['warnings'] = port === 9000 ? [{ code: 'port_taken', params: { port } }] : port === 9001 ? [{ code: 'port_ours', params: { port, model: 'Qwen' } }] : [];
      return serverPlanFor({ port, warnings });
    };
    await openFlow(api);
    const field = screen.getByLabelText('Porta') as HTMLInputElement;
    expect(field.placeholder).toBe('8080');
    await userEvent.type(field, '80');
    expect(screen.getByText('Scegli una porta da 1024 a 65535.')).toBeTruthy();
    expect((avvia() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(field);
    await userEvent.type(field, '9000');
    expect(await screen.findByText('La porta 9000 è già usata da un altro programma: scegline un’altra.')).toBeTruthy();
    expect((avvia() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(field);
    await userEvent.type(field, '9001');
    expect(await screen.findByText('La porta 9001 è già usata da un server di GPU Bench: scegline un’altra o fermalo.')).toBeTruthy();
    await userEvent.clear(field);
    await userEvent.type(field, '9002');
    await waitFor(() => expect(lastPlan(api).port).toBe(9002));
    await waitFor(() => expect((avvia() as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('http://127.0.0.1:9002/v1')).toBeTruthy();
  });

  it('the local network: a clear warning, the API key (hidden, shown, copied, new), where it is kept, the addresses', async () => {
    const api = benchApi();
    const success = vi.spyOn(toast, 'success');
    await openFlow(api);
    await userEvent.click(screen.getByRole('switch', { name: 'Rendi raggiungibile dalla rete locale' }));
    expect(screen.getByText('Altri dispositivi della tua rete potranno usare il modello')).toBeTruthy();
    expect(await screen.findByText('••••••••••••')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mostra la chiave' }));
    expect(screen.getByText('gpub-test-key-0123456789abcdef')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Nascondi la chiave' }));
    await userEvent.click(screen.getByRole('button', { name: 'Copia la chiave API' }));
    expect(clipboard.writeText).toHaveBeenCalledWith('gpub-test-key-0123456789abcdef');
    await waitFor(() => expect(lastPlan(api).network).toBe('lan'));
    expect(await screen.findAllByText('http://192.168.1.20:8080/v1')).not.toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Genera una nuova chiave' }));
    await waitFor(() => expect(success).toHaveBeenCalledWith('Nuova chiave pronta: i server già accesi usano la vecchia finché non li riavvii.'));
    await userEvent.click(screen.getByRole('button', { name: 'Mostra la chiave' }));
    expect(screen.getByText('gpub-test-key-0123456789abcdef-new')).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: 'Rendi raggiungibile dalla rete locale' }));
    expect(await screen.findByText('http://127.0.0.1:8080/v1')).toBeTruthy();
    expect(screen.queryByText('Altri dispositivi della tua rete potranno usare il modello')).toBeNull();
  });

  it('where the key is kept: no keyring (plain); no network found', async () => {
    const plain = benchApi({ apiKey: { key: 'gpub-plain-key-0123456789', storage: 'plain' } });
    plain.world.serverPlan = (body) => serverPlanFor({ network: (body as StartServerRequest).network ?? 'local', lanUrls: [] });
    await openFlow(plain);
    await userEvent.click(screen.getByRole('switch', { name: 'Rendi raggiungibile dalla rete locale' }));
    expect(await screen.findByText(/non ha un portachiavi del sistema/)).toBeTruthy();
    expect(screen.getByText('Nessuna rete trovata: collega il PC a una rete.')).toBeTruthy();
  });

  it('where the key is kept: only this session (browser mode)', async () => {
    const memory = benchApi({ apiKey: { key: 'gpub-mem-key-0123456789', storage: 'memory' } });
    await openFlow(memory);
    await userEvent.click(screen.getByRole('switch', { name: 'Rendi raggiungibile dalla rete locale' }));
    expect(await screen.findByText('La chiave vale solo finché GPU Bench resta aperto.')).toBeTruthy();
  });

  it('no model on the PC and no suggestion: the way to the Models page', async () => {
    const api = benchApi({ local: [], curated: [] });
    const { router } = renderApp('/servers/new', api);
    expect(await screen.findByText('Nessun modello sul PC')).toBeTruthy();
    expect(screen.getByText('Scegli un modello per vedere l’anteprima.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Apri Modelli' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/models'));
  });

  it('"Torna ai server"', async () => {
    const api = benchApi();
    const { router } = await openFlow(api);
    await userEvent.click(screen.getByRole('link', { name: 'Torna ai server' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/servers'));
  });
});

describe('Avvia un server: opened by other pages', () => {
  it('"Modifica" a preset: its settings chosen, "Aggiorna il preset" saves the changes', async () => {
    const api = benchApi();
    api.world.presets = [serverPreset('p1', { name: 'Chat veloce', port: 8095 })];
    const { router } = renderApp('/servers', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Modifica il preset Chat veloce' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Modifica «Chat veloce»' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'I tuoi preset' }).getAttribute('data-state')).toBe('active');
    await waitFor(() => expect((screen.getByLabelText('Porta') as HTMLInputElement).value).toBe('8095'));
    await screen.findByRole('region', { name: 'Comando esatto' });
    await userEvent.click(screen.getByRole('button', { name: 'Aggiorna il preset' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/servers'));
    expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/servers/presets/p1')?.body).toMatchObject({ port: 8095, network: 'local', model: { localId: 'qwen3-8b' } });
  });

  it('a preset that cannot be updated says why', async () => {
    const api = benchApi();
    api.world.presets = [serverPreset('p1', { name: 'Chat veloce' })];
    api.world.routes['PUT /api/servers/presets/p1'] = () => {
      throw apiError('VALIDATION', { reason: 'preset_name_taken' });
    };
    const error = vi.spyOn(toast, 'error');
    renderApp('/servers', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Modifica il preset Chat veloce' }));
    await screen.findByRole('region', { name: 'Comando esatto' });
    await userEvent.click(screen.getByRole('button', { name: 'Aggiorna il preset' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('Alcuni valori non sono validi'));
  });
});
