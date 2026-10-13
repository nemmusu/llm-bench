import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridge, curated, fail, item, job, libApi, localModel, okItems, renderLib, report, run, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });
const firstLaunch = (over: Parameters<typeof world>[0] = {}) => {
  const w = world(over);
  w.settings.onboardingDone = false;
  return libApi(w);
};

describe('welcome wizard', () => {
  it('first launch: check, one-click install, recommended download, finish', async () => {
    const api = firstLaunch({
      local: [],
      check: report([
        ...okItems().slice(0, 2),
        item('llamacpp', { state: 'missing', code: 'ENGINE_NOT_INSTALLED', action: { kind: 'install-llamacpp', bytes: 480 * 1024 ** 2 } }),
        item('models', { state: 'missing', code: 'MODEL_NOT_FOUND', action: { kind: 'pick-model' } }),
        ...okItems().slice(4),
      ]),
      engines: [{ kind: 'llamacpp-native', available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true }],
    });
    renderLib('/welcome', api);
    expect(await h1('Benvenuto in LLM Bench')).toBeTruthy();
    expect(await screen.findByText('Versione 617.14 · CUDA 13.4')).toBeTruthy();
    expect(screen.getByText('Mancano ancora 2 cose: premi il pulsante accanto a ciascuna, al resto penso io.')).toBeTruthy();
    expect(screen.queryByText('vLLM (Linux)')).toBeNull();

    // One click installs llama.cpp; progress comes as events; the check runs again afterwards.
    await userEvent.click(screen.getByRole('button', { name: 'Installa · 480 MB (Motore llama.cpp)' }));
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/engines/llamacpp-native/install')).toBe(true);
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'download', bytesDone: 240 * 1024 ** 2, bytesTotal: 480 * 1024 ** 2 }));
    expect(await screen.findByRole('progressbar', { name: 'Motore llama.cpp' })).toBeTruthy();
    expect(screen.getByText('240 MB di 480 MB · 50%')).toBeTruthy();
    api.w.check = report([...okItems().slice(0, 3), item('models', { state: 'missing', code: 'MODEL_NOT_FOUND', action: { kind: 'pick-model' } }), ...okItems().slice(4)]);
    api.w.engines = [{ kind: 'llamacpp-native', available: true, installed: true, version: 'b11438', problems: [], supported: true }];
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'done', bytesDone: 1, bytesTotal: 1 }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/setup/check?fresh=1')).toBe(true));
    expect(await screen.findByText('Manca ancora una cosa: premi il pulsante accanto, al resto penso io.')).toBeTruthy();

    // "Scegli un modello" goes to the recommended setup.
    await userEvent.click(screen.getByRole('button', { name: /Scegli un modello/ }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Configurazione consigliata' })).toBeTruthy();
    expect(screen.getByText('llama.cpp b11438')).toBeTruthy();
    expect(screen.getByText('Qwen3 4B · Q4_K_M · 2,3 GB')).toBeTruthy();
    expect(await screen.findByText('Entra perfettamente')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Scarica · 2,3 GB' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scaricare Qwen3 4B · Q4_K_M?' });
    expect(within(dialog).getByText('120 GB')).toBeTruthy();
    expect(within(dialog).getByText('C:\\Models\\Qwen\\Qwen3-4B-GGUF')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scarica · 2,3 GB' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const req = api.calls.find((c) => c.method === 'POST' && c.path === '/api/downloads');
    expect(req?.body).toMatchObject({ repo: 'Qwen/Qwen3-4B-GGUF', revision: 'bc640142c66e1fdd12af0bd68f40445458f3869b', files: ['Qwen3-4B-Q4_K_M.gguf'] });
    act(() => api.emit({ type: 'download.update', job: job('dl-1', { repo: 'Qwen/Qwen3-4B-GGUF', label: 'Qwen3 4B · Q4_K_M', files: [{ path: 'Qwen3-4B-Q4_K_M.gguf' }], bytesDone: 1e9, bytesTotal: 2.5e9 }) }));
    expect(await screen.findByRole('progressbar', { name: 'Qwen3 4B · Q4_K_M' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Usa questa configurazione' }));
    expect(await screen.findByRole('heading', { name: 'Tutto pronto!' })).toBeTruthy();
    expect(screen.getByText('Sto ancora scaricando Qwen3 4B · Q4_K_M: puoi andare avanti, il download continua.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Vai al Benchmark' }));
    await waitFor(() => expect(api.w.settings.onboardingDone).toBe(true));
    expect(api.w.settings.lastEngine).toEqual({ kind: 'llamacpp-native' });
    expect(api.w.settings.lastModelId).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: 'Benvenuto in LLM Bench' })).toBeNull());
  });

  it('a model already on the PC is recommended and becomes the benchmark model', async () => {
    const api = firstLaunch({ tried: [run('r1', { decodeTps: 190.4 })] });
    renderLib('/welcome', api);
    await screen.findByText('Tutto pronto: puoi misurare la tua scheda video.');
    await userEvent.click(screen.getByRole('button', { name: 'Continua' }));
    expect(await screen.findByText('Model m1 · Q4_K_M · 4,0 GB')).toBeTruthy();
    expect(screen.getByText('È già sul tuo PC: il test parte subito, senza scaricare nulla.')).toBeTruthy();
    expect(await screen.findByText('Provato su questa GPU · 190 tok/s')).toBeTruthy();
    expect(screen.getByText('Installato')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Usa questa configurazione' }));
    expect(screen.queryByText(/Sto ancora scaricando/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Vai al Benchmark' }));
    await waitFor(() => expect(api.w.settings.lastModelId).toBe('m1'));
    expect(api.w.settings.lastProfile).toBe('quick');
  });

  it('can be skipped; back goes to the check', async () => {
    const api = firstLaunch();
    renderLib('/welcome', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Continua' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Indietro' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Controllo del sistema' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Salta, lo farò dopo' }));
    await waitFor(() => expect(api.w.settings.onboardingDone).toBe(true));
    expect(api.w.settings.lastEngine).toBeUndefined();
  });

  it('driver missing: official page, then check again; no GPU name in the setup step', async () => {
    const b = bridge();
    const api = firstLaunch({
      system: { ...world().system, gpus: [] },
      check: report(
        [
          item('driver', { state: 'missing', code: 'DRIVER_MISSING', action: { kind: 'open-driver-page', url: 'https://www.nvidia.com/drivers' } }),
          item('gpu', { state: 'missing', code: 'DRIVER_MISSING' }),
          ...okItems().slice(2),
        ],
        { canBenchmark: false },
      ),
    });
    renderLib('/welcome', api);
    expect(await screen.findByText('Prima serve il driver NVIDIA: senza, la scheda video non si può usare.')).toBeTruthy();
    expect(screen.getByText('La vedrò appena avrai installato il driver.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Scarica il driver (Driver NVIDIA)' }));
    expect(b.openExternal).toHaveBeenCalledWith('https://www.nvidia.com/drivers');
    const note = await screen.findByText('Installa il driver dalla pagina che si è aperta, poi torna qui e premi «Ricontrolla».');
    api.w.check = report(okItems());
    await userEvent.click(within(note.closest('[role="note"]') as HTMLElement).getByRole('button', { name: 'Ricontrolla' }));
    expect(await screen.findByText('Tutto pronto: puoi misurare la tua scheda video.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Continua' }));
    expect(await screen.findByText(/Per la tua scheda video ti consiglio/)).toBeTruthy();
  });

  it('Linux driver guidance opens the distro guide', async () => {
    const b = bridge({ platform: 'linux' });
    const api = firstLaunch({
      check: report([item('driver', { state: 'missing', code: 'DRIVER_MISSING', params: { guidance: 'nvidia-docs' }, action: { kind: 'open-driver-page', url: 'https://docs.nvidia.com/x' } }), ...okItems().slice(1)], {
        platform: 'linux',
        canBenchmark: false,
      }),
    });
    renderLib('/welcome', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Apri la guida (Driver NVIDIA)' }));
    expect(b.openExternal).toHaveBeenCalledWith('https://docs.nvidia.com/x');
  });

  it('check errors, recommendation errors and loading states', async () => {
    const api = firstLaunch({ local: [] });
    let checkFails = true;
    api.on('GET /api/setup/check', () => (checkFails ? fail('INTERNAL', 500) : report(okItems())));
    api.on('GET /api/models/curated', () => fail('NETWORK', 502));
    renderLib('/welcome', api);
    expect(await screen.findByText('Si è verificato un errore imprevisto')).toBeTruthy();
    checkFails = false;
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(await screen.findByText('Tutto pronto: puoi misurare la tua scheda video.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Continua' }));
    expect(await screen.findByText('Connessione a internet non disponibile')).toBeTruthy();
  });

  it('a reference download already done counts as finished', async () => {
    const api = firstLaunch({ local: [], curated: curated(2), downloads: [job('d', { repo: 'Qwen/Qwen3-4B-GGUF', files: [{ path: 'Qwen3-4B-Q4_K_M.gguf' }], state: 'done' })] });
    renderLib('/welcome', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Continua' }));
    expect(await screen.findByRole('button', { name: 'Scarica · 2,3 GB' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Usa questa configurazione' }));
    expect(screen.queryByText(/Sto ancora scaricando/)).toBeNull();
  });

  it('a local model without quant or size still reads well', async () => {
    const api = firstLaunch({ local: [localModel('bare', { identity: { quant: undefined, sizeBytes: undefined } })], engines: [] });
    renderLib('/welcome', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Continua' }));
    expect(await screen.findByText('Model bare · 0 B')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Installa' })).toBeTruthy();
  });

  it('setup step: llama.cpp to install (with size, failing) or installed without a version', async () => {
    const api = firstLaunch({
      engines: [{ kind: 'llamacpp-native', available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true }],
      check: report([...okItems().slice(0, 2), item('llamacpp', { state: 'missing', action: { kind: 'install-llamacpp', bytes: 480 * 1024 ** 2 } }), ...okItems().slice(3)]),
    });
    renderLib('/welcome', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Continua' }));
    const setup = (await screen.findByRole('heading', { level: 2, name: 'Configurazione consigliata' })).closest('section') as HTMLElement;
    await userEvent.click(await within(setup).findByRole('button', { name: 'Installa · 480 MB' }));
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'error', bytesDone: 0 }));
    expect(await within(setup).findByText('Installazione del motore non riuscita')).toBeTruthy();
    api.w.engines = [{ kind: 'llamacpp-native', available: true, installed: true, problems: [], supported: true }];
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'done', bytesDone: 0 }));
    expect(await within(setup).findByText('Installato')).toBeTruthy();
    expect(within(setup).getByText('llama.cpp')).toBeTruthy();
  });
});
