import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineStatus } from '../../../../src/contract/engines';
import type { NinferBuildPlan, NinferUpdateStatus } from '../../../../src/contract/ninfer';
import { bridge, ENGINES, fail, libApi, patchPointer, renderLib, system, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeEach(() => patchPointer());
afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const COMMIT = 'e31bc99b13f517c8aae70b997b7c4a49b4dcdc5d';
const NEXT = '4f2a9c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49';
const linux = system({ os: { platform: 'linux', release: '6', arch: 'x64', name: 'Ubuntu 24.04', isWsl: false } });
const card = () => screen.findByRole('region', { name: 'NInfer' });

const status = (over: Partial<EngineStatus> = {}): EngineStatus => ({ kind: 'ninfer-wsl', available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'not_configured' }, supported: true, ...over });
const ready = (over: Partial<EngineStatus> = {}): EngineStatus => status({ available: true, installed: true, location: '/home/u/ninfer/build/apps/ninfer-serve', variant: 'Ubuntu-24.04', version: COMMIT.slice(0, 12), problems: [], problemParams: undefined, ...over });

function ninferApi(o: { engines?: EngineStatus[]; settings?: object; system?: ReturnType<typeof system> } = {}) {
  const api = libApi(world({ engines: [...ENGINES(), ...(o.engines ?? [status()])], ...(o.system ? { system: o.system } : {}) }));
  Object.assign(api.w.settings, o.settings ?? {});
  api.on('GET /api/engines/ninfer/distros', () => ({
    wsl: true,
    distros: [
      { name: 'Ubuntu-24.04', default: true, version: 2, running: true },
      { name: 'Debian', default: false, version: 2 },
      { name: 'Legacy', default: false, version: 1 },
    ],
  }));
  return api;
}

describe('NInfer card', () => {
  it('says where NInfer runs: unsupported systems, the RTX 5090, not found', async () => {
    renderLib('/engines', ninferApi({ system: system({ os: { platform: 'darwin', release: '24', arch: 'arm64', name: 'macOS', isWsl: false } }) }));
    const mac = await card();
    expect(await within(mac).findByText('NInfer gira su Linux, oppure su Windows dentro WSL.')).toBeTruthy();
  });

  it('a status for every case', async () => {
    const api = ninferApi({ engines: [status({ supported: false, problems: [] })] });
    renderLib('/engines', api);
    expect(await within(await card()).findByText('Non disponibile su questo sistema')).toBeTruthy();
  });

  it('on Linux: the path, checked by running it, then saved', async () => {
    const api = ninferApi({ system: linux, engines: [status({ kind: 'ninfer-native', problems: ['ENGINE_GPU_UNSUPPORTED'], problemParams: { engine: 'NInfer', gpu: 'RTX 5090' } })] });
    let answer: EngineStatus = status({ kind: 'ninfer-native', problemParams: { reason: 'ninfer_not_found', path: '/opt/x/build/apps/ninfer-serve' } });
    api.on('POST /api/engines/ninfer/check', () => answer);
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('Serve una RTX 5090')).toBeTruthy();
    expect(within(c).getByText('NInfer funziona solo con una RTX 5090.')).toBeTruthy();
    expect(within(c).queryByRole('combobox', { name: 'Distribuzione WSL' })).toBeNull();
    const field = within(c).getByRole('textbox', { name: 'Dove si trova NInfer' });
    await userEvent.click(within(c).getByRole('button', { name: 'Controlla e usa' }));
    expect(api.calls.some((x) => x.path === '/api/engines/ninfer/check')).toBe(false);
    await userEvent.type(field, '/opt/x');
    await userEvent.click(within(c).getByRole('button', { name: 'Controlla e usa' }));
    expect(await within(c).findByText('ninfer-serve non è qui: /opt/x/build/apps/ninfer-serve')).toBeTruthy();
    // A reason the card does not know: the error catalog says it.
    answer = status({ kind: 'ninfer-native', problems: ['ENGINE_EXITED'], problemParams: { code: '1' } });
    await userEvent.click(within(c).getByRole('button', { name: 'Controlla e usa' }));
    await waitFor(() => expect(api.calls.filter((x) => x.path === '/api/engines/ninfer/check')).toHaveLength(2));
    answer = ready({ kind: 'ninfer-native', variant: undefined });
    await userEvent.click(within(c).getByRole('button', { name: 'Controlla e usa' }));
    await waitFor(() => expect(api.w.settings.ninfer).toEqual({ native: { path: '/opt/x' } }));
    expect(await screen.findByText('NInfer trovato: lo uso da ora in poi.')).toBeTruthy();
  });

  it('in WSL: the distro, a path not found, a check that fails, a save that fails', async () => {
    bridge();
    const api = ninferApi({ engines: [status({ available: false })] });
    api.on('POST /api/engines/ninfer/check', (b) => ((b as { ninferPath: string }).ninferPath === '/bad' ? fail('INTERNAL', 500, 'boom') : ready()));
    api.on('PUT /api/settings', () => fail('INTERNAL', 500, 'disk full'));
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('Da configurare')).toBeTruthy();
    const distro = await within(c).findByRole('combobox', { name: 'Distribuzione WSL' });
    expect(distro.textContent).toContain('Ubuntu-24.04');
    await userEvent.click(distro);
    await userEvent.click(await screen.findByRole('option', { name: /Debian/ }));
    const field = within(c).getByRole('textbox', { name: 'Dove si trova NInfer' });
    await userEvent.type(field, '/bad');
    await userEvent.click(within(c).getByRole('button', { name: 'Controlla e usa' }));
    expect((await within(c).findAllByText(/boom|Errore|errore/)).length).toBeGreaterThan(0);
    await userEvent.clear(field);
    await userEvent.type(field, '/home/u/ninfer');
    await userEvent.click(within(c).getByRole('button', { name: 'Controlla e usa' }));
    await waitFor(() => expect(api.calls.some((x) => x.method === 'PUT' && (x.body as { ninfer?: unknown }).ninfer !== undefined)).toBe(true));
    expect((api.calls.find((x) => x.method === 'PUT' && (x.body as { ninfer?: unknown }).ninfer !== undefined)?.body as { ninfer: unknown }).ninfer).toEqual({ wsl: { distro: 'Debian', path: '/home/u/ninfer' } });
    expect(within(c).getByText(/I modelli sul disco di Windows/)).toBeTruthy();
  });

  it('without WSL: says how to get it', async () => {
    const api = ninferApi();
    api.on('GET /api/engines/ninfer/distros', () => ({ wsl: false, distros: [] }));
    renderLib('/engines', api);
    expect(await within(await card()).findByText('WSL non è pronto')).toBeTruthy();
  });

  it('a saved build: where it is, its commit, a problem it has, a new check, a change of path', async () => {
    const api = ninferApi({
      engines: [status({ installed: false, location: '/home/u/ninfer/build/apps/ninfer-serve', variant: 'Ubuntu-24.04', problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'distro_missing', distro: 'Ubuntu-24.04' } })],
      settings: { ninfer: { wsl: { distro: 'Ubuntu-24.04', path: '/home/u/ninfer' } } },
    });
    api.on('POST /api/engines/ninfer/check', () => ready());
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('La distribuzione Ubuntu-24.04 non c’è')).toBeTruthy();
    expect(within(c).getByText('Ubuntu-24.04')).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Ricontrolla' }));
    await waitFor(() => expect(api.calls.find((x) => x.path === '/api/engines/ninfer/check')?.body).toEqual({ kind: 'ninfer-wsl', ninferPath: '/home/u/ninfer', wslDistro: 'Ubuntu-24.04' }));
    await userEvent.click(within(c).getByRole('button', { name: 'Cambia' }));
    expect(within(c).getByRole('textbox', { name: 'Dove si trova NInfer' })).toHaveProperty('value', '/home/u/ninfer');
  });

  it('a saved native build that works: its commit; a build under way shows its progress', async () => {
    const api = ninferApi({ system: linux, engines: [ready({ kind: 'ninfer-native', variant: undefined })], settings: { ninfer: { native: { path: '/opt/ninfer' } } } });
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText(COMMIT.slice(0, 12))).toBeTruthy();
    expect(within(c).queryByText('Distribuzione')).toBeNull();
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-native', stage: 'build', bytesDone: 3, step: 3, steps: 10 }));
    expect(await within(c).findByText('Compilazione')).toBeTruthy();
    expect(within(c).queryByRole('button', { name: 'Compila NInfer…' })).toBeNull();
  });
});

const plan = (over: Partial<NinferBuildPlan> = {}): NinferBuildPlan => ({
  kind: 'ninfer-wsl',
  distro: 'Ubuntu-24.04',
  dir: '/home/u/ninfer',
  servePath: '/home/u/ninfer/build/apps/ninfer-serve',
  existing: false,
  commands: ['git clone --progress https://github.com/Neroued/ninfer.git /home/u/ninfer', 'cmake --build /home/u/ninfer/build -j'],
  prereqs: [
    { id: 'git', found: true, version: '2.43.0', packages: ['git'] },
    { id: 'cmake', found: false, version: '3.22.1', need: '3.28', packages: ['cmake'] },
    { id: 'ninja', found: false, packages: ['ninja-build'] },
  ],
  aptCommand: 'sudo apt install cmake ninja-build',
  cudaFromNvidia: true,
  ready: false,
  ...over,
});

describe('Compila NInfer', () => {
  it('checks the folder, lists what is missing, then builds after the confirmation', async () => {
    const api = ninferApi();
    let next = plan();
    api.on('POST /api/engines/ninfer/build-plan', () => next);
    api.on('POST /api/engines/ninfer/build', () => ({ ok: true }));
    renderLib('/engines', api);
    const c = await card();
    await within(c).findByRole('combobox', { name: 'Distribuzione WSL' });
    await userEvent.click(within(c).getByRole('button', { name: 'Compila NInfer…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compila NInfer' });
    expect(within(dialog).getByText(/dentro Ubuntu-24.04/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Compila' }) as HTMLButtonElement).disabled).toBe(true);
    const folder = within(dialog).getByRole('textbox', { name: 'Cartella' });
    await userEvent.clear(folder);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Controlla' }));
    expect(await within(dialog).findByText('Serve 3.28 o più recente')).toBeTruthy();
    expect(api.calls.find((x) => x.path === '/api/engines/ninfer/build-plan')?.body).toEqual({ kind: 'ninfer-wsl', dir: '~/ninfer', distro: 'Ubuntu-24.04' });
    expect(within(dialog).getByText('Manca')).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'Comando da copiare' }).textContent).toContain('sudo apt install cmake ninja-build');
    expect(within(dialog).getByText(/Il toolkit CUDA/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Compila' }) as HTMLButtonElement).disabled).toBe(true);
    // Everything there, an existing checkout: built in place.
    next = plan({ existing: true, prereqs: [{ id: 'git', found: true, packages: ['git'] }], aptCommand: undefined, cudaFromNvidia: false, ready: true });
    await userEvent.type(folder, '~/src/ninfer');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Controlla' }));
    expect(await within(dialog).findByText(/c’è già NInfer/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Compila' }));
    await waitFor(() => expect(api.calls.find((x) => x.path === '/api/engines/ninfer/build')?.body).toEqual({ kind: 'ninfer-wsl', dir: '/home/u/ninfer', distro: 'Ubuntu-24.04', confirm: true }));
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-wsl', stage: 'clone', bytesDone: 40, step: 40, steps: 100 }));
    expect(await within(dialog).findByText('Download del codice')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-wsl', stage: 'done', bytesDone: 0, result: { ninferPath: '/home/u/ninfer/build/apps/ninfer-serve' } }));
    expect(await screen.findByText('NInfer è pronto: /home/u/ninfer/build/apps/ninfer-serve')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Compila NInfer' })).toBeNull());
  });

  it('shows a failed check and a failed build; on Linux it builds on this PC', async () => {
    const api = ninferApi({ system: linux, engines: [status({ kind: 'ninfer-native' })] });
    let broken = true;
    api.on('POST /api/engines/ninfer/build-plan', () => (broken ? fail('INTERNAL', 500, 'no answer') : plan({ kind: 'ninfer-native', distro: undefined, ready: true })));
    api.on('POST /api/engines/ninfer/build', () => ({ ok: true }));
    renderLib('/engines', api);
    const c = await card();
    await userEvent.click(await within(c).findByRole('button', { name: 'Compila NInfer…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compila NInfer' });
    expect(within(dialog).getByText(/su questo PC/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Controlla' }));
    await waitFor(() => expect(api.calls.filter((x) => x.path === '/api/engines/ninfer/build-plan')).toHaveLength(1));
    broken = false;
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Cartella' }), '2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Controlla' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Compila' }));
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-native', stage: 'error', bytesDone: 0 }));
    expect(await within(dialog).findByText('Installazione del motore non riuscita')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla' }));
  });
});

const update = (over: Partial<NinferUpdateStatus> = {}): NinferUpdateStatus => ({
  kind: 'ninfer-wsl',
  distro: 'Ubuntu-24.04',
  dir: '/home/u/ninfer',
  updatable: true,
  fetched: true,
  current: COMMIT,
  upstream: 'origin/master',
  latest: NEXT,
  behind: 1,
  ahead: 0,
  commits: [{ sha: NEXT, title: 'serve: faster MTP verification' }],
  dirty: [],
  commands: ['git -C /home/u/ninfer pull --ff-only', 'cmake --build /home/u/ninfer/build -j'],
  restore: [`git -C /home/u/ninfer reset --hard ${COMMIT}`],
  containerVersion: 3,
  artifacts: [],
  ...over,
});

describe('NInfer updates', () => {
  const configured = () => ninferApi({ engines: [ready()], settings: { ninfer: { wsl: { distro: 'Ubuntu-24.04', path: '/home/u/ninfer' } } } });

  it('what the check found: up to date, new commits, changes, own commits, an older model, no checkout', async () => {
    const b = bridge();
    const api = configured();
    const answers: (NinferUpdateStatus | 'fail')[] = [
      'fail',
      update({ behind: 0, commits: [], latest: COMMIT }),
      update({
        behind: 7,
        fetched: false,
        commits: Array.from({ length: 7 }, (_, i) => ({ sha: `${i}`.repeat(40), title: `commit ${i}` })),
        dirty: ['src/a.cpp'],
        ahead: 2,
        upstream: undefined,
        artifacts: [
          { id: 'a', name: 'qwen3_8_27b_nvfp4', file: 'C:\\m\\a.ninfer', version: 2, needs: 3, command: 'cd /home/u/ninfer && python3 tools/upgrade_ninfer_v2_to_v3.py a b' },
          { id: 'b', name: 'qwen3_6_27b', file: 'C:\\m\\b.ninfer', version: 1, needs: 3 },
        ],
      }),
      update({ updatable: false, dir: undefined, commands: [], restore: [], behind: 0, commits: [], artifacts: [{ id: 'b', name: 'qwen3_6_27b', file: 'C:\\m\\b.ninfer', version: 1, needs: 3 }] }),
    ];
    api.on('POST /api/engines/ninfer/update-check', () => {
      const a = answers.shift() as NinferUpdateStatus | 'fail';
      return a === 'fail' ? fail('INTERNAL', 500, 'offline') : a;
    });
    renderLib('/engines', api);
    const c = await card();
    const check = await within(c).findByRole('button', { name: 'Controlla aggiornamenti' });
    await userEvent.click(check);
    await waitFor(() => expect(api.calls.filter((x) => x.path === '/api/engines/ninfer/update-check')).toHaveLength(1));
    await userEvent.click(check);
    expect(await within(c).findByText('NInfer è aggiornato (e31bc99).')).toBeTruthy();
    await userEvent.click(check);
    expect(await within(c).findByText('7 commit nuovi (e31bc99 → 4f2a9c1)')).toBeTruthy();
    expect(within(c).getByText('e altri 2')).toBeTruthy();
    expect(within(c).getByText(/Non riesco a raggiungere GitHub/)).toBeTruthy();
    expect(within(c).getByText('Ci sono modifiche nella cartella di NInfer')).toBeTruthy();
    expect(within(c).getByText(/Ci sono 2 commit che non sono su GitHub/)).toBeTruthy();
    expect((within(c).getByRole('button', { name: 'Aggiorna…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(c).getByText('qwen3_8_27b_nvfp4: formato v2')).toBeTruthy();
    expect(within(c).getByText('Per questo passaggio NInfer non ha uno strumento: segui la sua guida.')).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Come si aggiorna un modello' }));
    expect(b.openExternal).toHaveBeenCalledWith(expect.stringContaining('weight-conversion.md'));
    await userEvent.click(check);
    expect(await within(c).findByText(/non è nella cartella in cui è stato compilato/)).toBeTruthy();
    expect(within(c).getByText('qwen3_6_27b: formato v1')).toBeTruthy();
  });

  it('Aggiorna: the commands and the way back, the progress, then the new commit', async () => {
    const api = configured();
    let latest = update();
    api.on('POST /api/engines/ninfer/update-check', () => latest);
    api.on('POST /api/engines/ninfer/update', () => ({ ok: true }));
    renderLib('/engines', api);
    const c = await card();
    await userEvent.click(await within(c).findByRole('button', { name: 'Controlla aggiornamenti' }));
    expect(await within(c).findByText('1 commit nuovo (e31bc99 → 4f2a9c1)')).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Aggiorna…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiorna NInfer' });
    expect(within(dialog).getByRole('region', { name: 'Comandi che eseguirò' }).textContent).toContain('pull --ff-only');
    expect(within(dialog).getByRole('region', { name: 'Per tornare com’era' }).textContent).toContain('reset --hard');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiorna' }));
    await waitFor(() => expect(api.calls.find((x) => x.path === '/api/engines/ninfer/update')?.body).toEqual({ kind: 'ninfer-wsl', confirm: true }));
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-wsl', stage: 'pull', bytesDone: 0 }));
    expect(await within(dialog).findByText('Download delle novità')).toBeTruthy();
    latest = update({ behind: 0, commits: [], current: NEXT, latest: NEXT });
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-wsl', stage: 'done', bytesDone: 0, result: { ninferPath: '/home/u/ninfer/build/apps/ninfer-serve', commit: NEXT } }));
    expect(await screen.findByText('NInfer aggiornato: 4f2a9c1')).toBeTruthy();
    expect(await within(c).findByText('NInfer è aggiornato (4f2a9c1).')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Aggiorna NInfer' })).toBeNull());
  });

  it('why an update stopped: local changes, a failed build put back or not, anything else', async () => {
    const api = configured();
    api.on('POST /api/engines/ninfer/update-check', () => update({ behind: 2, commits: [] }));
    let reject = false;
    api.on('POST /api/engines/ninfer/update', () => (reject ? fail('VALIDATION', 400, 'A build is already running') : { ok: true }));
    renderLib('/engines', api);
    const c = await card();
    await userEvent.click(await within(c).findByRole('button', { name: 'Controlla aggiornamenti' }));
    await userEvent.click(await within(c).findByRole('button', { name: 'Aggiorna…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiorna NInfer' });
    expect(within(dialog).getByText('2 commit nuovi (e31bc99 → 4f2a9c1)')).toBeTruthy();
    const attempt = async (error: object | undefined) => {
      await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiorna' }));
      await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Aggiorna' }) as HTMLButtonElement).disabled).toBe(true));
      act(() => api.emit({ type: 'engine.install', kind: 'ninfer-wsl', stage: 'error', bytesDone: 0, ...(error ? { error } : {}) } as never));
    };
    await attempt({ code: 'ENGINE_INSTALL_FAILED', message: 'x', params: { reason: 'ninfer_dirty', files: 'src/a.cpp' } });
    expect(await within(dialog).findByText(/salvale o annullale, poi riprova \(src\/a\.cpp\)/)).toBeTruthy();
    await attempt({ code: 'ENGINE_INSTALL_FAILED', message: 'x', detail: 'nvcc fatal', params: { reason: 'ninfer_update', restored: true, commit: COMMIT.slice(0, 12) } });
    expect(await within(dialog).findByText('NInfer è tornato com’era (e31bc99) e funziona come prima.')).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'Ultime righe della compilazione' }).textContent).toBe('nvcc fatal');
    await attempt({ code: 'ENGINE_INSTALL_FAILED', message: 'x', params: { reason: 'ninfer_update', restored: false } });
    expect(await within(dialog).findByText(/Non sono riuscito a rimettere la versione di prima/)).toBeTruthy();
    await attempt({ code: 'ENGINE_INSTALL_FAILED', message: 'x' });
    expect(await within(dialog).findByText('Installazione del motore non riuscita')).toBeTruthy();
    // The request itself refused (another build running).
    reject = true;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiorna' }));
    expect(await within(dialog).findByText(/A build is already running|Dati non validi|non valid/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla' }));
  });
});
