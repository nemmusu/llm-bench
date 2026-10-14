/**
 * NInfer's card with its two builds (the official one and NInfer-all): each build's state, its one
 * obvious action ("Scarica e compila", "Ricompila", "Aggiorna"), what is missing for it, its progress
 * and "Annulla", a failure in plain words, "Cambia cartella" and "Avanzate".
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineStatus } from '../../../../src/contract/engines';
import type { EngineUpdateCheck } from '../../../../src/contract/engine-updates';
import type { NinferBuildInfo, NinferBuildPlan } from '../../../../src/contract/ninfer';
import { bridge, fail, libApi, ninferBuild, patchPointer, renderLib, system, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeEach(() => patchPointer());
afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const COMMIT = 'e31bc99';
const linux = system({ os: { platform: 'linux', release: '6', arch: 'x64', name: 'Ubuntu 24.04', isWsl: false } });
const card = () => screen.findByRole('region', { name: 'NInfer' });
const official = () => screen.findByRole('region', { name: 'NInfer (ufficiale)' });
const allRow = () => screen.findByRole('region', { name: 'NInfer-all (serve per i modelli GGUF-NInfer)' });

const ok = (over: Partial<EngineStatus> = {}): EngineStatus => ({ kind: 'ninfer-wsl', available: true, installed: true, problems: [], supported: true, ...over });
const ready = (over: Partial<NinferBuildInfo> = {}): NinferBuildInfo =>
  ninferBuild({ state: 'ready', dir: '/home/u/ninfer', path: '/home/u/ninfer/build/apps/ninfer-serve', commit: COMMIT, built: COMMIT, status: ok(), ...over });
const readyAll = (over: Partial<NinferBuildInfo> = {}): NinferBuildInfo =>
  ninferBuild({ build: 'all', state: 'ready', dir: '/home/u/ninfer-all', path: '/home/u/ninfer-all/build/apps/ninfer-serve', commit: 'a1b2c3d', customEngineId: 'ninfer-all', status: ok(), kvDtypes: ['bf16', 'rk8v4'], ...over });

function ninferApi(o: { builds?: NinferBuildInfo[]; system?: ReturnType<typeof system>; kind?: 'ninfer-native' | 'ninfer-wsl' } = {}) {
  const api = libApi(world({ ...(o.system ? { system: o.system } : {}), ninferBuilds: { kind: o.kind ?? 'ninfer-wsl', builds: o.builds ?? [ninferBuild(), ninferBuild({ build: 'all' })] } }));
  api.on('GET /api/engines/ninfer/distros', () => ({ wsl: true, distros: [{ name: 'Ubuntu-24.04', default: true, version: 2, running: true }] }));
  return api;
}

const plan = (over: Partial<NinferBuildPlan> = {}): NinferBuildPlan => ({
  kind: 'ninfer-wsl',
  distro: 'Ubuntu-24.04',
  dir: '/home/u/ninfer',
  servePath: '/home/u/ninfer/build/apps/ninfer-serve',
  existing: false,
  commands: ['git clone --progress https://github.com/Neroued/ninfer.git /home/u/ninfer', 'cmake --build /home/u/ninfer/build -j'],
  prereqs: [{ id: 'git', found: true, version: '2.43.0', packages: ['git'] }],
  cudaFromNvidia: false,
  source: { url: 'https://github.com/Neroued/ninfer.git' },
  downloadBytes: 28_611 * 1024,
  cpus: 16,
  minutes: 10,
  ready: true,
  ...over,
});

const update = (over: Partial<EngineUpdateCheck> = {}): EngineUpdateCheck => ({
  target: 'ninfer-wsl',
  method: 'git',
  state: 'available',
  distro: 'Ubuntu-24.04',
  repo: '/home/u/ninfer',
  buildDir: '/home/u/ninfer/build',
  branch: 'master',
  current: COMMIT,
  latest: '4f2a9c1',
  commits: 1,
  log: [{ sha: '4f2a9c1', title: 'serve: faster MTP verification' }],
  commands: [['git', '-C', '/home/u/ninfer', 'pull', '--ff-only']],
  checkedAt: '2026-10-13T10:00:00.000Z',
  ninfer: { containerVersion: 3, artifacts: [] },
  ...over,
});

describe('NInfer card', () => {
  it('says where NInfer runs: unsupported systems', async () => {
    renderLib('/engines', ninferApi({ system: system({ os: { platform: 'darwin', release: '24', arch: 'arm64', name: 'macOS', isWsl: false } }) }));
    const mac = await card();
    expect(await within(mac).findByText('NInfer gira su Linux, oppure su Windows dentro WSL.')).toBeTruthy();
    expect(within(mac).getByText('Non disponibile su questo sistema')).toBeTruthy();
  });

  it('builds it could not read: said, with "Riprova"', async () => {
    const api = ninferApi();
    let broken = true;
    api.on('GET /api/engines/ninfer/builds', () => (broken ? fail('INTERNAL', 500, 'no answer') : api.w.ninferBuilds));
    renderLib('/engines', api);
    const c = await card();
    broken = false;
    await userEvent.click(await within(c).findByRole('button', { name: 'Riprova' }));
    expect(await within(c).findByRole('region', { name: 'NInfer (ufficiale)' })).toBeTruthy();
  });

  it('neither build set up: both say so, NInfer-all why it is there; "Scarica e compila" checks, builds, shows progress, cancels', async () => {
    const api = ninferApi();
    api.on('POST /api/engines/ninfer/build-plan', () => plan());
    api.on('POST /api/engines/ninfer/build', () => ({ ok: true }));
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('Da configurare')).toBeTruthy();
    const off = await official();
    expect(within(off).getByText('Non installato')).toBeTruthy();
    expect(within(off).getByText('github.com/Neroued/ninfer')).toBeTruthy();
    expect(within(off).getByText('~/ninfer dentro Ubuntu-24.04 (la crea la compilazione)')).toBeTruthy();
    const all = await allRow();
    expect(within(all).getByText('github.com/iamwavecut/ninfer-all (ramo master)')).toBeTruthy();
    expect(within(all).getByText(/Ti serve solo per i modelli GGUF-NInfer/)).toBeTruthy();
    expect(within(all).getByRole('button', { name: 'Ce l’ho già: indica la cartella' })).toBeTruthy();
    expect(within(c).getByText(/I modelli sul disco di Windows/)).toBeTruthy();

    await userEvent.click(within(off).getByRole('button', { name: 'Scarica e compila' }));
    await waitFor(() => expect(api.calls.find((x) => x.path === '/api/engines/ninfer/build')?.body).toEqual({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '/home/u/ninfer', confirm: true }));
    expect(api.calls.find((x) => x.path === '/api/engines/ninfer/build-plan')?.body).toEqual({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04' });
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-wsl', stage: 'build', bytesDone: 3, step: 3, steps: 10 }));
    expect(await within(off).findByText('Compilazione in corso…')).toBeTruthy();
    expect(within(off).getByText(/Continua anche se chiudi/)).toBeTruthy();
    await userEvent.click(within(off).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(api.calls.some((x) => x.path === '/api/engines/ninfer/build/cancel')).toBe(true));
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-wsl', stage: 'done', bytesDone: 0, result: { ninferPath: '/home/u/ninfer/build/apps/ninfer-serve' } }));
    expect(await screen.findByText('NInfer (ufficiale) è pronto.')).toBeTruthy();
  });

  it('what is missing for NInfer-all: CUDA too old, the apt line and why; "Ricontrolla" checks again', async () => {
    const api = ninferApi();
    let next = plan({
      dir: '/home/u/ninfer-all',
      existing: true,
      ready: false,
      clearCache: true,
      prereqs: [
        { id: 'git', found: true, version: '2.43.0', packages: ['git'] },
        { id: 'cuda', found: false, version: '13.0', need: '13.1', packages: ['cuda-toolkit-13-3'] },
      ],
      aptCommand: 'sudo apt install cuda-toolkit-13-3',
      cuda: { need: '13.1', have: '13.0', package: 'cuda-toolkit-13-3', driver: '13.4', allNeeds: true },
    });
    api.on('POST /api/engines/ninfer/build-plan', () => next);
    api.on('POST /api/engines/ninfer/build', () => ({ ok: true }));
    renderLib('/engines', api);
    const all = await allRow();
    await userEvent.click(within(all).getByRole('button', { name: 'Scarica e compila' }));
    expect(await within(all).findByText('Cosa manca')).toBeTruthy();
    expect(within(all).getByText('Serve 13.1 o più recente')).toBeTruthy();
    expect(within(all).getByText(/NInfer-all ha bisogno di CUDA 13.1 o più nuovo per la RTX 5090: con il CUDA che c’è \(13.0\)/)).toBeTruthy();
    expect(within(all).getByRole('region', { name: 'Comando da copiare' }).textContent).toContain('sudo apt install cuda-toolkit-13-3');
    expect(within(all).getByText(/cuda-toolkit-13-3 è il CUDA più recente che apt offre/)).toBeTruthy();
    expect(api.calls.find((x) => x.path === '/api/engines/ninfer/build-plan')?.body).toEqual({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', build: 'all' });
    expect(api.calls.some((x) => x.path === '/api/engines/ninfer/build')).toBe(false);
    // CUDA installed: "Ricontrolla" checks again and builds at once.
    next = plan({ dir: '/home/u/ninfer-all', existing: true, ready: true });
    await userEvent.click(within(all).getByRole('button', { name: 'Ricontrolla' }));
    await waitFor(() => expect(api.calls.find((x) => x.path === '/api/engines/ninfer/build')?.body).toEqual({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', build: 'all', dir: '/home/u/ninfer-all', confirm: true }));
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-all', label: 'NInfer-all', stage: 'configure', bytesDone: 0 }));
    expect(await within(all).findByText('Compilazione in corso…')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-all', label: 'NInfer-all', stage: 'done', bytesDone: 0, result: { customEngineId: 'ninfer-all' } }));
    expect(await screen.findByText('NInfer-all è pronto.')).toBeTruthy();
  });

  it('NVIDIA\'s repository when apt has no CUDA new enough; another repository or other files in the folder', async () => {
    const api = ninferApi();
    let next = plan({ ready: false, prereqs: [{ id: 'cuda', found: false, need: '12.8', packages: ['cuda-toolkit-12-8'] }], cudaFromNvidia: true, cuda: { need: '12.8' } });
    api.on('POST /api/engines/ninfer/build-plan', () => next);
    renderLib('/engines', api);
    const off = await official();
    await userEvent.click(within(off).getByRole('button', { name: 'Scarica e compila' }));
    expect(await within(off).findByText(/Serve CUDA 12.8 o più nuovo, dal repository di NVIDIA/)).toBeTruthy();
    next = plan({ ready: false, prereqs: [], cudaFromNvidia: true, otherRepo: 'https://github.com/someone/else.git' });
    await userEvent.click(within(off).getByRole('button', { name: 'Ricontrolla' }));
    expect(await within(off).findByText(/In questa cartella c’è un altro repository \(https:\/\/github.com\/someone\/else.git\)/)).toBeTruthy();
    expect(within(off).getByText(/Serve CUDA 13.1 o più nuovo/)).toBeTruthy();
    next = plan({ ready: false, prereqs: [], notEmpty: true, dir: '/home/u/stuff' });
    await userEvent.click(within(off).getByRole('button', { name: 'Ricontrolla' }));
    expect(await within(off).findByText('In /home/u/stuff ci sono già altri file: scegli un’altra cartella in Avanzate.')).toBeTruthy();
  });

  it('a check that fails, and a build that stops: what it said, its last lines, its whole log', async () => {
    const b = bridge();
    const api = ninferApi();
    let broken = true;
    api.on('POST /api/engines/ninfer/build-plan', () => (broken ? fail('INTERNAL', 500, 'no answer') : plan()));
    api.on('POST /api/engines/ninfer/build', () => ({ ok: true }));
    renderLib('/engines', api);
    const off = await official();
    await userEvent.click(within(off).getByRole('button', { name: 'Scarica e compila' }));
    expect((await within(off).findAllByText(/imprevisto|no answer/)).length).toBeGreaterThan(0);
    broken = false;
    await userEvent.click(within(off).getByRole('button', { name: 'Scarica e compila' }));
    await waitFor(() => expect(api.calls.some((x) => x.path === '/api/engines/ninfer/build')).toBe(true));
    const error = { code: 'ENGINE_INSTALL_FAILED' as const, message: 'NInfer configure failed', detail: 'CMake Error at CMakeLists.txt:36 (message):\n  A 120a build needs CUDA 13.1 or newer', params: { reason: 'ninfer_build', stage: 'configure', reading: 'cuda-too-old', need: '13.1', log: 'C:\\data\\logs\\ninfer-build.log' } };
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-wsl', stage: 'error', bytesDone: 0, error }));
    expect(await within(off).findByText('CUDA è troppo vecchio per questa versione')).toBeTruthy();
    expect(within(off).getByText(/Il compilatore CUDA dentro Ubuntu-24.04 è troppo vecchio/)).toBeTruthy();
    expect(within(off).getByText(/A 120a build needs CUDA 13.1/)).toBeTruthy();
    await userEvent.click(within(off).getByRole('button', { name: 'Mostra il log completo' }));
    expect(b.revealPath).toHaveBeenCalledWith('C:\\data\\logs\\ninfer-build.log');
    // A failure without a known reading: its stage and its last lines (open); a cancel; one with nothing to show.
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-wsl', stage: 'error', bytesDone: 0, error: { code: 'ENGINE_INSTALL_FAILED', message: 'x', detail: 'boom', params: { stage: 'build' } } }));
    expect(await within(off).findByText('La compilazione si è fermata (Compilazione)')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-wsl', stage: 'error', bytesDone: 0, error: { code: 'ENGINE_INSTALL_FAILED', message: 'x', detail: 'boom' } }));
    expect(await within(off).findByText('La compilazione si è fermata (Compilazione)')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-wsl', stage: 'error', bytesDone: 0, error: { code: 'CANCELLED', message: 'Build cancelled' } }));
    expect(await within(off).findByText('Compilazione annullata: la versione di prima è rimasta com’era.')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-wsl', stage: 'error', bytesDone: 0, error: { code: 'ENGINE_INSTALL_FAILED', message: 'Prerequisites are missing', params: { reason: 'ninfer_prereqs' } } }));
    expect(await within(off).findByText('Installazione del motore non riuscita')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-wsl', stage: 'error', bytesDone: 0 }));
    expect(await within(off).findByText('Installazione del motore non riuscita')).toBeTruthy();
  });

  it('a build that answers and is current: its commit, "Hai l\'ultima versione", "Controlla aggiornamenti", its models to upgrade', async () => {
    const api = ninferApi({ builds: [ready(), ninferBuild({ build: 'all' })] });
    api.w.updates['ninfer-wsl'] = update({ state: 'current', commits: undefined, log: undefined, ninfer: { containerVersion: 3, artifacts: [{ id: 'b', name: 'qwen3_6_27b', file: '/m/b.ninfer', version: 2, needs: 3 }] } });
    renderLib('/engines', api);
    const c = await card();
    expect((await within(c).findAllByText('Pronto')).length).toBe(2);
    const off = await official();
    expect(within(off).getByText(COMMIT)).toBeTruthy();
    expect(within(off).getByText('/home/u/ninfer · Ubuntu-24.04')).toBeTruthy();
    expect(await within(off).findByText('Hai l’ultima versione (e31bc99)')).toBeTruthy();
    expect(within(off).getByText('qwen3_6_27b: formato v2')).toBeTruthy();
    await userEvent.click(within(off).getByRole('button', { name: 'Controlla aggiornamenti' }));
    await waitFor(() => expect(api.calls.some((x) => x.path === '/api/engines/ninfer-wsl/update?fetch=1')).toBe(true));
    // No primary action: nothing to do.
    expect(within(off).queryByRole('button', { name: 'Aggiorna' })).toBeNull();
    expect(within(off).queryByRole('button', { name: 'Ricompila' })).toBeNull();
    // "Ricontrolla": both builds probed again.
    await userEvent.click(within(c).getByRole('button', { name: 'Ricontrolla' }));
    await waitFor(() => expect(api.calls.some((x) => x.path === '/api/engines/ninfer/builds?fresh=1')).toBe(true));
  });

  it('new commits: "Aggiorna" pulls and rebuilds in one click, with progress, "Annulla" and what happened', async () => {
    const api = ninferApi({ builds: [ready(), readyAll()] });
    api.w.updates['ninfer-wsl'] = update();
    api.w.updates['custom:ninfer-all'] = update({ target: 'custom:ninfer-all', state: 'current', current: 'a1b2c3d', commits: undefined, log: undefined });
    renderLib('/engines', api);
    const off = await official();
    expect(await within(off).findByText('1 commit nuovo: e31bc99 → 4f2a9c1')).toBeTruthy();
    await userEvent.click(within(off).getByRole('button', { name: 'Aggiorna' }));
    await waitFor(() => expect(api.calls.some((x) => x.method === 'POST' && x.path === '/api/engines/ninfer-wsl/update')).toBe(true));
    act(() => api.emit({ type: 'engine.install', kind: 'update:ninfer-wsl', label: 'NInfer (WSL)', stage: 'git-pull', bytesDone: 0 }));
    expect(await within(off).findByText('Aggiornamento in corso…')).toBeTruthy();
    await userEvent.click(within(off).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(api.calls.some((x) => x.path === '/api/engines/ninfer-wsl/update/cancel')).toBe(true));
    act(() =>
      api.emit({
        type: 'engine.install',
        kind: 'update:ninfer-wsl',
        stage: 'error',
        bytesDone: 0,
        error: { code: 'ENGINE_UPDATE_FAILED', message: 'x', detail: 'error: Your local changes', params: { reason: 'git', stage: 'git-pull', reading: 'local-changes' } },
      }),
    );
    expect(await within(off).findByText('Nella cartella ci sono modifiche fatte a mano')).toBeTruthy();
    // NInfer-all is updated as its saved engine.
    const all = await allRow();
    expect(await within(all).findByText('Hai l’ultima versione (a1b2c3d)')).toBeTruthy();
    expect(api.calls.some((x) => x.path === '/api/engines/custom/ninfer-all/update')).toBe(true);
  });

  it('a program older than its code: "Da ricompilare" and "Ricompila" in place; not built yet; not working', async () => {
    const api = ninferApi({
      builds: [
        ready({ state: 'stale', built: '1234567' }),
        readyAll({ state: 'not-built', status: ok({ available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'ninfer_not_found' } }) }),
      ],
    });
    api.w.updates['ninfer-wsl'] = update({ state: 'available', stale: true, commits: 0, log: undefined, current: COMMIT, latest: COMMIT });
    api.on('POST /api/engines/ninfer/build-plan', () => plan({ existing: true }));
    api.on('POST /api/engines/ninfer/build', () => ({ ok: true }));
    renderLib('/engines', api);
    const off = await official();
    expect(within(off).getByText('Da ricompilare')).toBeTruthy();
    expect(within(off).getByText('Il codice è più nuovo della build: ricompila per usarlo.')).toBeTruthy();
    expect(within(off).getByText('e31bc99 (il programma è del 1234567)')).toBeTruthy();
    // Said once: the update check's own "ricompila" line is not repeated.
    expect(await within(off).findByRole('button', { name: 'Controlla aggiornamenti' })).toBeTruthy();
    expect(within(off).queryByText('Il codice è più nuovo della build: ricompila')).toBeNull();
    await userEvent.click(within(off).getByRole('button', { name: 'Ricompila' }));
    await waitFor(() => expect(api.calls.find((x) => x.path === '/api/engines/ninfer/build-plan')?.body).toEqual({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', dir: '/home/u/ninfer' }));
    const all = await allRow();
    expect(within(all).getByText('Da compilare')).toBeTruthy();
    expect(within(all).getByText(/Il codice \(commit a1b2c3d\) è nella cartella ma il programma no/)).toBeTruthy();
    expect(within(all).getByRole('button', { name: 'Ricompila' })).toBeTruthy();
  });

  it('older than its code and new commits too: "Aggiorna" pulls and builds in one go', async () => {
    const api = ninferApi({ builds: [ready(), readyAll({ state: 'stale', built: '1234567' })] });
    api.w.updates['ninfer-wsl'] = update({ state: 'current', commits: undefined, log: undefined });
    api.w.updates['custom:ninfer-all'] = update({ target: 'custom:ninfer-all', current: 'a1b2c3d', latest: 'b2c3d4e', stale: true, commits: 2, log: undefined });
    renderLib('/engines', api);
    const all = await allRow();
    expect(await within(all).findByText('2 commit nuovi: a1b2c3d → b2c3d4e')).toBeTruthy();
    expect(within(all).getByRole('button', { name: 'Aggiorna' })).toBeTruthy();
    expect(within(all).queryByRole('button', { name: 'Ricompila' })).toBeNull();
  });

  it('not working: why, then "Ricompila" in its checkout, or "Scarica e compila" when there is none', async () => {
    const api = ninferApi({
      builds: [
        ready({ state: 'broken', status: ok({ available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'distro_missing', distro: 'Ubuntu-24.04' } }) }),
        readyAll({ state: 'broken', commit: undefined, status: ok({ available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'ninfer_not_found', path: '/opt/x' } }) }),
      ],
    });
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('Non trovato')).toBeTruthy();
    const off = await official();
    expect(within(off).getByText('Non funziona')).toBeTruthy();
    expect(within(off).getByText('La distribuzione Ubuntu-24.04 non c’è')).toBeTruthy();
    expect(within(off).getByRole('button', { name: 'Ricompila' })).toBeTruthy();
    const all = await allRow();
    expect(within(all).getByText('ninfer-serve non è qui: /opt/x')).toBeTruthy();
    expect(within(all).getByRole('button', { name: 'Scarica e compila' })).toBeTruthy();
  });

  it('the GPU is not an RTX 5090: said on the card; without WSL: how to get it', async () => {
    const api = ninferApi({ builds: [ready({ status: ok({ available: false, problems: ['ENGINE_GPU_UNSUPPORTED'], problemParams: { engine: 'NInfer', gpu: 'RTX 5090' } }) }), ninferBuild({ build: 'all' })] });
    api.on('GET /api/engines/ninfer/distros', () => ({ wsl: false, distros: [] }));
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('Serve una RTX 5090')).toBeTruthy();
    expect(within(c).getByText('NInfer funziona solo con una RTX 5090.')).toBeTruthy();
    expect(await within(c).findByText('WSL non è pronto')).toBeTruthy();
  });

  it('"Cambia cartella": a build of the user\'s own, saved when it answers; else why', async () => {
    const api = ninferApi({ builds: [ready(), ninferBuild({ build: 'all' })] });
    let answer: unknown = { saved: false, status: ok({ available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'ninfer_not_found', path: '/opt/x/build/apps/ninfer-serve' } }) };
    api.on('PUT /api/engines/ninfer/builds/*', () => (answer instanceof Error ? Promise.reject(answer) : answer));
    renderLib('/engines', api);
    const off = await official();
    await userEvent.click(within(off).getByRole('button', { name: 'Cambia cartella' }));
    const field = within(off).getByRole('textbox', { name: 'Dove si trova NInfer' });
    expect(field).toHaveProperty('value', '/home/u/ninfer/build/apps/ninfer-serve');
    await userEvent.clear(field);
    expect((within(off).getByRole('button', { name: 'Controlla e usa' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(field, '/opt/x');
    await userEvent.click(within(off).getByRole('button', { name: 'Controlla e usa' }));
    expect(await within(off).findByText('ninfer-serve non è qui: /opt/x/build/apps/ninfer-serve')).toBeTruthy();
    expect(api.calls.find((x) => x.path === '/api/engines/ninfer/builds/official')?.body).toEqual({ path: '/opt/x', distro: 'Ubuntu-24.04' });
    answer = new Error('boom');
    await userEvent.click(within(off).getByRole('button', { name: 'Controlla e usa' }));
    expect((await within(off).findAllByText(/imprevisto|boom/)).length).toBeGreaterThan(0);
    answer = { saved: true, status: ok() };
    await userEvent.click(within(off).getByRole('button', { name: 'Controlla e usa' }));
    expect(await screen.findByText('NInfer (ufficiale) trovato: lo uso da ora in poi.')).toBeTruthy();
    await waitFor(() => expect(within(off).queryByRole('textbox', { name: 'Dove si trova NInfer' })).toBeNull());
  });

  it('on Linux: no distro anywhere; "Avanzate": another folder, and the exact commands', async () => {
    const api = ninferApi({ system: linux, kind: 'ninfer-native', builds: [ninferBuild({ kind: 'ninfer-native', distro: undefined }), ninferBuild({ build: 'all', kind: 'ninfer-native', distro: undefined })] });
    api.on('POST /api/engines/ninfer/build-plan', () => plan({ kind: 'ninfer-native', distro: undefined, ready: false, prereqs: [] }));
    renderLib('/engines', api);
    const off = await official();
    expect(within(off).getByText('~/ninfer su questo PC (la crea la compilazione)')).toBeTruthy();
    await userEvent.click(within(off).getByText('Avanzate'));
    await userEvent.type(within(off).getByRole('textbox', { name: 'Cartella' }), '~/src/ninfer');
    await userEvent.click(within(off).getByRole('button', { name: 'Mostra i comandi' }));
    expect(await within(off).findByRole('region', { name: 'Comandi che eseguirò' })).toBeTruthy();
    expect(api.calls.find((x) => x.path === '/api/engines/ninfer/build-plan')?.body).toEqual({ kind: 'ninfer-native', dir: '~/src/ninfer' });
    expect(within(off).getByText(/Eseguo esattamente questi comandi su questo PC/)).toBeTruthy();
  });

  it('opened for a model that needs NInfer-all: that build drawn out, with the model named', async () => {
    renderLib('/engines?ninfer=all&modelName=Qwen3.8-27B-Coder390-Q6_K', ninferApi());
    const all = await allRow();
    expect(await within(all).findByText('Serve per Qwen3.8-27B-Coder390-Q6_K.')).toBeTruthy();
  });

  it('a Linux build of the user\'s own: no distro; "Cambia cartella" while it checks, and why it was not taken in the catalog\'s words', async () => {
    const native = ok({ kind: 'ninfer-native' });
    const api = ninferApi({ system: linux, kind: 'ninfer-native', builds: [ready({ kind: 'ninfer-native', distro: undefined, status: native }), ninferBuild({ build: 'all', kind: 'ninfer-native', distro: undefined })] });
    let answer: (v: unknown) => void = () => undefined;
    api.on('PUT /api/engines/ninfer/builds/*', () => new Promise((r) => (answer = r)));
    renderLib('/engines', api);
    const off = await official();
    expect(within(off).getByText('/home/u/ninfer')).toBeTruthy();
    await userEvent.click(within(off).getByRole('button', { name: 'Cambia cartella' }));
    await userEvent.click(within(off).getByRole('button', { name: 'Controlla e usa' }));
    expect(await within(off).findByRole('button', { name: 'Controllo…' })).toBeTruthy();
    expect(api.calls.find((x) => x.path === '/api/engines/ninfer/builds/official')?.body).toEqual({ path: '/home/u/ninfer/build/apps/ninfer-serve' });
    // Not taken, for a reason of no words of its own: the catalog's.
    act(() => answer({ saved: false, status: ok({ kind: 'ninfer-native', available: false, installed: false, problems: [] }) }));
    expect(await within(off).findByText('Il motore non è installato')).toBeTruthy();
    api.on('PUT /api/engines/ninfer/builds/*', () => ({ saved: false, status: ok({ kind: 'ninfer-native', available: false, installed: false, problems: ['ENGINE_GPU_UNSUPPORTED'], problemParams: { engine: 'NInfer', gpu: 'RTX 5090' } }) }));
    await userEvent.click(within(off).getByRole('button', { name: 'Controlla e usa' }));
    expect(await within(off).findByText(/RTX 5090/)).toBeTruthy();
  });

  it("NInfer-all's program says its version; checks while they run; an update's \"Annulla\" that fails changes nothing; a model to upgrade with its command", async () => {
    bridge();
    const api = ninferApi({ builds: [ready(), readyAll({ release: '0.12.0-rtx3090+v0.6.0-rtx3090-1704-ge7b7e669' })] });
    api.w.updates['ninfer-wsl'] = update({ state: 'current', commits: undefined, log: undefined, ninfer: { containerVersion: 3, artifacts: [{ id: 'b', name: 'qwen3_6_27b', file: '/m/b.ninfer', version: 2, needs: 3, command: 'python3 tools/upgrade_ninfer_v2_to_v3.py /m/b.ninfer /m/b-v3.ninfer' }] } });
    api.w.updates['custom:ninfer-all'] = update({ target: 'custom:ninfer-all', current: 'a1b2c3d', latest: 'b2c3d4e', commits: 2, log: undefined });
    renderLib('/engines', api);
    const all = await allRow();
    expect(within(all).getByText('Programma')).toBeTruthy();
    expect(within(all).getByText('0.12.0-rtx3090+v0.6.0-rtx3090-1704-ge7b7e669')).toBeTruthy();
    const off = await official();
    // Its models to upgrade: NInfer's own command, and its guide.
    expect((await within(off).findByRole('region', { name: 'Comando da copiare' })).textContent).toContain('python3 tools/upgrade_ninfer_v2_to_v3.py');
    await userEvent.click(within(off).getByRole('button', { name: 'Come si aggiorna un modello' }));
    expect((window as unknown as { gpubench: { openExternal: ReturnType<typeof vi.fn> } }).gpubench.openExternal).toHaveBeenCalled();
    // A check that runs: said on its button; the card's "Ricontrolla" too.
    api.on('GET /api/engines/ninfer-wsl/update', (_b, q) => (q.get('fetch') === '1' ? new Promise(() => undefined) : api.w.updates['ninfer-wsl']));
    await userEvent.click(within(off).getByRole('button', { name: 'Controlla aggiornamenti' }));
    expect(await within(off).findByRole('button', { name: 'Controllo…' })).toBeTruthy();
    api.on('GET /api/engines/ninfer/builds', (_b, q) => (q.get('fresh') === '1' ? new Promise(() => undefined) : api.w.ninferBuilds));
    const c = await card();
    await userEvent.click(within(c).getByRole('button', { name: 'Ricontrolla' }));
    expect((await within(c).findAllByRole('button', { name: 'Controllo…' })).length).toBeGreaterThan(1);
    // NInfer-all's update, stopped with a cancel that does not get through: nothing else happens.
    api.on('POST /api/engines/custom/ninfer-all/update/cancel', () => Promise.reject(new Error('gone')));
    await userEvent.click(await within(all).findByRole('button', { name: 'Aggiorna' }));
    act(() => api.emit({ type: 'engine.install', kind: 'update:custom:ninfer-all', label: 'NInfer-all', stage: 'build', bytesDone: 0, step: 1, steps: 811 }));
    await userEvent.click(await within(all).findByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(api.calls.some((x) => x.path === '/api/engines/custom/ninfer-all/update/cancel')).toBe(true));
    expect(within(all).getByText('Aggiornamento in corso…')).toBeTruthy();
  });

  it('WSL without a distro yet: where a build goes is not known ("–"); what a plan misses besides CUDA', async () => {
    const api = ninferApi({ builds: [ninferBuild({ distro: undefined }), ninferBuild({ build: 'all', distro: undefined })] });
    api.on('GET /api/engines/ninfer/distros', () => ({ wsl: true, distros: [] }));
    renderLib('/engines', api);
    const off = await official();
    expect(await within(off).findByText('~/ninfer dentro – (la crea la compilazione)')).toBeTruthy();
  });

  it('what a plan misses besides CUDA: Ninja, and no CUDA at all (no older one to explain)', async () => {
    const ok2 = ninferApi({ builds: [ninferBuild(), ninferBuild({ build: 'all' })] });
    ok2.on('POST /api/engines/ninfer/build-plan', () =>
      plan({
        ready: false,
        prereqs: [
          { id: 'ninja', found: false, packages: ['ninja-build'] },
          { id: 'cuda', found: false, need: '13.1', packages: ['cuda-toolkit-13-3'] },
        ],
        aptCommand: 'sudo apt install ninja-build cuda-toolkit-13-3',
        cuda: { need: '13.1', package: 'cuda-toolkit-13-3', allNeeds: true },
      }),
    );
    renderLib('/engines', ok2);
    const all = await allRow();
    await userEvent.click(within(all).getByRole('button', { name: 'Scarica e compila' }));
    expect(await within(all).findByText('Manca')).toBeTruthy();
    expect(within(all).getByText('Serve 13.1 o più recente')).toBeTruthy();
    expect(within(all).queryByText(/compilerebbe male/)).toBeNull();
  });

  it('the old link of the NInfer-all template lands there too (it is no longer a custom engine to add)', async () => {
    renderLib('/engines?customTemplate=ninfer-all&modelName=Other', ninferApi());
    expect(await screen.findByText('Serve per Other.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
