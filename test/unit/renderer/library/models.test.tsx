import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveEngineFor } from '../../../../src/renderer/components/library/local-models';
import { bridge, curated, ENGINES, fail, hubModel, item, job, libApi, localModel, okItems, patchPointer, renderLib, report, run, sample, system, world } from './fake';

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

async function pick(combobox: string, option: string) {
  const box = screen.getByRole('combobox', { name: combobox });
  box.focus();
  fireEvent.keyDown(box, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

describe('models: on your PC', () => {
  it('lists models with fit, tried, extras; benchmark, reveal and delete', async () => {
    const b = bridge();
    const api = libApi(world({ tried: [run('r', { decodeTps: 88 })] }));
    renderLib('/models', api);
    expect(await h1('Modelli')).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Sul tuo PC' });
    expect(within(list).getByText('Model m1')).toBeTruthy();
    expect(within(list).getAllByText('Q4_K_M · 8,2B parametri · 4,0 GB')).toHaveLength(2);
    expect(within(list).getByText('· LM Studio')).toBeTruthy();
    expect(within(list).getByText('Visione (mmproj)')).toBeTruthy();
    await waitFor(() => expect(within(list).getAllByText('Entra perfettamente')).toHaveLength(2));
    await waitFor(() => expect(within(list).getAllByText('Provato su questa GPU · 88 tok/s')).toHaveLength(2));
    // Only library models can be deleted.
    expect(screen.queryByRole('button', { name: 'Elimina: Model m2' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Mostra nella cartella: Model m1' }));
    expect(b.revealPath).toHaveBeenCalledWith('C:\\Models\\m1-Q4_K_M.gguf');
    await userEvent.click(screen.getByRole('button', { name: 'Elimina: Model m1' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Eliminare Model m1?' });
    expect(within(confirm).getByText(/Libero 4,0 GB sul disco. I risultati/)).toBeTruthy();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Elimina' }));
    await waitFor(() => expect(screen.queryByText('Model m1')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Fai il benchmark: Model m2' }));
    await waitFor(() => expect(api.w.settings.lastModelId).toBe('m2'));
  });

  it('delete errors, cancel, empty library and load errors', async () => {
    const api = libApi(world({ local: [localModel('m1', { identity: { facts: undefined, quant: undefined, sizeBytes: undefined } })] }));
    api.on('DELETE /api/models/local/*', () => fail('VALIDATION', 400, 'Only models inside the GPU Bench models folder can be deleted'));
    renderLib('/models', api);
    expect(await screen.findByText('0 B')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Elimina: Model m1' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Annulla' }));
    await userEvent.click(screen.getByRole('button', { name: 'Elimina: Model m1' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Elimina' }));
    expect(await screen.findByText('Alcuni valori non sono validi')).toBeTruthy();
    api.w.local = [];
    await userEvent.click(screen.getByRole('button', { name: 'Cerca di nuovo' }));
    expect(await screen.findByRole('heading', { name: 'Nessun modello sul PC' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Scarica un modello' }));
    expect(await screen.findByRole('heading', { name: 'Consigliati per la tua GPU' })).toBeTruthy();
  });

  it('library and rescan errors offer a retry', async () => {
    const api = libApi();
    let n = 0;
    api.on('GET /api/models/local', () => (n++ === 0 ? fail('INTERNAL', 500) : api.w.local));
    api.on('POST /api/models/rescan', () => fail('DISK_FULL', 507));
    renderLib('/models', api);
    expect(await screen.findByText('Si è verificato un errore imprevisto')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(await screen.findByText('Model m1')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cerca di nuovo' }));
    expect(await screen.findByText('Spazio su disco esaurito')).toBeTruthy();
  });

  it('adds a folder and rescans after the settings are saved', async () => {
    const b = bridge({ pickFolder: vi.fn(async () => 'E:\\LLM') });
    const api = libApi();
    renderLib('/models', api);
    await screen.findByText('Model m1');
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi cartella' }));
    await waitFor(() => expect(api.w.settings.extraModelDirs).toEqual(['E:\\LLM']));
    const put = api.calls.findIndex((c) => c.method === 'PUT');
    const rescan = api.calls.findIndex((c) => c.path === '/api/models/rescan');
    expect(rescan).toBeGreaterThan(put);
    // The same folder twice, or a cancelled dialog, change nothing.
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi cartella' }));
    b.pickFolder.mockResolvedValueOnce(null);
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi cartella' }));
    expect(api.calls.filter((c) => c.path === '/api/models/rescan')).toHaveLength(1);
    api.on('PUT /api/settings', () => fail('VALIDATION'));
    b.pickFolder.mockResolvedValueOnce('F:\\Other');
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi cartella' }));
    expect(await screen.findByText('Alcuni valori non sono validi')).toBeTruthy();
  });

  it('copies GGUF models into Docker storage on Windows (and removes the copy)', async () => {
    const api = libApi(world({ volumes: ['m2'] }));
    renderLib('/models', api);
    expect(await screen.findByText('Copiato in Docker')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Copia nello spazio Docker: Model m1' }));
    expect(api.calls.find((c) => c.path === '/api/docker/model-volumes' && c.method === 'POST')?.body).toEqual({ localId: 'm1' });
    act(() => api.emit({ type: 'engine.install', kind: 'docker-volume', stage: 'copy', bytesDone: 1e9, bytesTotal: 4e9 }));
    expect(await screen.findByRole('progressbar', { name: 'Copia di Model m1 in Docker' })).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'docker-volume', stage: 'error', bytesDone: 0, error: { code: 'DOCKER_VOLUME_FAILED', message: 'x' } }));
    expect(await screen.findByText('Copia del modello in Docker non riuscita')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'docker-volume', stage: 'error', bytesDone: 0 }));
    expect(await screen.findByText('Copia del modello in Docker non riuscita')).toBeTruthy();
    api.w.volumes = ['m1', 'm2'];
    act(() => api.emit({ type: 'engine.install', kind: 'docker-volume', stage: 'done', bytesDone: 0, result: { localId: 'm1' } }));
    await waitFor(() => expect(screen.getAllByText('Copiato in Docker')).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: 'Togli la copia di Model m1 da Docker' }));
    await waitFor(() => expect(screen.getAllByText('Copiato in Docker')).toHaveLength(1));
    api.on('DELETE /api/docker/model-volumes/*', () => fail('DOCKER_NOT_RUNNING'));
    await userEvent.click(screen.getByRole('button', { name: 'Togli la copia di Model m2 da Docker' }));
    expect(await screen.findByText('Docker non è avviato')).toBeTruthy();
  });

  it('no Docker copy on Linux or when Docker is stopped', async () => {
    renderLib('/models', libApi(world({ system: system({ os: { platform: 'linux', release: '6', arch: 'x64', name: 'Ubuntu', isWsl: false } }) })));
    await screen.findByText('Model m1');
    expect(screen.queryByRole('button', { name: /Copia nello spazio Docker/ })).toBeNull();
  });
});

describe('models: start a server', () => {
  const planned = (api: ReturnType<typeof libApi>) => api.calls.filter((c) => c.method === 'POST' && c.path === '/api/servers/plan').map((c) => c.body);

  it('starts a local model with the recommended settings, with the llama.cpp used last', async () => {
    const api = libApi(world({ settings: { ...world().settings, lastEngine: { kind: 'llamacpp-docker', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda' } } }));
    renderLib('/models', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Avvia server: Model m1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Avvia il server' });
    expect(await within(dialog).findByText('32.768 token')).toBeTruthy();
    expect(within(dialog).getByText('Model m1 con llama.cpp (Docker). Altri programmi potranno usarlo finché non lo fermi.')).toBeTruthy();
    expect(planned(api)).toEqual([{ engine: { kind: 'llamacpp-docker', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda' }, model: { localId: 'm1' } }]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avvia server' }));
    const done = await screen.findByRole('dialog', { name: 'Il server è pronto' });
    expect(within(done).getByText('http://127.0.0.1:5123/v1')).toBeTruthy();
    await userEvent.click(within(done).getByRole('button', { name: 'Ferma' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/servers/gpubench-srv')).toBe(true);
  });

  it('picks the engine from the file: GGUF with llama.cpp, safetensors with vLLM', () => {
    const gguf = localModel('g');
    const st = localModel('s', { identity: { format: 'safetensors', quant: undefined } });
    const engines = ENGINES();
    const linux = engines.map((e) => (e.kind === 'vllm-native' ? { ...e, available: true, installed: true, supported: true } : e));
    expect(serveEngineFor(gguf, undefined, engines)).toEqual({ kind: 'llamacpp-native' });
    expect(serveEngineFor(gguf, { kind: 'vllm-docker' }, engines)).toEqual({ kind: 'llamacpp-native' });
    expect(serveEngineFor(gguf, { kind: 'llamacpp-native', executable: 'D:/llama/llama-server.exe' }, engines)).toEqual({ kind: 'llamacpp-native', executable: 'D:/llama/llama-server.exe' });
    expect(serveEngineFor(st, { kind: 'llamacpp-native' }, engines)).toEqual({ kind: 'vllm-docker' });
    expect(serveEngineFor(st, undefined, undefined)).toEqual({ kind: 'vllm-docker' });
    expect(serveEngineFor(st, undefined, linux)).toEqual({ kind: 'vllm-native' });
  });
});

describe('models: download', () => {
  it('curated for this GPU: fit, tried, reference, already on the PC, show all, download', async () => {
    bridge();
    const api = libApi(
      world({
        local: [localModel('ex', { identity: { repo: 'org/Extra-0-GGUF', file: 'Extra-0-Q4_K_M.gguf' } }), localModel('vl', { identity: { repo: 'Qwen/Qwen3-0.6B', file: 'model.safetensors' } })],
        tried: [run('r', { decodeTps: 142, createdAt: '2026-09-12T10:00:00.000Z' })],
      }),
    );
    renderLib('/models?tab=download', api);
    expect(await screen.findByText('Scelti per una scheda con 32 GB di memoria video.')).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/models/curated')).toBe(true);
    const list = screen.getByRole('list', { name: 'Consigliati per la tua GPU' });
    expect(within(list).getByText('Modello di riferimento')).toBeTruthy();
    // The core sends a verdict with the list: no waiting for each badge.
    expect(within(list).getAllByText('Entra perfettamente')).toHaveLength(1);
    expect(within(list).getAllByText('Sul tuo PC')).toHaveLength(1);
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    await userEvent.click(screen.getByRole('button', { name: 'Mostra tutti (7)' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    await userEvent.click(screen.getByRole('button', { name: 'Mostra meno' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Tutti' }));
    expect(within(screen.getByRole('list', { name: 'Consigliati per la tua GPU' })).getAllByText('Sul tuo PC')).toHaveLength(2);
    await userEvent.click(screen.getByRole('radio', { name: 'vLLM (safetensors)' }));
    expect(within(screen.getByRole('list', { name: 'Consigliati per la tua GPU' })).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.click(screen.getByRole('radio', { name: 'llama.cpp (GGUF)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Scarica Qwen3 4B · Q4_K_M · 2,3 GB' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('L’hai già provato su questa GPU: 142 tok/s il 12 set 2026. Vuoi scaricarlo di nuovo?')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scarica · 2,3 GB' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Download avviato: Qwen3 4B · Q4_K_M')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Vedi i download' }));
    expect(await screen.findByRole('dialog', { name: 'Download e installazioni' })).toBeTruthy();
  });

  it('opens a curated model page; vLLM entries download the whole repo', async () => {
    const api = libApi();
    const { router } = renderLib('/models?tab=download', api);
    await userEvent.click(await screen.findByRole('radio', { name: 'vLLM (safetensors)' }));
    await userEvent.click(screen.getByRole('button', { name: /Scarica Qwen3 0.6B/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Scarica ·/ }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/downloads')?.body).toMatchObject({ files: ['*'], repo: 'Qwen/Qwen3-0.6B' }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Dettagli' })[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe('/models/hub/Qwen/Qwen3-0.6B'));
  });

  it('not enough disk space: the dialog says so and points to Settings; errors stay in the dialog', async () => {
    const api = libApi(world({ check: report([...okItems().slice(0, 4), item('disk', { params: { freeGb: 1, path: 'C:\\', minFreeGb: 20 } })]) }));
    const { router } = renderLib('/models?tab=download', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Scarica Qwen3 4B · Q4_K_M · 2,3 GB' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Non c’è abbastanza spazio sul disco')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Scarica · 2,3 GB' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scegli un’altra cartella' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
  });

  it('download errors stay in the dialog', async () => {
    const api = libApi();
    api.on('POST /api/downloads', () => fail('HF_NOT_FOUND', 404));
    renderLib('/models?tab=download', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Scarica Qwen3 4B · Q4_K_M · 2,3 GB' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scarica · 2,3 GB' }));
    expect(await within(dialog).findByText('Modello non trovato su Hugging Face')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('without a GPU or with a failing list the curated card still explains itself', async () => {
    const api = libApi(world({ system: system({ gpus: [] }), snapshot: [], check: report([]), curated: { ...curated(2), vramGB: undefined } }));
    renderLib('/models?tab=download', api);
    expect(await screen.findByText('I modelli consigliati, dal più grande al più piccolo.')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Scarica Qwen3 4B · Q4_K_M · 2,3 GB' }));
    expect(api.calls.some((c) => c.path === '/api/models/curated')).toBe(true);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText('–')).toHaveLength(1);
  });

  it('curated list errors', async () => {
    const api = libApi();
    api.on('GET /api/models/curated', () => fail('INTERNAL', 500));
    renderLib('/models?tab=download', api);
    expect(await screen.findByText('Si è verificato un errore imprevisto')).toBeTruthy();
  });

  it('catalog: browse without typing, every model marked with its fit, search, sort, sizes, author, only what fits', async () => {
    const quick = (level: 'perfect' | 'no') => ({ level, needMiB: level === 'no' ? 40_000 : 5_000, availableMiB: 30_000, quant: 'Q4_K_M', engine: 'llamacpp' as const });
    const api = libApi(
      world({
        runs: [run('r1', { modelWeakKey: 'org/Model-GGUF/Model-Q8_0.gguf/Q8_0/1', decodeTps: 88 })],
        search: [
          hubModel('org/Model-GGUF', { gated: 'manual', fit: quick('perfect') }),
          hubModel('bart/Big-Model-GGUF', { paramsB: 70, formats: ['gguf', 'other'], updatedAt: undefined, fit: quick('no') }),
          hubModel('solo/Model-st', { formats: ['safetensors'], paramsB: undefined }),
        ],
      }),
    );
    renderLib('/models?tab=download', api);
    expect(await screen.findByRole('heading', { name: 'Trova un modello da provare' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Consigliati per la tua GPU' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'I più scaricati su Hugging Face' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Modelli trovati' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    // Models that do not fit are shown, marked; unknown sizes say so.
    expect(within(list).getByText('Entra perfettamente')).toBeTruthy();
    expect(within(list).getByText('Non entra')).toBeTruthy();
    expect(within(list).getByText('Dimensione non indicata')).toBeTruthy();
    expect(within(list).getByText('Licenza da accettare')).toBeTruthy();
    expect(within(list).getByText('Provato · 88 tok/s')).toBeTruthy();
    expect(screen.getByText('3 modelli')).toBeTruthy();
    expect(screen.getByText('Hai visto tutti i risultati.')).toBeTruthy();
    const last = () => api.calls.filter((c) => c.path.startsWith('/api/models/search')).at(-1)?.path ?? '';
    expect(last()).toBe('/api/models/search?q=&format=gguf&sort=downloads&limit=30&onlyFits=false');

    const box = screen.getByRole('searchbox', { name: 'Cerca un modello su Hugging Face' });
    await userEvent.type(box, 'big');
    expect(await screen.findByRole('heading', { name: 'Risultati per «big»' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Consigliati per la tua GPU' })).toBeNull();
    expect(await screen.findByText('1 modello')).toBeTruthy();
    await userEvent.clear(box);
    await pick('Ordina per', 'Più apprezzati');
    expect(await screen.findByRole('heading', { name: 'I più apprezzati su Hugging Face' })).toBeTruthy();
    expect(last()).toContain('sort=likes');
    for (const [sort, heading] of [
      ['Più recenti', 'Appena pubblicati su Hugging Face'],
      ['Aggiornati di recente', 'Aggiornati di recente su Hugging Face'],
      ['Di tendenza', 'Di tendenza su Hugging Face'],
      ['Più scaricati', 'I più scaricati su Hugging Face'],
    ] as const) {
      await pick('Ordina per', sort);
      expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    }

    await userEvent.click(screen.getByRole('radio', { name: '15–40B' }));
    await waitFor(() => expect(last()).toContain('minParamsB=15&maxParamsB=40'));
    await userEvent.click(screen.getByRole('radio', { name: 'Oltre 40B' }));
    await waitFor(() => expect(last()).toMatch(/minParamsB=40$/));
    await userEvent.click(screen.getByRole('radio', { name: 'Fino a 4B' }));
    await waitFor(() => expect(last()).toMatch(/onlyFits=false&maxParamsB=4.5$/));
    await userEvent.click(screen.getByRole('radio', { name: 'Tutte' }));
    const fits = screen.getByRole('button', { name: 'Entra nella mia GPU' });
    expect(fits.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(fits);
    expect(fits.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(last()).toContain('onlyFits=true'));

    // An author from a card becomes the author filter; the list offers the usual ones too.
    await userEvent.click(await screen.findByRole('button', { name: 'Altri modelli di bart' }));
    await waitFor(() => expect(last()).toContain('author=bart'));
    expect(await screen.findByText('1 modello')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Autore' }).textContent).toBe('bart');
    await pick('Autore', 'unsloth');
    await waitFor(() => expect(last()).toContain('author=unsloth'));
    // Nothing found with filters on: one click clears them.
    expect(await screen.findByRole('heading', { name: 'Nessun modello trovato' })).toBeTruthy();
    await userEvent.click(within(screen.getByRole('heading', { name: 'Nessun modello trovato' }).parentElement as HTMLElement).getByRole('button', { name: 'Togli i filtri' }));
    // The sort is not a filter: it stays.
    expect(await within(await screen.findByRole('list', { name: 'Modelli trovati' })).findAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('combobox', { name: 'Autore' }).textContent).toBe('Tutti gli autori');
    expect(screen.getByRole('button', { name: 'Entra nella mia GPU' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('combobox', { name: 'Ordina per' }).textContent).toBe('Più scaricati');
    expect(screen.queryByRole('button', { name: 'Togli i filtri' })).toBeNull();
    await pick('Autore', 'bartowski');
    await waitFor(() => expect(last()).toContain('author=bartowski'));
    await pick('Autore', 'Tutti gli autori');
    expect(screen.getByRole('combobox', { name: 'Autore' }).textContent).toBe('Tutti gli autori');
    await userEvent.click(screen.getByRole('radio', { name: 'vLLM (safetensors)' }));
    await waitFor(() => expect(last()).toContain('format=safetensors'));
    await pick('Autore', 'meta-llama');
    await userEvent.click(screen.getAllByRole('button', { name: 'Togli i filtri' })[0]!);
    await userEvent.click(screen.getByRole('radio', { name: 'Tutti' }));
    await waitFor(() => expect(last()).toContain('format=any'));
    await pick('Autore', 'openai');
    await waitFor(() => expect(last()).toContain('author=openai'));
  });

  it('catalog: models already tried on this GPU, without asking Hugging Face', async () => {
    const api = libApi(world({ runs: [run('r1', { decodeTps: 88, quant: 'Q8_0' }), run('r2', { modelWeakKey: 'lab/Other-GGUF/o.gguf/Q4_K_M/1', status: 'failed', createdAt: '2026-09-01T00:00:00.000Z' })] }));
    renderLib('/models?tab=download', api);
    await screen.findByRole('list', { name: 'Modelli trovati' });
    const calls = api.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Già provati' }));
    const list = await screen.findByRole('list', { name: 'Modelli che hai già provato' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('Provato · 88 tok/s')).toBeTruthy();
    expect(within(list).getByText('Q8_0')).toBeTruthy();
    expect(within(list).getAllByText(/^Test fatti: 1 · l’ultimo/)).toHaveLength(2);
    expect(screen.getByText('2 modelli')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Consigliati per la tua GPU' })).toBeNull();
    expect((screen.getByRole('combobox', { name: 'Ordina per' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByRole('searchbox'), 'other');
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Modelli che hai già provato' })).getAllByRole('listitem')).toHaveLength(1));
    expect(await screen.findByText('1 modello')).toBeTruthy();
    await userEvent.click(within(screen.getByRole('list', { name: 'Modelli che hai già provato' })).getByRole('link', { name: 'Other-GGUF' }));
    expect(api.calls.slice(calls).some((c) => c.path.startsWith('/api/models/search'))).toBe(false);
  });

  it('catalog: nothing tried yet, no results without filters, VRAM held by other programs explained', async () => {
    const api = libApi(world({ runs: [], search: [], snapshot: [sample(1000, { memUsedMiB: 17_000 })] }));
    renderLib('/models?tab=download', api);
    expect(await screen.findByRole('heading', { name: 'Nessun modello trovato' })).toBeTruthy();
    expect(await screen.findByText(/^Altri programmi stanno usando .+ della scheda video$/)).toBeTruthy();
    expect(screen.getByText(/^Entra \/ non entra si riferisce ai .+ liberi adesso/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Togli i filtri' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Già provati' }));
    expect(await screen.findByRole('heading', { name: 'Non hai ancora provato modelli di Hugging Face' })).toBeTruthy();
    expect(screen.getByText('0 modelli')).toBeTruthy();
    expect(screen.queryByText(/^Altri programmi stanno usando/)).toBeNull();
  });

  it('catalog: pages load as you scroll, or with the button; a failing page can be retried', async () => {
    const observers: { cb: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        disconnect = vi.fn();
        constructor(cb: IntersectionObserverCallback) {
          observers.push({ cb, disconnect: this.disconnect });
        }
        observe() {}
      },
    );
    const many = Array.from({ length: 95 }, (_, i) => hubModel(`org/Model-${String(i).padStart(2, '0')}-GGUF`));
    const api = libApi(world({ search: many }));
    renderLib('/models?tab=download', api);
    const list = await screen.findByRole('list', { name: 'Modelli trovati' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(30);
    expect(screen.getByText('30 modelli · scorri per vederne altri')).toBeTruthy();
    const page = (q: URLSearchParams) => {
      const at = Number(q.get('cursor') ?? 0);
      return at + 30 < many.length ? { models: many.slice(at, at + 30), nextCursor: String(at + 30) } : { models: many.slice(at, at + 30) };
    };
    let release: () => void = () => undefined;
    api.on('GET /api/models/search', (_b, q) => new Promise((resolve) => (release = () => resolve(page(q)))));
    await userEvent.click(screen.getByRole('button', { name: 'Carica altri modelli' }));
    expect(((await screen.findByRole('button', { name: 'Carico altri modelli…' })) as HTMLButtonElement).disabled).toBe(true);
    api.on('GET /api/models/search', (_b, q) => page(q));
    act(() => release());
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(60));
    expect(api.calls.at(-1)?.path).toContain('cursor=30');
    // The end of the grid comes into view: the next page loads by itself.
    const observer = observers.at(-1) as (typeof observers)[number];
    act(() => observer.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(90));
    // Still in view after it arrived: keeps going; then a page fails.
    let failNext = true;
    api.on('GET /api/models/search', (_b, q) => {
      if (failNext && q.get('cursor') === '90') {
        failNext = false;
        return fail('HF_RATE_LIMITED', 429);
      }
      return { models: many.slice(Number(q.get('cursor') ?? 0), Number(q.get('cursor') ?? 0) + 30) };
    });
    act(() => observer.cb([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    act(() => observer.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(await screen.findByText('Hugging Face ha limitato le richieste')).toBeTruthy();
    expect(within(list).getAllByRole('listitem')).toHaveLength(90);
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(95));
    expect(screen.getByText('95 modelli')).toBeTruthy();
    expect(screen.getByText('Hai visto tutti i risultati.')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('search errors offer a retry; results link to the model page', async () => {
    const api = libApi();
    let n = 0;
    api.on('GET /api/models/search', () => (n++ === 0 ? fail('HF_RATE_LIMITED', 429) : { models: [hubModel('org/Model-GGUF')] }));
    const { router } = renderLib('/models?tab=download', api);
    expect(await screen.findByText('Hugging Face ha limitato le richieste')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    await userEvent.click(await screen.findByRole('link', { name: 'Model-GGUF' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/models/hub/org/Model-GGUF'));
  });

  it('tabs keep the choice in the address; the downloads button shows active ones', async () => {
    const api = libApi(world({ downloads: [job('a'), job('b', { state: 'done' })] }));
    const { router } = renderLib('/models', api);
    expect(await screen.findByRole('button', { name: /^Download\s*1$/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Scarica' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: 'download' }));
    await userEvent.click(screen.getByRole('tab', { name: /Sul tuo PC/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await userEvent.click(screen.getByRole('button', { name: /^Download\s*1$/ }));
    expect(await screen.findByRole('dialog', { name: 'Download e installazioni' })).toBeTruthy();
  });

  it('edge cases: safetensors in the library, failing fit, no models folder, a slow rescan, a fast download', async () => {
    const api = libApi(
      world({
        local: [localModel('st', { identity: { format: 'safetensors', repo: 'org/Extra-1-GGUF', file: undefined } })],
      }),
    );
    api.on('POST /api/models/fit', (body) =>
      (body as { engine: string }).engine === 'vllm-docker'
        ? fail('NETWORK', 502)
        : { level: 'good', needMiB: 1, weightsMiB: 1, kvMiB: 0, overheadMiB: 0, availableMiB: 2, utilization: 0.5, contextSize: 1, basis: 'file-size', notes: [] },
    );
    api.on('GET /api/system', () => fail('INTERNAL', 500));
    api.on('POST /api/models/rescan', () => new Promise(() => undefined));
    api.on('POST /api/downloads', (b) => {
      const req = b as { repo: string; label: string; files: string[] };
      const done = job('fast', { repo: req.repo, label: req.label, state: 'done' });
      api.emit({ type: 'download.update', job: done });
      return { ...done, state: 'queued' };
    });
    renderLib('/models', api);
    expect(await screen.findByText('Model st')).toBeTruthy();
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/models/fit' && (c.body as { engine: string }).engine === 'vllm-docker')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Cerca di nuovo' }));
    expect((screen.getByRole('button', { name: 'Cerca di nuovo' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('tab', { name: 'Scarica' }));
    const list = await screen.findByRole('list', { name: 'Consigliati per la tua GPU' });
    await userEvent.click(await within(list).findByRole('button', { name: 'Scarica Qwen3 4B · Q4_K_M · 2,3 GB' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText('–').length).toBeGreaterThan(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scarica · 2,3 GB' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Download e installazioni' }));
    const panel = await screen.findByRole('dialog', { name: 'Download e installazioni' });
    expect(within(panel).getByText('Completato')).toBeTruthy();
  });
});
