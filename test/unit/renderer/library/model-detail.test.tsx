import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HubFile } from '../../../../src/contract/models';
import { bridge, fail, fit, hubFit, hubModel, libApi, renderLib, run, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });
const PAGE = '/models/hub/org/Model-GGUF';

describe('model page', () => {
  it('best quant preselected, fit and tried per quant, extras, files, card, related; download', async () => {
    const b = bridge();
    const api = libApi(
      world({
        search: [hubModel('org/Model-GGUF', { license: 'apache-2.0', baseModel: 'base/Model', gated: 'auto' })],
        related: [hubModel('org/Model-GGUF'), hubModel('bart/Model-GGUF', { downloads: 5000 }), hubModel('bart/Model-i1-GGUF'), hubModel('unsloth/Model-GGUF')],
        tried: [run('r', { decodeTps: 61 })],
        readme: { text: '# Model\n\nSee [docs](https://example.com/docs).\n\n![chart](assets/c.png)', truncated: true },
      }),
    );
    renderLib(PAGE, api);
    expect(await h1('Model-GGUF')).toBeTruthy();
    expect(await screen.findByText('1.200 download')).toBeTruthy();
    expect(screen.getByText('30 mi piace')).toBeTruthy();
    expect(screen.getByText('apache-2.0')).toBeTruthy();
    const choices = await screen.findByRole('radiogroup', { name: 'Scegli la versione da scaricare' });
    const q4 = within(choices).getByRole('radio', { name: /Q4_K_M/ });
    expect(q4.getAttribute('aria-checked')).toBe('true');
    expect(within(q4).getByText('Consigliata')).toBeTruthy();
    expect(within(q4).getByText('2 parti')).toBeTruthy();
    expect(within(choices).getAllByText('Entra perfettamente')).toHaveLength(1);
    expect(within(choices).getByText('Entra bene')).toBeTruthy();
    await waitFor(() => expect(within(choices).getAllByText('Provato su questa GPU · 61 tok/s')).toHaveLength(2));
    expect(screen.getByText('31,0B parametri')).toBeTruthy();
    expect(screen.getByText('gemma4')).toBeTruthy();
    expect(screen.getByText('131.072 token')).toBeTruthy();
    expect(screen.getByText('Licenza da accettare')).toBeTruthy();
    // Files grouped by quant, extras by kind.
    expect(screen.getByText('Model-Q4_K_M-00001-of-00002.gguf')).toBeTruthy();
    expect(screen.getByText('Visione (mmproj)')).toBeTruthy();
    expect(screen.getByText('Altri file')).toBeTruthy();
    // Model card rendered safely, relative image resolved on the repo.
    expect(await screen.findByRole('heading', { level: 3, name: 'Model' })).toBeTruthy();
    expect((screen.getByRole('img', { name: 'chart' }) as HTMLImageElement).src).toBe('https://huggingface.co/org/Model-GGUF/resolve/main/assets/c.png');
    expect(screen.getByText(/La descrizione è lunga/)).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: 'docs' }));
    expect(b.openExternal).toHaveBeenCalledWith('https://example.com/docs');
    // Related versions grouped by author, the current repo left out.
    expect(await screen.findByText('Versioni GGUF di base/Model pubblicate da altri autori.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'bart' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Model-GGUF/ }).length).toBe(2);
    await userEvent.click(screen.getByRole('button', { name: 'Apri su Hugging Face' }));
    expect(b.openExternal).toHaveBeenCalledWith('https://huggingface.co/org/Model-GGUF');

    // Pick the other quant, add the mmproj, then switch back.
    await userEvent.click(within(choices).getByRole('radio', { name: /Q8_0/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /mmproj-F16\.gguf/ }));
    expect(screen.getByRole('button', { name: 'Scarica Q8_0 · 8,3 GB' })).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: /mmproj-F16\.gguf/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /mmproj-F16\.gguf/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Scarica Q8_0 · 8,3 GB' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scaricare Model-GGUF · Q8_0?' });
    expect(await within(dialog).findByText(/L’hai già provato su questa GPU: 61 tok\/s/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scarica · 8,3 GB' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/downloads')?.body).toEqual({
      repo: 'org/Model-GGUF',
      revision: 'main',
      files: ['Model-Q8_0.gguf', 'mmproj-F16.gguf'],
      label: 'Model-GGUF · Q8_0',
    }));
    expect(api.calls.find((c) => c.path.endsWith('/fit'))?.body).toEqual({ engine: 'llamacpp-native' });
  });

  it('gated model: accept the license, save the token, retry', async () => {
    const b = bridge();
    const api = libApi(world({ search: [] }));
    let accepted = false;
    api.on('POST /api/models/hub/*/*/fit', () => (accepted ? hubFit() : fail('HF_GATED', 403)));
    renderLib(PAGE, api);
    expect(await screen.findByText('Questo modello ha una licenza da accettare')).toBeTruthy();
    expect(screen.getByText('Non riesco a calcolare quanta memoria serve finché il problema sopra non è risolto.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Accetta la licenza su Hugging Face' }));
    expect(b.openExternal).toHaveBeenCalledWith('https://huggingface.co/org/Model-GGUF');
    await userEvent.type(screen.getByLabelText('Token di accesso'), 'hf_secret');
    accepted = true;
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }));
    expect(b.saveHfToken).toHaveBeenCalledWith('hf_secret');
    expect(await screen.findByRole('radiogroup', { name: 'Scegli la versione da scaricare' })).toBeTruthy();
    await waitFor(() => expect(api.w.settings.hasHfToken).toBe(true));
    expect(screen.queryByText('hf_secret')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Scarica Q4_K_M · 4,7 GB' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Scarica · 4,7 GB' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/downloads')?.body).toMatchObject({
        files: ['Q4/Model-Q4_K_M-00002-of-00002.gguf', 'Q4/Model-Q4_K_M-00001-of-00002.gguf'],
      }),
    );
  });

  it('auth required with a token already saved: retry only', async () => {
    const api = libApi(world({ settings: { ...world().settings, hasHfToken: true } }));
    let n = 0;
    api.on('POST /api/models/hub/*/*/fit', () => (n++ === 0 ? fail('HF_AUTH_REQUIRED', 401) : hubFit()));
    renderLib(PAGE, api);
    expect(await screen.findByText('Il tuo token di Hugging Face è già salvato.')).toBeTruthy();
    expect(screen.queryByLabelText('Token di accesso')).toBeNull();
    await userEvent.click(screen.getAllByRole('button', { name: 'Riprova' })[0]!);
    expect(await screen.findByRole('radiogroup')).toBeTruthy();
  });

  it('safetensors repo: whole model for vLLM; other fit errors; no card; no related', async () => {
    const files: HubFile[] = [
      { path: 'model.safetensors', sizeBytes: 1.5e9, kind: 'weights' },
      { path: 'config.json', sizeBytes: 900, kind: 'config' },
    ];
    const api = libApi(world({ files, search: [hubModel('org/Model-GGUF', { updatedAt: undefined, gated: false, formats: ['safetensors'] })] }));
    api.on('GET /api/models/hub/*/*/readme', () => fail('HF_NOT_FOUND', 404));
    let n = 0;
    api.on('POST /api/models/hub/*/*/fit', () =>
      n++ === 0 ? fail('NETWORK', 502) : { choices: [{ groupKey: '*weights', files: [files[0]], sizeBytes: 1.5e9, fit: fit('tight'), weakKey: 'org/Model-GGUF/model.safetensors//1500000000' }], facts: {} },
    );
    renderLib(PAGE, api);
    expect(await screen.findByText('Connessione a internet non disponibile')).toBeTruthy();
    expect(await screen.findByText('Questo modello non ha una descrizione.')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Riprova' })[0]!);
    expect(await screen.findByRole('radio', { name: /Modello completo/ })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'File aggiuntivi (facoltativi)' })).toBeNull();
    expect(screen.getByText('Configurazione')).toBeTruthy();
    expect(api.calls.find((c) => c.path.endsWith('/fit'))?.body).toEqual({ engine: 'vllm-docker' });
    await userEvent.click(screen.getByRole('button', { name: 'Scarica Modello completo · 1,4 GB' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Scarica · 1,4 GB' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/downloads')?.body).toMatchObject({ files: ['*'] }));
  });

  it('repo not found, nothing usable, unknown quant labels', async () => {
    const api = libApi(world({ search: [] }));
    let missing = true;
    api.on('GET /api/models/hub/*/*/files', () => (missing ? fail('HF_NOT_FOUND', 404) : [{ path: 'x.bin', sizeBytes: 1, kind: 'other' }]));
    api.on('POST /api/models/hub/*/*/fit', () => ({ choices: [], facts: {} }));
    renderLib(PAGE, api);
    expect(await screen.findByText('Modello non trovato su Hugging Face')).toBeTruthy();
    expect(screen.getByText('Non riesco a calcolare quanta memoria serve finché il problema sopra non è risolto.')).toBeTruthy();
    missing = false;
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(await screen.findByText('In questo repository non ci sono file di modello che GPU Bench sa usare.')).toBeTruthy();
  });

  it('a choice without quant falls back to the file name; without best the first is selected', async () => {
    const api = libApi();
    const base = hubFit();
    api.on('POST /api/models/hub/*/*/fit', () => ({
      ...base,
      best: undefined,
      choices: [{ ...base.choices[0]!, quant: undefined, groupKey: 'dir/odd-file.gguf' }],
    }));
    renderLib(PAGE, api);
    const radio = await screen.findByRole('radio', { name: /odd-file\.gguf/ });
    expect(radio.getAttribute('aria-checked')).toBe('true');
  });

  it('back link returns to the download tab', async () => {
    const { router } = renderLib(PAGE, libApi(world({ related: [] })));
    await userEvent.click(await screen.findByRole('link', { name: 'Modelli' , current: false }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: 'download' }));
  });
});
