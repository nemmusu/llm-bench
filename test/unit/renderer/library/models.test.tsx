import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridge, curated, fail, hubModel, item, job, libApi, localModel, okItems, patchPointer, renderLib, report, run, system, world } from './fake';

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
    expect(api.calls.some((c) => c.path === '/api/models/curated?vramGB=32')).toBe(true);
    const list = screen.getByRole('list', { name: 'Consigliati per la tua GPU' });
    expect(within(list).getByText('Modello di riferimento')).toBeTruthy();
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

  it('Hugging Face search with filters, groups and tried badges', async () => {
    const api = libApi(
      world({
        runs: [run('r1', { modelWeakKey: 'org/Model-GGUF/Model-Q8_0.gguf/Q8_0/1' })],
        search: [
          hubModel('org/Model-GGUF', { baseModel: 'base/Model', gated: 'manual' }),
          hubModel('bart/Model-GGUF', { baseModel: 'base/Model', paramsB: 30, formats: ['gguf', 'other'], updatedAt: undefined }),
          hubModel('solo/Model-st', { formats: ['safetensors'], paramsB: undefined }),
        ],
      }),
    );
    renderLib('/models?tab=download', api);
    const box = await screen.findByRole('searchbox', { name: 'Cerca un modello su Hugging Face' });
    expect(screen.getByRole('heading', { name: 'Cerca tra migliaia di modelli' })).toBeTruthy();
    await userEvent.type(box, 'm');
    await new Promise((r) => setTimeout(r, 400));
    expect(api.calls.some((c) => c.path.startsWith('/api/models/search'))).toBe(false);
    await userEvent.type(box, 'odel');
    expect(await screen.findByText('Versioni di base/Model')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Versioni di base/Model' })).toBeTruthy();
    expect(screen.getByText('Licenza da accettare')).toBeTruthy();
    expect(screen.getAllByText('Provato su questa GPU')).toHaveLength(1);
    const q = api.calls.find((c) => c.path.startsWith('/api/models/search?q=model'));
    expect(q?.path).toContain('format=gguf');
    await pick('Ordina per', 'Più apprezzati');
    await waitFor(() => expect(api.calls.some((c) => c.path.includes('sort=likes'))).toBe(true));
    await userEvent.click(screen.getByRole('switch', { name: 'Solo quelli che entrano' }));
    await waitFor(() => expect(api.calls.some((c) => c.path.includes('onlyFits=true'))).toBe(true));
    await pick('Dimensione', 'Grandi (15–40B)');
    await waitFor(() => expect(screen.queryByText('org')).toBeNull());
    expect(screen.getByText('bart')).toBeTruthy();
    await pick('Dimensione', 'Qualsiasi');
    await userEvent.click(screen.getByRole('switch', { name: 'Solo già provati' }));
    await waitFor(() => expect(screen.queryByText('bart')).toBeNull());
    await userEvent.click(screen.getByRole('switch', { name: 'Solo già provati' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Tutti' }));
    expect(await screen.findByText('solo')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Risultati della ricerca' })).toBeTruthy();
    for (const sort of ['Più recenti', 'Di tendenza', 'Più scaricati']) await pick('Ordina per', sort);
    for (const size of ['Piccoli (fino a 4B)', 'Medi (4–15B)', 'Enormi (oltre 40B)']) await pick('Dimensione', size);
    expect(await screen.findByRole('heading', { name: 'Nessun modello trovato' })).toBeTruthy();
  });

  it('search errors offer a retry; results link to the model page', async () => {
    const api = libApi();
    let n = 0;
    api.on('GET /api/models/search', () => (n++ === 0 ? fail('HF_RATE_LIMITED', 429) : [hubModel('org/Model-GGUF')]));
    const { router } = renderLib('/models?tab=download', api);
    await userEvent.type(await screen.findByRole('searchbox'), 'qwen');
    expect(await screen.findByText('Hugging Face ha limitato le richieste')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    await userEvent.click(await screen.findByRole('link', { name: /Model-GGUF/ }));
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
