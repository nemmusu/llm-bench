import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HubFile } from '../../../../src/contract/models';
import { MODEL_DETAIL_SECTIONS } from '../../../../src/renderer/components/library/model-detail-slots';
import { bridge, fail, fit, GPU, hubFit, hubModel, libApi, renderLib, run, system, world } from './fake';

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
    const choices = await screen.findByRole('radiogroup', { name: 'Scegli la versione da scaricare: Per llama.cpp (GGUF)' });
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
    // Files of the root grouped by quant and kind, each sub-folder in one line.
    expect(screen.getByText('Model-Q8_0.gguf', { selector: 'span.font-mono' })).toBeTruthy();
    expect(screen.getByText('Q4/')).toBeTruthy();
    expect(screen.getByText('2 file')).toBeTruthy();
    expect(screen.getAllByText('Visione (mmproj)').length).toBeGreaterThan(0);
    expect(screen.getByText('Altri file')).toBeTruthy();
    // The formats of the repo, each with its engine; this one is GGUF only.
    expect(document.querySelectorAll('[data-format-section]')).toHaveLength(1);
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
    expect(await screen.findByRole('radiogroup', { name: 'Scegli la versione da scaricare: Per llama.cpp (GGUF)' })).toBeTruthy();
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

  it('safetensors repo: the whole model folder for vLLM / SGLang; other fit errors; no card; no related', async () => {
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
    // Exactly the files of the model folder, as the core listed them for that choice.
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/downloads')?.body).toMatchObject({ files: ['model.safetensors'] }));
  });

  it('repo not found, nothing usable, unknown quant labels', async () => {
    const api = libApi(world({ search: [] }));
    let missing = true;
    api.on('GET /api/models/hub/*/*/files', () => (missing ? fail('HF_NOT_FOUND', 404) : [{ path: 'x.bin', sizeBytes: 1, kind: 'other' }]));
    api.on('POST /api/models/hub/*/*/fit', () => ({ choices: [], facts: {} }));
    renderLib(PAGE, api);
    expect(await screen.findByText('Modello non trovato su Hugging Face')).toBeTruthy();
    missing = false;
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(await screen.findByText('In questo repository non ci sono file di modello che LLM Bench sa usare.')).toBeTruthy();
  });

  it('a format whose choices are all gone, and a repo of formats LLM Bench does not run', async () => {
    const api = libApi(world({ related: [], search: [hubModel('org/Model-GGUF', { formats: [], otherFormats: ['MLX'] })] }));
    api.on('POST /api/models/hub/*/*/fit', () => ({ choices: [], facts: {} }));
    renderLib(PAGE, api);
    expect(await screen.findByText('Nessun modello in questo formato.')).toBeTruthy();
    expect(screen.getAllByText('non supportato').length).toBeGreaterThan(0);
    const bare = libApi(world({ related: [], search: [hubModel('org/Model-GGUF', { formats: [], otherFormats: [] })] }));
    renderLib(PAGE, bare);
    expect(await screen.findAllByText('In breve')).toBeTruthy();
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

  it('opened from the catalog, "Modelli" goes back to it as it was (search, engine, filters)', async () => {
    const api = libApi(world({ related: [], search: [hubModel('org/Model-GGUF'), hubModel('org/Other-GGUF')] }));
    const { router } = renderLib('/models?tab=download&q=model&engine=any&size=medium&fits=true&sort=likes', api);
    const list = await screen.findByRole('list', { name: 'Modelli trovati' });
    expect(screen.getByRole('searchbox', { name: 'Cerca un modello su Hugging Face' })).toHaveProperty('value', 'model');
    await userEvent.click(within(list).getByRole('link', { name: 'org/Model-GGUF' }));
    expect(await h1('Model-GGUF')).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: 'Modelli', current: false }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/models'));
    expect(router.state.location.search).toEqual({ tab: 'download', q: 'model', engine: 'any', size: 'medium', fits: true, sort: 'likes' });
    expect(await screen.findByRole('list', { name: 'Modelli trovati' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Cerca un modello su Hugging Face' })).toHaveProperty('value', 'model');
    expect(screen.getByRole('button', { name: 'Entra nella mia GPU' }).getAttribute('aria-pressed')).toBe('true');
    // Opened another way (a link, the palette): back to the last catalog seen.
    await router.navigate({ to: '/models/hub/$owner/$name', params: { owner: 'org', name: 'Other-GGUF' } });
    await userEvent.click(await screen.findByRole('link', { name: 'Modelli', current: false }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: 'model', engine: 'any' }));
  });

  it('a mixed repo: one section per format, each downloading exactly its files; other formats listed; sections added by other features', async () => {
    const files: HubFile[] = [
      { path: 'README.md', sizeBytes: 2000, kind: 'other' },
      { path: 'GGUF/Mixed-Q4_K_M.gguf', sizeBytes: 5e9, quant: 'Q4_K_M', groupKey: 'GGUF/Mixed-Q4_K_M.gguf', kind: 'weights' },
      { path: 'GGUF/mmproj-F16.gguf', sizeBytes: 9e8, kind: 'mmproj' },
      { path: 'FP8/config.json', sizeBytes: 900, kind: 'config' },
      { path: 'FP8/model.safetensors', sizeBytes: 9e9, kind: 'weights' },
      { path: 'NInfer/mixed_nvfp4.ninfer', sizeBytes: 7e9, kind: 'weights' },
      { path: 'mlx/model.safetensors', sizeBytes: 4e9, kind: 'weights' },
      { path: 'BF16/MTP-BF16/mtp.safetensors', sizeBytes: 8e8, kind: 'mtp' },
      { path: 'BF16/DFlash/model.safetensors', sizeBytes: 8e8, kind: 'draft' },
      { path: 'mlx/model-2.safetensors', sizeBytes: 1e9, kind: 'weights' },
      { path: 'encoder.safetensors', sizeBytes: 5e8, kind: 'weights' },
    ];
    const gguf = { choices: [{ groupKey: 'GGUF/Mixed-Q4_K_M.gguf', quant: 'Q4_K_M', files: [files[1]!], sizeBytes: 5e9, fit: fit('perfect'), weakKey: 'k1' }], best: 'GGUF/Mixed-Q4_K_M.gguf', facts: { paramsB: 9 } };
    const st = {
      choices: [
        { groupKey: 'FP8/*', quant: 'FP8', dir: 'FP8', files: [files[3]!, files[4]!], sizeBytes: 9e9 + 900, fit: fit('good'), weakKey: 'k2' },
        { groupKey: '*weights', dir: '', files: [files[4]!], sizeBytes: 1e6, fit: fit('perfect'), weakKey: 'k4' },
      ],
      best: 'FP8/*',
      facts: { paramsB: 9 },
    };
    const nf = {
      choices: [{ groupKey: 'NInfer/mixed_nvfp4.ninfer', quant: 'NVFP4', dir: 'NInfer', files: [files[5]!], sizeBytes: 7e9, fit: { ...fit('good'), notes: ['ninfer.estimate'] }, weakKey: 'k3', manifest: { components: ['text', 'mtp'], containerVersion: 2 } }],
      facts: {},
    };
    // A GPU NInfer does not run on: the choice is shown, marked.
    const api = libApi(world({ files, related: [], system: system({ gpus: [{ ...GPU, name: 'NVIDIA GeForce RTX 4090', computeCapability: '8.9' }] }), search: [hubModel('org/Model-GGUF', { formats: ['gguf', 'safetensors', 'ninfer', 'other'], otherFormats: ['MLX'], precision: 'FP8' })] }));
    api.on('POST /api/models/hub/*/*/fit', (b) => {
      const body = b as { engine: string; format?: string };
      return body.format === 'ninfer' ? nf : body.engine === 'vllm-docker' ? st : gguf;
    });
    const registered = [...MODEL_DETAIL_SECTIONS];
    MODEL_DETAIL_SECTIONS.push(
      { id: 'test-later', order: 9, Component: () => <p>Dopo</p> },
      { id: 'test-recipes', order: 1, Component: ({ repo, layout }) => <p>{`Comandi per ${repo}: ${layout?.safetensors.length ?? 0} cartelle`}</p> },
    );
    try {
      renderLib(PAGE, api);
      expect(await screen.findByRole('radiogroup', { name: 'Scegli la versione da scaricare: Per llama.cpp (GGUF)' })).toBeTruthy();
      expect(await screen.findByRole('radiogroup', { name: 'Scegli la versione da scaricare: Per vLLM / SGLang (safetensors)' })).toBeTruthy();
      const ninfer = await screen.findByRole('radiogroup', { name: 'Scegli la versione da scaricare: Per NInfer (ottimizzato per RTX 5090)' });
      expect(within(ninfer).getByText('Richiede una RTX 5090')).toBeTruthy();
      expect(within(ninfer).getByText('Contiene: text, mtp')).toBeTruthy();
      expect(within(ninfer).getByText('Versione del file 2: NInfer richiede la versione 3.')).toBeTruthy();
      expect(within(ninfer).queryByText('Consigliata')).toBeNull();
      expect(screen.getByText('Stima approssimativa: NInfer gestisce la memoria a modo suo.')).toBeTruthy();
      expect(screen.getByText('cartella FP8')).toBeTruthy();
      // Other formats: listed, never downloaded as a model.
      const other = document.querySelector('[data-format-section="other"]') as HTMLElement;
      expect(within(other).getByText('MLX')).toBeTruthy();
      expect(within(other).getAllByText('parte di un modello')).toHaveLength(2);
      expect(within(other).getByText('Modello bozza')).toBeTruthy();
      expect(within(other).getByText('cartella principale')).toBeTruthy();
      expect(within(other).getByText('2 file')).toBeTruthy();
      // The page's open slot, its sections in their order.
      expect(screen.getByText('Comandi per org/Model-GGUF: 1 cartelle')).toBeTruthy();
      const slots = [...document.querySelectorAll('[data-section]')].map((e) => e.getAttribute('data-section'));
      // Ordered by `order`, around the sections the app registers itself ("Comandi per questo modello" is 10).
      expect(slots).toEqual(['test-recipes', 'test-later', ...registered.map((x) => x.id)]);
      // The facts card lists every format too, MLX marked as not supported.
      expect(screen.getAllByText('non supportato').length).toBe(3);
      // The safetensors folder downloads its own files and nothing else.
      await userEvent.click(screen.getByRole('button', { name: /^Scarica FP8 · / }));
      await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^Scarica · / }));
      await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/downloads')?.body).toMatchObject({ files: ['FP8/config.json', 'FP8/model.safetensors'], label: 'Model-GGUF · FP8' }));
      expect(api.calls.filter((c) => c.path.endsWith('/fit')).map((c) => c.body)).toEqual(
        expect.arrayContaining([{ engine: 'llamacpp-native' }, { engine: 'vllm-docker' }, { engine: 'llamacpp-native', format: 'ninfer' }]),
      );
    } finally {
      MODEL_DETAIL_SECTIONS.splice(0, MODEL_DETAIL_SECTIONS.length, ...registered);
    }
  });
});
