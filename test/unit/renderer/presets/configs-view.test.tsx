import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../../../src/contract/results';
import { renderApp } from '../helpers';
import { IDS, seeded, seededRuns, summaries } from '../bench/fixtures';
import { apiError, benchApi, deferred, localModel } from '../bench/world';

// The result pages opened from here draw charts: no canvas in happy-dom.
vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

async function choose(combobox: string, option: string | RegExp) {
  const trigger = screen.getByRole('combobox', { name: combobox });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

const posted = (api: ReturnType<typeof benchApi>, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);
const table = () => screen.findByRole('table', { name: 'Configurazioni provate' });
/** The data rows, top to bottom, as their model cell reads. */
const rowModels = () => [...screen.getByRole('table', { name: 'Configurazioni provate' }).querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent!);
const rowOf = (model: RegExp) => screen.getAllByRole('row').find((r) => model.test(r.querySelector('td')?.textContent ?? ''))!;

/** The seeded runs, the Full one measured a second time with the same settings, and its model in the library. */
function world(extra: RunResult[] = []) {
  const again: RunResult = { ...seeded(IDS.full), id: '01K6ZA2B3C4D5E6F7G8H9J0KMN', createdAt: '2026-10-07T09:00:00.000Z' };
  // Measured again without several users at once.
  again.metrics = { ...again.metrics, concurrency: [], latency: again.metrics.latency.map((p) => ({ ...p, decodeTps: { ...p.decodeTps, median: p.promptTokens === 512 ? 186 : p.decodeTps.median } })) };
  return benchApi({ runs: [...seededRuns(), again, ...extra], local: [localModel('qwen3-8b', { weakKey: seeded(IDS.full).model.weakKey }), localModel('st', { format: 'safetensors', repo: 'Qwen/Qwen3-8B-FP8', file: undefined })] });
}

describe('Risultati → Configurazioni', () => {
  it('switches view in the URL, sorts by generation, compares at a depth, filters', async () => {
    const api = world();
    const { router } = renderApp('/results', api);
    await screen.findByText('10 risultati');
    await userEvent.click(screen.getByRole('tab', { name: 'Configurazioni' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ view: 'configs' }));
    await table();
    expect(screen.getByText('6 configurazioni')).toBeTruthy();
    // "Contesto massimo" first: each one with its own context full. Only the Full test filled its 8K
    // (a prompt of 8.192 tokens); the others say where they were not measured, and sink to the bottom.
    expect(screen.getByRole('combobox', { name: 'Confronta a' }).textContent).toContain('Contesto massimo');
    expect(screen.getByRole('columnheader', { name: /Generazione/ }).textContent).toBe('Generazione(tok/s) al contesto massimo');
    expect(rowModels()[0]).toContain('Qwen3 8B');
    expect(within(rowOf(/Qwen3 8B/)).getByText('157,9')).toBeTruthy();
    expect(within(rowOf(/Gemma 4 31B/)).getByText('non misurata a 8K')).toBeTruthy();
    expect(within(rowOf(/Mistral/)).getByText('non misurata a 1K')).toBeTruthy();
    await choose('Confronta a', '512 token');
    // Fastest first; the headers say their unit.
    const decode = screen.getByRole('columnheader', { name: /Generazione/ });
    expect(decode.getAttribute('aria-sort')).toBe('descending');
    expect(decode.textContent).toContain('(tok/s)');
    // The first token's wait has its unit in every cell ("58 ms", "3 min 50 s"), and the header says where.
    expect(screen.getByRole('columnheader', { name: /Primo token/ }).textContent).toBe('Primo token a 512 token');
    expect(screen.getAllByText(/^\d+ ms$/).length).toBeGreaterThan(0);
    expect(screen.getByRole('columnheader', { name: /VRAM/ }).textContent).toContain('(GB)');
    expect(rowModels()[0]).toContain('gpt-oss 20B');
    expect(rowModels().at(-1)).toContain('Gemma 4 31B');
    // In plain words, only what differs from the defaults; the context in its own column.
    const qwen = rowOf(/Qwen3 8B/);
    expect(within(qwen).getByText('flash attention')).toBeTruthy();
    expect(within(qwen).getByText('8.192')).toBeTruthy();
    expect(within(rowOf(/Mistral/)).getByText('Impostazioni predefinite')).toBeTruthy();
    // A short setting never breaks in two at the end of a line; a long one may wrap.
    expect(within(qwen).getByText('flash attention').className).toBe('whitespace-nowrap');
    const gpt = rowOf(/gpt-oss/);
    expect(within(gpt).getByText('4 slot paralleli').className).toBe('whitespace-nowrap');
    expect(within(gpt).getByText('contesto condiviso fra gli utenti').className).toBe('');
    // Two tests behind the Qwen3 8B configuration: the median of 183,45 and 186.
    expect(within(qwen).getByText('184,7')).toBeTruthy();
    expect(within(qwen).getByRole('button', { name: 'Mostra i 2 test di Qwen3 8B' })).toBeTruthy();

    // "Confronta a" 4K: the quick test (1K of context) sinks to the bottom and says how far it gets.
    expect(screen.getByRole('combobox', { name: 'Confronta a' }).textContent).toContain('512 token');
    await choose('Confronta a', '4K token');
    expect(rowModels().at(-1)).toContain('Mistral');
    expect(within(rowOf(/Mistral/)).getByText('arriva solo a 1K')).toBeTruthy();
    await userEvent.click(within(decode).getByRole('button'));
    expect(screen.getByRole('columnheader', { name: /Generazione/ }).getAttribute('aria-sort')).toBe('ascending');
    expect(rowModels()[0]).toContain('Gemma');
    expect(rowModels().at(-1)).toContain('Mistral');
    await choose('Confronta a', '512 token');

    await choose('Modello', 'Qwen3 8B · Q4_K_M');
    expect(await screen.findByText('1 configurazione')).toBeTruthy();
    await choose('Modello', 'Tutti i modelli');
    await choose('Motore', 'vLLM (Docker)');
    await waitFor(() => expect(rowModels()).toEqual([expect.stringContaining('Qwen3-8B-FP8')]));
    await choose('Motore', 'Tutti i motori');
    await choose('Contesto almeno', 'Contesto ≥ 8K');
    expect(await screen.findByText('5 configurazioni')).toBeTruthy();
    await choose('Contesto almeno', 'Contesto ≥ 16K');
    await userEvent.click(await screen.findByRole('button', { name: 'Togli i filtri' }));
    expect(await screen.findByText('6 configurazioni')).toBeTruthy();

    // The other PC of the shared folder, then every card.
    await choose('Scheda video', /RTX 3070 · SERVER-3070/);
    await waitFor(() => expect(screen.getByText('1 configurazione')).toBeTruthy());
    await choose('Scheda video', 'Tutte le schede');
    expect(await screen.findByText('7 configurazioni')).toBeTruthy();
  });

  it('lists the tests behind a configuration and opens one', async () => {
    const { router } = renderApp('/results?view=configs', world());
    await table();
    await userEvent.click(within(rowOf(/Qwen3 8B/)).getByRole('button', { name: 'Mostra i 2 test di Qwen3 8B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Test di questa configurazione' });
    expect(within(dialog).getByText(/Qwen3 8B · Q4_K_M · llama.cpp b11438 \(CUDA 13.4\) · Contesto 8\.192 · cache KV f16 · flash attention/)).toBeTruthy();
    // Each test with its own context full, as the table compares them.
    expect(within(dialog).getByRole('columnheader', { name: /Generazione al contesto massimo/ }).textContent).toContain('(tok/s)');
    const links = within(dialog).getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(within(dialog).getAllByText('Completo')).toHaveLength(2);
    expect(within(dialog).getAllByText('157,9')).toHaveLength(2);
    expect(within(dialog).getAllByText('16 utenti')).toHaveLength(1);
    expect(within(dialog).getAllByText('90 ciascuno · 1.435 in tutto')).toHaveLength(1);
    await userEvent.click(links[1]!);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/results/${IDS.full}`));
  });

  it('each test of the list with what it measured', async () => {
    const full = seeded(IDS.full);
    // An older test of the same settings: prompts of 512 tokens only, two users without a per-user figure.
    const older: RunResult = {
      ...full,
      id: '01K6ZG2B3C4D5E6F7G8H9J0KMN',
      createdAt: '2026-10-05T09:00:00.000Z',
      metrics: { ...full.metrics, latency: full.metrics.latency.filter((p) => p.promptTokens === 512), concurrency: [{ level: 2, requests: 8, aggregateTps: 300, perRequestDecodeTpsP50: 0, ttftP50Ms: 50, ttftP95Ms: 60, errors: 0 }] },
    };
    renderApp('/results?view=configs', world([older]));
    await table();
    await choose('Confronta a', '4K token');
    await userEvent.click(within(rowOf(/Qwen3 8B/)).getByRole('button', { name: 'Mostra i 3 test di Qwen3 8B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Test di questa configurazione' });
    expect(within(dialog).getByRole('columnheader', { name: /Generazione a 4K/ })).toBeTruthy();
    const rows = within(dialog).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    // Newest first: the one without users in parallel, the seeded one, then the older one (not measured at 4K).
    expect(within(rows[0]!).getAllByText('–')).toHaveLength(1);
    expect(within(rows[1]!).getByText('16 utenti')).toBeTruthy();
    expect(within(rows[2]!).getAllByText('–')).toHaveLength(3);
    expect(within(rows[2]!).getByText('2 utenti')).toBeTruthy();
    expect(within(rows[2]!).getByText('300 in tutto')).toBeTruthy();
  });

  it('closes the tests list', async () => {
    renderApp('/results?view=configs', world());
    await table();
    await userEvent.click(within(rowOf(/Qwen3 8B/)).getByRole('button', { name: 'Mostra i 2 test di Qwen3 8B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Test di questa configurazione' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chiudi' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('uses a configuration as a preset: Benchmark page with its banner, settings and command', async () => {
    const api = world();
    const { router } = renderApp('/results?view=configs', api);
    await table();
    const qwen = rowOf(/Qwen3 8B/);
    await userEvent.click(await within(qwen).findByRole('button', { name: 'Usa questo preset' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    const banner = await screen.findByRole('region', { name: 'Preset' });
    // The newest test of the configuration with its context full, quoted with its own numbers.
    expect(within(banner).getByText('Preset da «Qwen3 8B · Q4_K_M» del 07/10: scrive 158 tok/s a 8K token, 8K di contesto')).toBeTruthy();
    expect(api.settings.expertMode).toBe(true);
    expect(((await screen.findByLabelText('Contesto (token)')) as HTMLInputElement).value).toBe('8192');
    await waitFor(() => expect(posted(api, '/api/runs/plan').at(-1)?.body).toMatchObject({ model: { localId: 'qwen3-8b' }, params: { contextSize: 8192, flashAttention: 'on' } }));
    await userEvent.click(within(banner).getByRole('button', { name: 'Chiudi il preset' }));
    expect(screen.queryByRole('region', { name: 'Preset' })).toBeNull();
  });

  it('starts the server like that from a row', async () => {
    const api = world();
    renderApp('/results?view=configs', api);
    await table();
    await userEvent.click(await within(rowOf(/Qwen3 8B/)).findByRole('button', { name: 'Avvia il server così' }));
    // "Avvia un server" with that configuration's settings.
    expect(await screen.findByRole('heading', { level: 1, name: 'Avvia un server' })).toBeTruthy();
    await waitFor(() =>
      expect(posted(api, '/api/servers/plan').map((c) => c.body)).toContainEqual(
        expect.objectContaining({ engine: { kind: 'llamacpp-native' }, model: { localId: 'qwen3-8b' }, params: expect.objectContaining({ contextSize: 8192, flashAttention: 'on' }) }),
      ),
    );
  });

  it('a model no longer on the PC: download it first, or look for it', async () => {
    const full = seeded(IDS.full);
    // Downloaded from Hugging Face once, deleted since.
    const hub: RunResult = {
      ...full,
      id: '01K6ZD2B3C4D5E6F7G8H9J0KMN',
      createdAt: '2026-10-07T10:00:00.000Z',
      model: { ...full.model, source: 'hf', repo: 'Qwen/Qwen3-14B-GGUF', file: 'Qwen3-14B-Q4_K_M.gguf', revision: 'main', displayName: 'Qwen3 14B', sha256: 'e'.repeat(64), weakKey: 'hub-14b', path: 'C:\\gone\\x.gguf', sizeBytes: 9 * 1024 ** 3 },
    };
    const api = world([hub]);
    const { router } = renderApp('/results?view=configs', api);
    await table();
    const row = rowOf(/Qwen3 14B/);
    expect(await within(row).findByText('Da scaricare (9,0 GB)')).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Usa questo preset' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    // The Benchmark page picks it as a model to download, the way a suggestion is.
    expect(await screen.findByRole('button', { name: /^Cambia modello: Qwen3 14B Q4_K_M/ })).toBeTruthy();
    expect(screen.getByText('Dal preset')).toBeTruthy();
    await waitFor(() => expect(posted(api, '/api/runs/plan').at(-1)?.body).toMatchObject({ model: { repo: 'Qwen/Qwen3-14B-GGUF', file: 'Qwen3-14B-Q4_K_M.gguf', revision: 'main' } }));
    await userEvent.click(screen.getByRole('button', { name: /^Cambia modello:/ }));
    const picker = await screen.findByRole('dialog', { name: 'Scegli un modello' });
    expect(within(picker).getAllByText('Dal preset').length).toBeGreaterThan(0);

    // A local file with nowhere to download it from: the Models page.
    act(() => router.history.back());
    await table();
    await userEvent.click(await within(rowOf(/Mistral/)).findByRole('button', { name: 'Trova il modello' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/models'));
    expect(router.state.location.search).toEqual({ tab: 'download' });
  });

  it('says what is unknown; this PC without configurations shows every card; back to the tests', async () => {
    const quick = seeded(IDS.quick);
    // Started with the engine's default context, VRAM not measured.
    const bare: RunResult = {
      ...quick,
      id: '01K6ZF2B3C4D5E6F7G8H9J0KMN',
      model: { ...quick.model, weakKey: 'bare', displayName: 'Phi 4 mini' },
      launch: { ...quick.launch, argv: ['llama-server', '-m', 'C:\\models\\phi.gguf'], params: { extraArgs: [], env: {} } },
      metrics: { ...quick.metrics, vram: {} },
    };
    const api = world([bare]);
    api.world.system = { ...api.world.system, hostId: 'another-pc', gpus: [{ ...api.world.system.gpus[0]!, uuid: 'GPU-new' }] };
    const { router } = renderApp('/results?view=configs', api);
    await table();
    expect(screen.getByRole('combobox', { name: 'Scheda video' }).textContent).toContain('Tutte le schede');
    expect(screen.getByText('8 configurazioni')).toBeTruthy();
    const phi = rowOf(/Phi 4 mini/);
    expect(within(phi).getAllByText('–')).toHaveLength(2);
    await userEvent.click(screen.getByRole('tab', { name: 'Test' }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it('the Test list says what each user got, when the test measured it', async () => {
    const api = world();
    const list = summaries(api.world.runs).map((s) =>
      s.id === IDS.gemma ? { ...s, parallelTps: undefined, parallelPerUserTps: undefined, parallelPromptTokens: undefined } : s.id === IDS.moe ? { ...s, parallelPerUserTps: undefined } : s,
    );
    api.world.routes['GET /api/runs'] = () => list;
    renderApp('/results', api);
    const gemma = (await screen.findByRole('link', { name: /Gemma 4 31B/ })).closest('tr')!;
    expect(within(gemma).getByText('4 utenti')).toBeTruthy();
    expect(within(gemma).queryByText(/in tutto/)).toBeNull();
    // With the prompt each user sent (the context of those speeds), the numbers in the header's unit.
    const moe = screen.getByRole('link', { name: /Qwen3 30B A3B/ }).closest('tr')!;
    expect(within(moe).getByText('4 utenti').parentElement!.textContent).toMatch(/^[\d.]+ in tutto · 4 utenti$/);
    expect(within(moe).getByText('prompt da 512 token')).toBeTruthy();
  });

  it('empty, loading, failing; a test that cannot be read', async () => {
    const api = benchApi({ runs: [] });
    const gate = deferred<unknown>();
    api.world.routes['GET /api/configs'] = () => gate.promise;
    const { container, router } = renderApp('/results?view=configs', api);
    await waitFor(() => expect(container.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0));
    await act(async () => gate.reject(apiError('INTERNAL', undefined, 500)));
    expect(await screen.findByRole('heading', { name: 'Si è verificato un errore imprevisto' })).toBeTruthy();
    delete api.world.routes['GET /api/configs'];
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(await screen.findByRole('heading', { name: 'Ancora nessuna configurazione' })).toBeTruthy();
    // The results folder changed: the list refreshes; a test whose file cannot be read offers nothing.
    api.world.runs = [seeded(IDS.quick)];
    const slow = deferred<unknown>();
    api.world.routes[`GET /api/runs/${IDS.quick}`] = () => slow.promise;
    act(() => api.emit({ type: 'runs.changed' }));
    await table();
    expect((screen.getByRole('button', { name: 'Usa questo preset' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => slow.reject(apiError('RUN_NOT_FOUND', undefined, 404)));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Usa questo preset' })).toBeNull());
    expect(within(rowOf(/Mistral/)).getAllByText('–').length).toBeGreaterThan(0);
    api.world.runs = [];
    act(() => api.emit({ type: 'runs.changed' }));
    await userEvent.click(await screen.findByRole('link', { name: 'Vai al Benchmark' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});
