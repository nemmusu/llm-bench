/** The Server page: running servers (address, snippets, Ferma / Riavvia / Log), presets, notices; the sidebar cards. */
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerNotice } from '../../../../src/contract/servers';
import { useNow } from '../../../../src/renderer/components/servers/server-card';
import { renderApp } from '../helpers';
import { activeRun, apiError, benchApi, deferred, serverInfo, serverPreset } from '../bench/world';

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
  clipboard.writeText.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const HOUR = 3_600_000;
const card = (name: string) => screen.findByRole('region', { name });

describe('Server page', () => {
  it('nothing running, no presets: what a server is for, and the way to start one', async () => {
    const { router } = renderApp('/servers', benchApi());
    expect(await screen.findByText('Nessun server acceso')).toBeTruthy();
    expect(screen.getByText('Nessun preset salvato')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('link', { name: 'Avvia un server' })[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe('/servers/new'));
  });

  it('a running server: what it is, its address and model name to copy, ready snippets, uptime and VRAM', async () => {
    const api = benchApi();
    api.world.servers = [serverInfo('s1', { port: 8080, startedAt: new Date(Date.now() - 2 * HOUR - 5 * 60_000).toISOString(), vramMiB: 6144, blockCount: 36, modelName: 'Qwen3-8B-Q4_K_M' })];
    renderApp('/servers', api);
    const s = await card('Server Qwen3 8B sulla porta 8080');
    expect(within(s).getByRole('heading', { name: 'Qwen3 8B' })).toBeTruthy();
    expect(within(s).getByText('llama.cpp b11438')).toBeTruthy();
    expect(within(s).getByText('Acceso')).toBeTruthy();
    expect(within(s).getByText('Solo questo PC')).toBeTruthy();
    expect(within(s).getByText('32.768')).toBeTruthy();
    expect(within(s).getByText('6,0')).toBeTruthy();
    expect(within(s).getByText('2 h 05 min')).toBeTruthy();
    expect(within(s).getByText('Contesto 32.768 · cache KV f16')).toBeTruthy();
    await userEvent.click(within(s).getByRole('button', { name: 'Copia l’URL base di Qwen3 8B' }));
    expect(clipboard.writeText).toHaveBeenLastCalledWith('http://127.0.0.1:8080/v1');
    await userEvent.click(within(s).getByRole('button', { name: 'Copia il nome del modello di Qwen3 8B' }));
    expect(clipboard.writeText).toHaveBeenLastCalledWith('Qwen3-8B-Q4_K_M');
    // curl on bash, Invoke-RestMethod on PowerShell; the OpenAI SDK; the three settings for any client.
    expect(within(s).getByRole('region', { name: 'Da terminale' }).textContent).toContain('Invoke-RestMethod http://127.0.0.1:8080/v1/chat/completions');
    await userEvent.click(within(s).getByRole('radio', { name: 'Python (OpenAI)' }));
    expect(within(s).getByRole('region', { name: 'Python (OpenAI)' }).textContent).toContain('OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="llm-bench"');
    await userEvent.click(within(s).getByRole('radio', { name: 'Altri programmi' }));
    expect(within(s).getByText(/Chiave API: nessuna: lascia vuoto o scrivi qualsiasi testo/)).toBeTruthy();
    await userEvent.click(within(s).getByRole('button', { name: 'Copia le impostazioni' }));
    expect(clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining('Nome del modello: Qwen3-8B-Q4_K_M'));
    expect(within(s).queryByText('Qui la chiave è nascosta, ma la copia la contiene.')).toBeNull();
  });

  it('uptime: less than a minute, minutes, days', async () => {
    const api = benchApi();
    api.world.servers = [
      serverInfo('a', { port: 8080, startedAt: new Date().toISOString(), modelLabel: 'A' }),
      serverInfo('b', { port: 8081, startedAt: new Date(Date.now() - 7 * 60_000).toISOString(), modelLabel: 'B' }),
      serverInfo('c', { port: 8082, startedAt: new Date(Date.now() - 27 * HOUR).toISOString(), modelLabel: 'C', contextSize: undefined }),
    ];
    renderApp('/servers', api);
    expect(within(await card('Server A sulla porta 8080')).getByText('meno di un minuto')).toBeTruthy();
    expect(within(await card('Server B sulla porta 8081')).getByText('7 min')).toBeTruthy();
    const c = await card('Server C sulla porta 8082');
    expect(within(c).getByText('1 g 3 h')).toBeTruthy();
    // Unknown context and VRAM: a dash.
    expect(within(c).getAllByText('–')).toHaveLength(2);
  });

  it('a server shared on the local network: its addresses, the key hidden but copied, snippets with the key', async () => {
    const api = benchApi();
    api.world.servers = [serverInfo('lan', { port: 8081, network: 'lan', lanUrls: ['http://192.168.1.20:8081/v1', 'http://10.0.0.5:8081/v1'], presetId: 'p1', presetName: 'Team' })];
    renderApp('/servers', api);
    const s = await card('Server Team sulla porta 8081');
    expect(within(s).getByText('Rete locale')).toBeTruthy();
    expect(within(s).getByText('Qwen3 8B · llama.cpp b11438')).toBeTruthy();
    expect(within(s).getByText('http://10.0.0.5:8081/v1')).toBeTruthy();
    expect(await within(s).findByText('••••••••••••')).toBeTruthy();
    await userEvent.click(within(s).getByRole('button', { name: 'Mostra la chiave' }));
    expect(within(s).getByText('gpub-test-key-0123456789abcdef')).toBeTruthy();
    await userEvent.click(within(s).getByRole('button', { name: 'Nascondi la chiave' }));
    await userEvent.click(within(s).getByRole('button', { name: 'Copia la chiave API' }));
    expect(clipboard.writeText).toHaveBeenLastCalledWith('gpub-test-key-0123456789abcdef');
    // Shown hidden, copied whole.
    const http = within(s).getByRole('region', { name: 'Da terminale' });
    expect(http.textContent).toContain("Bearer ••••••••••••");
    expect(http.textContent).toContain('http://192.168.1.20:8081/v1');
    await userEvent.click(within(s).getByRole('button', { name: 'Copia il comando' }));
    expect(clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining('Bearer gpub-test-key-0123456789abcdef'));
    expect(within(s).getByText('Qui la chiave è nascosta, ma la copia la contiene.')).toBeTruthy();
    await userEvent.click(within(s).getByRole('radio', { name: 'Python (OpenAI)' }));
    expect(within(s).getByRole('region', { name: 'Python (OpenAI)' }).textContent).toContain('api_key="••••••••••••"');
    // Started from a preset: no "Salva come preset".
    expect(within(s).queryByRole('button', { name: 'Salva come preset' })).toBeNull();
  });

  it('a network server with no address found says so', async () => {
    const api = benchApi();
    api.world.servers = [serverInfo('lan', { port: 8081, network: 'lan', lanUrls: [] })];
    renderApp('/servers', api);
    const s = await card('Server Qwen3 8B sulla porta 8081');
    expect(within(s).getByText('Nessuna rete trovata: collega il PC a una rete.')).toBeTruthy();
  });

  it('a server still starting: its loading line; it cannot be restarted yet', async () => {
    const api = benchApi();
    api.world.servers = [serverInfo('s1', { loading: { stage: 'weights', elapsedMs: 3000, fraction: 0.4, done: 2, total: 5 } })];
    renderApp('/servers', api);
    const s = await card('Server Qwen3 8B sulla porta 5123');
    expect(within(s).getByText('Si avvia')).toBeTruthy();
    expect(within(s).getByRole('progressbar')).toBeTruthy();
    expect((within(s).getByRole('button', { name: 'Riavvia il server Qwen3 8B' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Ferma, Riavvia, Log, Ferma tutti; a failure is said', async () => {
    const api = benchApi();
    api.world.servers = [serverInfo('s1', { port: 8080 }), serverInfo('s2', { port: 8081, modelLabel: 'Gemma' })];
    api.world.logs = { s1: ['srv  listening on 127.0.0.1:8080', 'api_key: <API_KEY>'] };
    const success = vi.spyOn(toast, 'success');
    const info = vi.spyOn(toast, 'info');
    const error = vi.spyOn(toast, 'error');
    renderApp('/servers', api);
    const s1 = await card('Server Qwen3 8B sulla porta 8080');
    await userEvent.click(within(s1).getByRole('button', { name: 'Log del server Qwen3 8B' }));
    const log = await screen.findByRole('dialog', { name: 'Log di Qwen3 8B' });
    await waitFor(() => expect(within(log).getByRole('log').textContent).toBe('srv  listening on 127.0.0.1:8080\napi_key: <API_KEY>'));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(s1).getByRole('button', { name: 'Riavvia il server Qwen3 8B' }));
    expect(info).toHaveBeenCalledWith('Riavvio Qwen3 8B…');
    await waitFor(() => expect(success).toHaveBeenCalledWith('Qwen3 8B è di nuovo pronto'));
    api.world.routes['DELETE /api/servers/s2'] = () => {
      throw apiError('VALIDATION');
    };
    const s2 = await card('Server Gemma sulla porta 8081');
    await userEvent.click(within(s2).getByRole('button', { name: 'Ferma il server Gemma' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('Alcuni valori non sono validi'));
    delete api.world.routes['DELETE /api/servers/s2'];
    api.world.routes['POST /api/servers/s2/restart'] = () => {
      throw apiError('ENGINE_OOM');
    };
    await userEvent.click(within(s2).getByRole('button', { name: 'Riavvia il server Gemma' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('Memoria della scheda video insufficiente'));
    await userEvent.click(screen.getByRole('button', { name: 'Ferma tutti' }));
    await waitFor(() => expect(screen.getByText('Nessun server acceso')).toBeTruthy());
    expect(success).toHaveBeenCalledWith('Server di Gemma fermato');
  });

  it('a log with nothing yet', async () => {
    const api = benchApi();
    api.world.servers = [serverInfo('s1', { port: 8080 })];
    renderApp('/servers', api);
    const s1 = await card('Server Qwen3 8B sulla porta 8080');
    await userEvent.click(within(s1).getByRole('button', { name: 'Log del server Qwen3 8B' }));
    expect(await screen.findByText('Ancora nessuna riga.')).toBeTruthy();
  });

  it('"Salva come preset" from a running server keeps its port, network and settings', async () => {
    const api = benchApi();
    api.world.servers = [serverInfo('s1', { port: 8085, request: { engine: { kind: 'llamacpp-native' }, model: { localId: 'qwen3-8b' }, port: 8085, recipe: { use: false } } })];
    const success = vi.spyOn(toast, 'success');
    renderApp('/servers', api);
    const s1 = await card('Server Qwen3 8B sulla porta 8085');
    await userEvent.click(within(s1).getByRole('button', { name: 'Salva come preset' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salva come preset' });
    expect((within(dialog).getByLabelText('Nome') as HTMLInputElement).value).toBe('Qwen3 8B');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(success).toHaveBeenCalledWith('Preset «Qwen3 8B» salvato'));
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/servers/presets')?.body).toEqual({
      name: 'Qwen3 8B',
      engine: { kind: 'llamacpp-native' },
      model: { localId: 'qwen3-8b' },
      modelLabel: 'Qwen3 8B',
      params: { contextSize: 32768, extraArgs: [], env: {} },
      port: 8085,
      network: 'local',
      autoStart: false,
      source: { kind: 'custom' },
      recipe: { use: false },
    });
    // Without a recipe choice, none is saved.
    api.world.presets = [];
    api.world.servers = [serverInfo('s2', { port: 8086 })];
    act(() => api.emit({ type: 'servers.changed' }));
    const s2 = await card('Server Qwen3 8B sulla porta 8086');
    // "Annulla" closes it, nothing saved.
    await userEvent.click(within(s2).getByRole('button', { name: 'Salva come preset' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(within(s2).getByRole('button', { name: 'Salva come preset' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'POST' && c.path === '/api/servers/presets').at(-1)?.body).not.toHaveProperty('recipe'));
  });
});

describe('Server page: presets and notices', () => {
  it('each preset with its model, engine, settings and port; start, auto-start, delete; a running one cannot start twice', async () => {
    const api = benchApi();
    api.world.presets = [
      serverPreset('p1', { name: 'Chat veloce', autoStart: true, source: { kind: 'config', runId: 'r' } }),
      serverPreset('p2', { name: 'Rete', network: 'lan', port: undefined }),
    ];
    api.world.custom = [];
    const success = vi.spyOn(toast, 'success');
    const info = vi.spyOn(toast, 'info');
    renderApp('/servers', api);
    const list = await screen.findByRole('list', { name: 'I tuoi preset' });
    const first = within(list).getAllByRole('listitem')[0]!;
    expect(within(first).getByText('qwen3-8b model · Q4_K_M · llama.cpp')).toBeTruthy();
    expect(within(first).getByText('Contesto 16.384 · cache KV q8_0 · Da un tuo test')).toBeTruthy();
    expect(within(first).getByText('Porta 8090')).toBeTruthy();
    const second = within(list).getAllByRole('listitem')[1]!;
    expect(within(second).getByText('Porta automatica')).toBeTruthy();
    expect(within(second).getByText('Rete locale')).toBeTruthy();
    // Auto-start, on and off.
    expect(within(first).getByRole('switch', { name: 'Avvia Chat veloce all’apertura di LLM Bench' }).getAttribute('data-state')).toBe('checked');
    await userEvent.click(within(second).getByRole('switch', { name: 'Avvia Rete all’apertura di LLM Bench' }));
    await waitFor(() => expect(success).toHaveBeenCalledWith('«Rete» partirà all’apertura di LLM Bench'));
    await userEvent.click(within(first).getByRole('switch', { name: 'Avvia Chat veloce all’apertura di LLM Bench' }));
    await waitFor(() => expect(success).toHaveBeenCalledWith('«Chat veloce» non partirà più da solo'));
    // Start: then it is running and cannot start again.
    await userEvent.click(within(first).getByRole('button', { name: 'Avvia il preset Chat veloce' }));
    expect(info).toHaveBeenCalledWith('Avvio «Chat veloce»…');
    await waitFor(() => expect(success).toHaveBeenCalledWith('«Chat veloce» è pronto'));
    await waitFor(() => expect((within(first).getByRole('button', { name: 'Avvia il preset Chat veloce' }) as HTMLButtonElement).disabled).toBe(true));
    expect(within(first).getByText('Acceso')).toBeTruthy();
    // Delete, after a question.
    await userEvent.click(within(second).getByRole('button', { name: 'Elimina il preset Rete' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Eliminare «Rete»?' });
    await userEvent.click(within(ask).getByRole('button', { name: 'Elimina' }));
    await waitFor(() => expect(success).toHaveBeenCalledWith('Preset «Rete» eliminato'));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'I tuoi preset' })).getAllByRole('listitem')).toHaveLength(1));
  });

  it('a preset on a fork names it; failures are said', async () => {
    const api = benchApi();
    api.world.presets = [serverPreset('p1', { name: 'Bonsai', engine: { kind: 'llamacpp-native', customEngineId: 'prismml' } }), serverPreset('p2', { name: 'Mio', engine: { kind: 'command', customEngineId: 'mine' } })];
    api.world.custom = [
      { engine: { schema: 1, id: 'prismml', name: 'PrismML fork', base: 'llamacpp', run: { mode: 'native', path: 'x' }, extraArgs: [], env: {}, notes: '' }, kind: 'llamacpp-native', config: { kind: 'llamacpp-native', customEngineId: 'prismml' }, check: { kind: 'llamacpp-native', status: { kind: 'llamacpp-native', available: true, installed: true, problems: [], supported: true }, flagCount: 1, missing: [] } },
      { engine: { schema: 1, id: 'mine', name: 'Il mio server', base: 'openai-server', run: { mode: 'command', template: 's --port {port}', api: 'chat' }, extraArgs: [], env: {}, notes: '' }, kind: 'command', config: { kind: 'command', customEngineId: 'mine' }, check: { kind: 'command', status: { kind: 'command', available: true, installed: true, problems: [], supported: true }, flagCount: 0, missing: [] } },
    ];
    api.world.routes['PUT /api/servers/presets/p1'] = () => {
      throw apiError('VALIDATION');
    };
    api.world.routes['DELETE /api/servers/presets/p1'] = () => {
      throw apiError('VALIDATION');
    };
    api.world.routes['POST /api/servers/presets/p1/start'] = () => {
      throw apiError('MODEL_NOT_FOUND');
    };
    // Running on forks: named as the Benchmark names them, with the build the core read (none after a rename).
    const fork = { kind: 'llamacpp-native' as const, customEngineId: 'prismml' };
    api.world.servers = [
      serverInfo('f1', { port: 8090, modelLabel: 'Bonsai 8B', engineLabel: 'PrismML fork b42', request: { engine: fork, model: { localId: 'm1' }, port: 8090 } }),
      serverInfo('f2', { port: 8091, modelLabel: 'Bonsai 4B', engineLabel: 'Old name b41', request: { engine: fork, model: { localId: 'm1' }, port: 8091 } }),
    ];
    const error = vi.spyOn(toast, 'error');
    renderApp('/servers', api);
    expect(within(await card('Server Bonsai 8B sulla porta 8090')).getByText('llama.cpp · PrismML fork b42')).toBeTruthy();
    expect(within(await card('Server Bonsai 4B sulla porta 8091')).getByText('llama.cpp · PrismML fork')).toBeTruthy();
    expect(await screen.findByText('qwen3-8b model · Q4_K_M · llama.cpp · PrismML fork')).toBeTruthy();
    expect(screen.getByText('qwen3-8b model · Q4_K_M · Programma con API OpenAI · Il mio server')).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: 'Avvia Bonsai all’apertura di LLM Bench' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('Alcuni valori non sono validi'));
    await userEvent.click(screen.getByRole('button', { name: 'Avvia il preset Bonsai' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('Modello non trovato'));
    await userEvent.click(screen.getByRole('button', { name: 'Elimina il preset Bonsai' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Elimina' }));
    await waitFor(() => expect(error).toHaveBeenCalledTimes(3));
    // Annulla keeps it.
    await userEvent.click(screen.getByRole('button', { name: 'Elimina il preset Mio' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Annulla' }));
    expect(screen.getByText('Mio')).toBeTruthy();
  });

  it('starts that failed while nobody was looking, until dismissed', async () => {
    const api = benchApi();
    const notice: ServerNotice = { id: 'n1', kind: 'autostart-failed', presetId: 'p1', name: 'Chat veloce', error: { code: 'MODEL_NOT_FOUND', message: 'gone' }, at: '2026-10-13T10:00:00.000Z' };
    api.world.notices = [notice, { ...notice, id: 'n2', kind: 'tray-start-failed', name: 'Rete' }];
    renderApp('/servers', api);
    expect(await screen.findByText('«Chat veloce» non è partito all’apertura di LLM Bench')).toBeTruthy();
    expect(screen.getByText('«Rete» non è partito dall’area di notifica')).toBeTruthy();
    expect(screen.getAllByText(/Modello non trovato\. Il file potrebbe essere stato spostato/)).toHaveLength(2);
    await userEvent.click(screen.getAllByRole('button', { name: 'Ho capito' })[0]!);
    await waitFor(() => expect(screen.queryByText('«Chat veloce» non è partito all’apertura di LLM Bench')).toBeNull());
    // The core could not forget it (gone already, core restarting): the list is read again all the same.
    api.world.routes['DELETE /api/servers/notices/n2'] = () => {
      throw apiError('INTERNAL');
    };
    const reads = api.calls.filter((c) => c.path === '/api/servers/notices').length;
    await userEvent.click(screen.getByRole('button', { name: 'Ho capito' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/api/servers/notices').length).toBeGreaterThan(reads));
  });

  it('the core says what changed: the page reads servers and presets again', async () => {
    const api = benchApi();
    renderApp('/servers', api);
    expect(await screen.findByText('Nessun server acceso')).toBeTruthy();
    api.world.servers = [serverInfo('s1', { port: 8080 })];
    api.world.presets = [serverPreset('p1', { name: 'Nuovo' })];
    act(() => api.emit({ type: 'servers.changed' }));
    act(() => api.emit({ type: 'runs.changed' }));
    expect(await screen.findByRole('region', { name: 'Server Qwen3 8B sulla porta 8080' })).toBeTruthy();
    expect(await screen.findByText('Nuovo')).toBeTruthy();
  });

  it('while the lists load', async () => {
    const api = benchApi();
    const gate = deferred<unknown>();
    api.world.routes['GET /api/servers'] = () => gate.promise;
    api.world.routes['GET /api/servers/presets'] = () => gate.promise;
    const { container } = renderApp('/servers', api);
    await waitFor(() => expect(container.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(1));
    await act(async () => gate.resolve([]));
  });
});

describe('sidebar cards', () => {
  const run = { active: activeRun('run-1', { phase: 'prepare', progress: 0.42, modelName: 'Qwen3 4B' }) };

  it('the benchmark in progress: model, phase and percent, a link to its live screen; collapsed: a ring', async () => {
    const api = benchApi();
    api.world.active = run.active;
    renderApp('/settings', api);
    const link = await screen.findByRole('link', { name: 'Test in corso: Qwen3 4B, Preparazione, 42%' });
    expect(within(link).getByText('Qwen3 4B')).toBeTruthy();
    expect(within(link).getByText('42%')).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/run/run-1');
    await userEvent.click(screen.getByRole('button', { name: 'Riduci la barra laterale' }));
    const ring = await screen.findByRole('link', { name: 'Test in corso: Qwen3 4B, Preparazione, 42%' });
    expect(ring.textContent).toBe('');
  });

  it('the benchmark card hides on its own live screen and when nothing runs', async () => {
    const api = benchApi();
    renderApp('/settings', api);
    await screen.findByRole('region', { name: 'Stato della GPU' });
    expect(screen.queryByRole('link', { name: /Test in corso/ })).toBeNull();
  });

  it('servers on: how many, the first one and its port, a link to the Server page; collapsed: an icon with the count', async () => {
    const api = benchApi();
    api.world.servers = [serverInfo('s1', { port: 8080, presetName: 'Chat veloce' }), serverInfo('s2', { port: 8081, loading: { stage: 'starting', elapsedMs: 10 } })];
    const { router } = renderApp('/settings', api);
    const link = await screen.findByRole('link', { name: 'Server attivi: 2. Chat veloce sulla porta 8080' });
    expect(within(link).getByText('Chat veloce · porta 8080')).toBeTruthy();
    expect(within(link).getByText('+1 altri · si avvia')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Riduci la barra laterale' }));
    const icon = await screen.findByRole('link', { name: 'Server attivi: 2. Chat veloce sulla porta 8080' });
    expect(icon.textContent).toBe('2');
    await userEvent.click(icon);
    await waitFor(() => expect(router.state.location.pathname).toBe('/servers'));
    // On the Server page itself the card is not needed.
    expect(screen.queryByRole('link', { name: /Server attivi:/ })).toBeNull();
  });

  it('one server, ready: no extra line; a single one starting says so', async () => {
    const api = benchApi();
    api.world.servers = [serverInfo('s1', { port: 8080 })];
    renderApp('/settings', api);
    const link = await screen.findByRole('link', { name: 'Server attivi: 1. Qwen3 8B sulla porta 8080' });
    expect(within(link).queryByText(/altri|si avvia/)).toBeNull();
    api.world.servers = [serverInfo('s1', { port: 8080, loading: { stage: 'starting', elapsedMs: 10 } })];
    act(() => api.emit({ type: 'servers.changed' }));
    expect(await within(link).findByText('si avvia')).toBeTruthy();
    // Two, both ready: only how many more.
    api.world.servers = [serverInfo('s1', { port: 8080 }), serverInfo('s2', { port: 8081 })];
    act(() => api.emit({ type: 'servers.changed' }));
    const two = await screen.findByRole('link', { name: 'Server attivi: 2. Qwen3 8B sulla porta 8080' });
    expect(within(two).getByText('+1 altri')).toBeTruthy();
  });
});

describe('useNow', () => {
  it('ticks every interval (the uptime of the cards)', () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const { result } = renderHook(() => useNow(30_000));
      expect(result.current).toBe(1_000);
      act(() => vi.advanceTimersByTime(30_000));
      expect(result.current).toBe(31_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
