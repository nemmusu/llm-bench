import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineStatus } from '../../../../src/contract/engines';
import type { EngineUpdateCheck } from '../../../../src/contract/engine-updates';
import type { NinferBuildPlan } from '../../../../src/contract/ninfer';
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
    api.w.updates['ninfer-native'] = {
      target: 'ninfer-native',
      method: 'git',
      state: 'current',
      current: 'e31bc99',
      commands: [],
      checkedAt: '2026-10-13T10:00:00.000Z',
      ninfer: { containerVersion: 3, artifacts: [{ id: 'b', name: 'qwen3_6_27b', file: '/m/b.ninfer', version: 2, needs: 3, command: 'cd /opt/ninfer && python3 tools/upgrade_ninfer_v2_to_v3.py /m/b.ninfer /m/b.v3.ninfer' }] },
    };
    api.on('POST /api/engines/ninfer/check', () => ready({ kind: 'ninfer-native', variant: undefined }));
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText(COMMIT.slice(0, 12))).toBeTruthy();
    expect(within(c).queryByText('Distribuzione')).toBeNull();
    // Its update says where the conversion of an older model runs (this PC); "Ricontrolla" asks again.
    expect(await within(c).findByText(/eseguilo su questo PC/)).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Ricontrolla' }));
    await waitFor(() => expect(api.calls.find((x) => x.path === '/api/engines/ninfer/check')?.body).toEqual({ kind: 'ninfer-native', ninferPath: '/opt/ninfer' }));
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-native', stage: 'build', bytesDone: 3, step: 3, steps: 10 }));
    expect(await within(c).findByText('Compilazione')).toBeTruthy();
    expect(within(c).queryByRole('button', { name: 'Compila NInfer…' })).toBeNull();
  });

  it('a check that takes time says so', async () => {
    const api = ninferApi();
    let answer!: (s: EngineStatus) => void;
    api.on('POST /api/engines/ninfer/check', () => new Promise<EngineStatus>((r) => (answer = r)));
    renderLib('/engines', api);
    const c = await card();
    await userEvent.type(await within(c).findByRole('textbox', { name: 'Dove si trova NInfer' }), '/n');
    await userEvent.click(within(c).getByRole('button', { name: 'Controlla e usa' }));
    expect(await within(c).findByRole('button', { name: 'Controllo…' })).toBeTruthy();
    act(() => answer(status({ installed: false })));
    expect(await within(c).findByRole('button', { name: 'Controlla e usa' })).toBeTruthy();
  });

  it('a saved build that stopped working: its own words, else the error catalog', async () => {
    const saved = { ninfer: { wsl: { distro: 'Ubuntu-24.04', path: '/home/u/ninfer' } } };
    const where = async (st: EngineStatus) => {
      const r = renderLib('/engines', ninferApi({ engines: [st], settings: saved }));
      const c = await card();
      return { c, r };
    };
    // Not found, the path from the status' location.
    let v = await where(status({ location: '/x/ninfer-serve', problemParams: { reason: 'ninfer_not_found' } }));
    expect(await within(v.c).findByText('ninfer-serve non è qui: /x/ninfer-serve')).toBeTruthy();
    v.r.unmount();
    // Nothing but the saved path to say.
    v = await where(status({ problemParams: { reason: 'ninfer_not_found' } }));
    expect(await within(v.c).findByText('ninfer-serve non è qui: /home/u/ninfer')).toBeTruthy();
    v.r.unmount();
    // The checkout is there (its commit known) but not built: say so, the build compiles it in place.
    v = await where(status({ version: '81c8ce093b2c', location: '/home/u/ninfer/build/apps/ninfer-serve', problemParams: { reason: 'ninfer_not_found' } }));
    expect(await within(v.c).findByText('NInfer c’è ma non è ancora compilato')).toBeTruthy();
    expect(within(v.c).getByText(/commit 81c8ce093b2c.*senza scaricare niente/)).toBeTruthy();
    v.r.unmount();
    // No reason at all: the catalog's words for a missing engine.
    v = await where(status({ problems: [], problemParams: undefined }));
    expect(await within(v.c).findByText('Il motore non è installato')).toBeTruthy();
    v.r.unmount();
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
    // A second attempt that ends without saying where: still done.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Compila' }));
    await waitFor(() => expect(api.calls.filter((x) => x.path === '/api/engines/ninfer/build')).toHaveLength(2));
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-native', stage: 'done', bytesDone: 0 }));
    expect(await screen.findByText(/NInfer è pronto/)).toBeTruthy();
    // Opened again and closed without building.
    await userEvent.click(await within(c).findByRole('button', { name: 'Compila NInfer…' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Compila NInfer' })).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Compila NInfer' })).toBeNull());
  });
});


const update = (over: Partial<EngineUpdateCheck> = {}): EngineUpdateCheck => ({
  target: 'ninfer-wsl',
  method: 'git',
  state: 'available',
  distro: 'Ubuntu-24.04',
  repo: '/home/u/ninfer',
  buildDir: '/home/u/ninfer/build',
  branch: 'master',
  current: 'e31bc99',
  latest: '4f2a9c1',
  commits: 1,
  log: [{ sha: '4f2a9c1', title: 'serve: faster MTP verification' }],
  commands: [
    ['git', '-C', '/home/u/ninfer', 'pull', '--ff-only'],
    ['cmake', '--build', '/home/u/ninfer/build', '-j'],
  ],
  restore: [['git', '-C', '/home/u/ninfer', 'reset', '--hard', COMMIT]],
  checkedAt: '2026-10-13T10:00:00.000Z',
  ninfer: { containerVersion: 3, artifacts: [] },
  ...over,
});

describe('NInfer updates (the engines\' own "Aggiorna")', () => {
  const configured = (check: EngineUpdateCheck) => {
    const api = ninferApi({ engines: [ready()], settings: { ninfer: { wsl: { distro: 'Ubuntu-24.04', path: '/home/u/ninfer' } } } });
    api.w.updates['ninfer-wsl'] = check;
    return api;
  };

  it('new commits with their titles, older models with NInfer\'s upgrade command, then the update with its way back', async () => {
    const b = bridge();
    const api = configured(
      update({
        commits: 7,
        log: Array.from({ length: 7 }, (_, i) => ({ sha: `${i}`.repeat(7), title: `commit ${i}` })),
        ninfer: {
          containerVersion: 3,
          artifacts: [
            { id: 'a', name: 'qwen3_8_27b_nvfp4', file: 'C:\\m\\a.ninfer', version: 2, needs: 3, command: 'cd /home/u/ninfer && python3 tools/upgrade_ninfer_v2_to_v3.py a b' },
            { id: 'b', name: 'qwen3_6_27b', file: 'C:\\m\\b.ninfer', version: 1, needs: 3 },
          ],
        },
      }),
    );
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('7 commit nuovi: e31bc99 → 4f2a9c1')).toBeTruthy();
    expect(within(c).getByText('commit 4')).toBeTruthy();
    expect(within(c).queryByText('commit 5')).toBeNull();
    expect(within(c).getByText('e altri 2')).toBeTruthy();
    expect(within(c).getByText('Modelli da aggiornare')).toBeTruthy();
    expect(within(c).getByText('qwen3_8_27b_nvfp4: formato v2')).toBeTruthy();
    expect(within(c).getByRole('region', { name: 'Comando da copiare' }).textContent).toContain('upgrade_ninfer_v2_to_v3.py');
    expect(within(c).getByText('Per questo passaggio NInfer non ha uno strumento: segui la sua guida.')).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Come si aggiorna un modello' }));
    expect(b.openExternal).toHaveBeenCalledWith(expect.stringContaining('weight-conversion.md'));

    await userEvent.click(within(c).getByRole('button', { name: 'Aggiorna' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiornare NInfer (WSL)?' });
    expect(within(dialog).getByText(/Tutto succede dentro Ubuntu-24.04/)).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'Comandi che eseguo' }).textContent).toContain('pull --ff-only');
    expect(within(dialog).getByRole('region', { name: 'Per tornare com’era' }).textContent).toContain('reset --hard');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiorna' }));
    await waitFor(() => expect(api.calls.some((x) => x.method === 'POST' && x.path === '/api/engines/ninfer-wsl/update')).toBe(true));
    act(() => api.emit({ type: 'engine.install', kind: 'update:ninfer-wsl', label: 'NInfer (WSL)', stage: 'git-pull', bytesDone: 0 }));
    expect(await within(c).findByText('Scarico le modifiche')).toBeTruthy();
    api.w.updates['ninfer-wsl'] = update({ state: 'current', current: '4f2a9c1', commits: undefined, log: undefined });
    act(() => api.emit({ type: 'engine.install', kind: 'update:ninfer-wsl', label: 'NInfer (WSL)', stage: 'done', bytesDone: 0, result: { version: '4f2a9c1' } }));
    expect(await within(c).findByText('Aggiornato a 4f2a9c1')).toBeTruthy();
    expect(await within(c).findByText('Hai l’ultima versione (4f2a9c1)')).toBeTruthy();
  });

  it('a failed rebuild says whether the previous version is back', async () => {
    const api = configured(update());
    renderLib('/engines', api);
    const c = await card();
    await within(c).findByText('1 commit nuovo: e31bc99 → 4f2a9c1');
    act(() => api.emit({ type: 'engine.install', kind: 'update:ninfer-wsl', stage: 'error', bytesDone: 0, error: { code: 'ENGINE_UPDATE_FAILED', message: 'x', params: { reason: 'cmake', restored: true, commit: 'e31bc99' } } }));
    expect(await within(c).findByText('La compilazione non è riuscita: ho rimesso la versione di prima (e31bc99), funziona come prima.')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'update:ninfer-wsl', stage: 'error', bytesDone: 0, error: { code: 'ENGINE_UPDATE_FAILED', message: 'x', params: { reason: 'cmake', restored: false } } }));
    expect(await within(c).findByText('Non sono riuscito a rimettere la versione di prima: ricompila il motore.')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'update:ninfer-wsl', stage: 'error', bytesDone: 0, error: { code: 'ENGINE_UPDATE_FAILED', message: 'x', params: { reason: 'cmake', restored: true } } }));
    expect(await within(c).findByText('La compilazione non è riuscita: ho rimesso la versione di prima (), funziona come prima.')).toBeTruthy();
  });

  it('commit titles without a count: as many as listed', async () => {
    const api = configured(update({ commits: undefined, log: [{ sha: 'aaaaaaa', title: 'only one' }] }));
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('only one')).toBeTruthy();
    expect(within(c).queryByText(/e altri/)).toBeNull();
  });

  it('a build outside its checkout: updated with its own tools, the models to upgrade still said', async () => {
    const api = configured({
      target: 'ninfer-wsl',
      method: 'none',
      state: 'none',
      reason: 'tools',
      commands: [],
      checkedAt: '2026-10-13T10:00:00.000Z',
      ninfer: { containerVersion: 3, artifacts: [{ id: 'b', name: 'qwen3_6_27b', file: 'C:\\m\\b.ninfer', version: 1, needs: 3 }] },
    });
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('Aggiorna questo motore con i suoi strumenti.')).toBeTruthy();
    expect(within(c).getByText('qwen3_6_27b: formato v1')).toBeTruthy();
  });
});
