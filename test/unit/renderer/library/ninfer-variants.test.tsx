/**
 * Other variants of NInfer on the Engines page ("Motori personalizzati", an advanced route: NInfer-all
 * is NInfer's own second build, on its card): a fork downloaded and built by LLM Bench from its
 * repository and saved by itself; one of the user's own, pointed at; a saved variant not built yet,
 * compiled in place; its build's progress.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customEngineSchema, type CustomEngine } from '../../../../src/contract/custom-engines';
import type { NinferBuildPlan } from '../../../../src/contract/ninfer';
import { installLabel } from '../../../../src/renderer/components/library/downloads-panel';
import { variantDir } from '../../../../src/renderer/components/engines/ninfer-variant';
import { repoText } from '../../../../src/renderer/components/engines/ninfer-build-dialog';
import { buildEstimate } from '../../../../src/renderer/components/engines/ninfer-guided';
import { customEngineWhere } from '../../../../src/renderer/components/engines/custom-engine-check';
import { createFormatters } from '../../../../src/renderer/i18n';
import { bridge, customCheck, customInfo, libApi, patchPointer, renderLib, system, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeEach(() => patchPointer());
afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const ALL = { url: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master' };
const FUSION = { url: 'https://github.com/someone/ninfer-fusion-kvmem.git', branch: 'main' };
const linux = system({ os: { platform: 'linux', release: '6', arch: 'x64', name: 'Ubuntu 24.04', isWsl: false } });
const engine = (o: Partial<CustomEngine> & Pick<CustomEngine, 'id' | 'name' | 'base' | 'run'>): CustomEngine => customEngineSchema.parse(o);

const plan = (over: Partial<NinferBuildPlan> = {}): NinferBuildPlan => ({
  kind: 'ninfer-wsl',
  distro: 'Ubuntu-24.04',
  dir: '/home/u/fusion-kv',
  servePath: '/home/u/fusion-kv/build/apps/ninfer-serve',
  existing: false,
  source: FUSION,
  commands: ['git clone --progress --branch main https://github.com/someone/ninfer-fusion-kvmem.git /home/u/fusion-kv', 'cmake --build /home/u/fusion-kv/build -j'],
  prereqs: [{ id: 'git', found: true, version: '2.43.0', packages: ['git'] }],
  cudaFromNvidia: false,
  downloadBytes: 39_367 * 1024,
  cpus: 16,
  minutes: 10,
  ready: true,
  ...over,
});

function variantApi(o: { w?: ReturnType<typeof world> } = {}) {
  const api = libApi(o.w ?? world());
  api.on('GET /api/engines/ninfer/distros', () => ({ wsl: true, distros: [{ name: 'Ubuntu-24.04', default: true, version: 2 }, { name: 'Debian', default: false, version: 2 }] }));
  api.on('POST /api/engines/ninfer/build-plan', () => plan());
  api.on('POST /api/engines/ninfer/build', () => ({ ok: true }));
  return api;
}

/** "Aggiungi motore" → "Variante di NInfer" → its "where" step. */
async function newVariant() {
  await userEvent.click(await screen.findByRole('button', { name: 'Aggiungi motore' }));
  const dialog = await screen.findByRole('dialog', { name: 'Aggiungi un motore' });
  await userEvent.click(within(dialog).getByRole('radio', { name: /Variante di NInfer/ }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
  return dialog;
}

describe('a variant of NInfer (advanced)', () => {
  it('a fork: downloaded from its repository, built in its own folder inside the distro, then saved by the core', async () => {
    bridge();
    const api = variantApi();
    renderLib('/engines', api);
    // NInfer-all is not one of these: it is built on NInfer's own card.
    expect(screen.queryByRole('button', { name: /NInfer-all \(modelli GGUF-NInfer\)/ })).toBeNull();
    const dialog = await newVariant();
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Fusion KV');
    expect((within(dialog).getByLabelText('Dove si trova, come lo vede Linux') as HTMLInputElement).placeholder).toBe('~/fusion-kv');
    // A repository that is not one: said, and nothing to build from.
    const repo = within(dialog).getByLabelText('Repository git');
    expect((within(dialog).getByRole('button', { name: 'Scarica e compila Fusion KV' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(repo, 'git@github.com:x/y.git');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    expect(within(dialog).getByText(/Serve un indirizzo https di un repository git/)).toBeTruthy();
    await userEvent.clear(repo);
    await userEvent.type(repo, FUSION.url);
    await userEvent.type(within(dialog).getByLabelText('Ramo'), 'main');
    expect(await within(dialog).findByText(/LLM Bench lo scarica da github\.com\/someone\/ninfer-fusion-kvmem e lo compila dentro Ubuntu-24\.04/)).toBeTruthy();
    // Another distro.
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Distribuzione WSL' }));
    await userEvent.click(await screen.findByRole('option', { name: /Debian/ }));

    // A path that names the program, not its checkout: the build goes to its own folder.
    await userEvent.type(within(dialog).getByLabelText('Dove si trova, come lo vede Linux'), '/opt/bin/ninfer-serve');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scarica e compila Fusion KV' }));
    const build = await screen.findByRole('dialog', { name: 'Scarica e compila Fusion KV' });
    expect(within(build).getByText('Da: github.com/someone/ninfer-fusion-kvmem (ramo main)')).toBeTruthy();
    expect(await within(build).findByText('Da scaricare: circa 38,4 MB.')).toBeTruthy();
    await waitFor(() =>
      expect(api.calls.find((c) => c.path === '/api/engines/ninfer/build-plan')?.body).toEqual({
        kind: 'ninfer-wsl',
        dir: '~/fusion-kv',
        distro: 'Debian',
        source: FUSION,
        variant: { name: 'Fusion KV' },
      }),
    );
    await userEvent.click(within(build).getByRole('button', { name: 'Scarica e compila' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/engines/ninfer/build')?.body).toMatchObject({ dir: '/home/u/fusion-kv', confirm: true, variant: { name: 'Fusion KV' } }));
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-variant', label: 'Fusion KV', stage: 'build', bytesDone: 2, step: 2, steps: 4 }));
    expect(await within(build).findByRole('progressbar', { name: 'Compilazione di Fusion KV' })).toBeTruthy();
    // "Annulla" stops the build inside the distro.
    await userEvent.click(within(build).getAllByRole('button', { name: 'Annulla' })[0] as HTMLElement);
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/engines/ninfer/build/cancel')).toBe(true));
    act(() =>
      api.emit({ type: 'engine.install', kind: 'ninfer-variant', label: 'Fusion KV', stage: 'done', bytesDone: 0, result: { ninferPath: '/home/u/fusion-kv/build/apps/ninfer-serve', distro: 'Debian', customEngineId: 'fusion-kv' } }),
    );
    expect(await screen.findByText('Fusion KV è pronto: /home/u/fusion-kv/build/apps/ninfer-serve')).toBeTruthy();
    expect(await screen.findByText('Fusion KV è pronto: lo trovi tra i motori personalizzati.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('one of the user\'s own: the kind "Variante di NInfer", its path checked ("Prova": the KV types it knows), then saved', async () => {
    bridge();
    const w = world();
    w.customCheck = () =>
      customCheck({ kind: 'ninfer-wsl', status: { kind: 'ninfer-wsl', available: true, installed: true, version: 'a1b2c3d4e5f6', problems: [], supported: true }, flagCount: 40, missing: [], kvDtypes: ['bf16', 'int8', 'rk8v4'] });
    const api = variantApi({ w });
    renderLib('/engines', api);
    const dialog = await newVariant();
    // No name yet: the button says NInfer; no repository: nothing to download.
    expect((within(dialog).getByRole('button', { name: 'Scarica e compila NInfer' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Fusion KV');
    await userEvent.type(within(dialog).getByLabelText('Dove si trova, come lo vede Linux'), '/home/u/fusion');
    await userEvent.type(within(dialog).getByLabelText('Ramo'), '-x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Prova' }));
    await userEvent.clear(within(dialog).getByLabelText('Ramo'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Prova' }));
    expect(await within(dialog).findByText('Cache KV che conosce: bf16, int8, rk8v4')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva motore' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/engines/custom')?.body).toMatchObject({
      name: 'Fusion KV',
      base: 'ninfer',
      run: { mode: 'ninfer', path: '/home/u/fusion', distro: 'Ubuntu-24.04' },
    });
  });

  it('a saved variant: where it is, a checkout not built yet compiled in place, its build\'s progress on the page; NInfer-all is not listed here', async () => {
    bridge();
    const fusion = engine({ id: 'fusion', name: 'Fusion', base: 'ninfer', run: { mode: 'ninfer', path: '/home/u/fusion', distro: 'Ubuntu-24.04', source: FUSION } });
    const all = engine({ id: 'ninfer-all', name: 'NInfer-all', base: 'ninfer', template: 'ninfer-all', run: { mode: 'ninfer', path: '/home/u/ninfer-all', distro: 'Ubuntu-24.04', source: ALL } });
    const w = world({ settings: { ...world().settings, customEngines: [all, fusion] } });
    const notBuilt = customCheck({
      kind: 'ninfer-wsl',
      status: { kind: 'ninfer-wsl', available: false, installed: false, version: 'a1b2c3d4e5f6', problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'ninfer_not_found', path: '/home/u/fusion/build/apps/ninfer-serve' }, supported: true },
      flagCount: 0,
      missing: [],
    });
    w.custom = [customInfo(all, notBuilt), customInfo(fusion, notBuilt)];
    const api = variantApi({ w });
    api.on('POST /api/engines/ninfer/build-plan', () => plan({ existing: true, commands: ['cmake --build /home/u/fusion/build -j'] }));
    renderLib('/engines', api);
    const c = await screen.findByRole('region', { name: 'Fusion' });
    expect(screen.queryByRole('region', { name: 'NInfer-all' })).toBeNull();
    expect(within(c).getByText('/home/u/fusion · Ubuntu-24.04')).toBeTruthy();
    expect(within(c).getByText('NInfer c’è ma non è ancora compilato')).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Compila' }));
    const build = await screen.findByRole('dialog', { name: 'Compila Fusion' });
    await waitFor(() =>
      expect(api.calls.find((x) => x.path === '/api/engines/ninfer/build-plan')?.body).toEqual({
        kind: 'ninfer-wsl',
        dir: '/home/u/fusion',
        distro: 'Ubuntu-24.04',
        source: FUSION,
        variant: { name: 'Fusion', id: 'fusion' },
      }),
    );
    expect(within(build).getByText('Niente da scaricare: compilo la copia che c’è già.')).toBeTruthy();
    await userEvent.click(within(build).getByRole('button', { name: 'Annulla' }));
    // Edited: "Scarica e compila" from its dialog updates this very engine.
    await userEvent.click(within(c).getByRole('button', { name: 'Modifica' }));
    const edit = await screen.findByRole('dialog', { name: 'Modifica Fusion' });
    await userEvent.click(within(edit).getByRole('button', { name: 'Scarica e compila Fusion' }));
    await screen.findByRole('dialog', { name: 'Compila Fusion' });
    await waitFor(() => expect(api.calls.filter((x) => x.path === '/api/engines/ninfer/build-plan').at(-1)?.body).toMatchObject({ dir: '/home/u/fusion', variant: { id: 'fusion' } }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Compila Fusion' })).getByRole('button', { name: 'Annulla' }));
    await userEvent.click(within(edit).getByRole('button', { name: 'Chiudi' }));
    // A build under way (its dialog closed): the page says so.
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-variant', label: 'Fusion', stage: 'configure', bytesDone: 0 }));
    expect(await screen.findByRole('progressbar', { name: 'Compilazione di Fusion in corso' })).toBeTruthy();
    // Without its name: NInfer.
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-variant', stage: 'build', bytesDone: 0 }));
    expect(await screen.findByRole('progressbar', { name: 'Compilazione di NInfer in corso' })).toBeTruthy();
  });

  it('a variant of the user\'s own, not built yet: compiled in place, from its own repository', async () => {
    bridge();
    const mine = engine({ id: 'fusion', name: 'Fusion', base: 'ninfer', run: { mode: 'ninfer', path: '/home/u/fusion', distro: 'Ubuntu-24.04', source: { url: 'https://gitlab.com/me/fusion.git' } } });
    const w = world({ settings: { ...world().settings, customEngines: [mine] } });
    w.custom = [
      customInfo(
        mine,
        customCheck({
          kind: 'ninfer-wsl',
          status: { kind: 'ninfer-wsl', available: false, installed: false, version: 'a1b2c3d4e5f6', problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'ninfer_not_found' }, supported: true },
          flagCount: 0,
          missing: [],
        }),
      ),
    ];
    const api = variantApi({ w });
    renderLib('/engines', api);
    await userEvent.click(within(await screen.findByRole('region', { name: 'Fusion' })).getByRole('button', { name: 'Compila' }));
    const build = await screen.findByRole('dialog');
    expect(within(build).getByText('Da: gitlab.com/me/fusion')).toBeTruthy();
    await waitFor(() => expect(api.calls.find((x) => x.path === '/api/engines/ninfer/build-plan')?.body).toMatchObject({ dir: '/home/u/fusion', source: { url: 'https://gitlab.com/me/fusion.git' }, variant: { name: 'Fusion', id: 'fusion' } }));
    expect(customEngineWhere({ run: { mode: 'ninfer', path: '/opt/fusion' } })).toBe('/opt/fusion');
  });

  it('a variant without a repository, built in its own checkout: no source to show', async () => {
    bridge();
    const mine = engine({ id: 'local', name: 'Local', base: 'ninfer', run: { mode: 'ninfer', path: '/home/u/local', distro: 'Ubuntu-24.04' } });
    const w = world({ settings: { ...world().settings, customEngines: [mine] } });
    w.custom = [
      customInfo(
        mine,
        customCheck({
          kind: 'ninfer-wsl',
          status: { kind: 'ninfer-wsl', available: false, installed: false, version: 'a1b2c3d4e5f6', problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'ninfer_not_found' }, supported: true },
          flagCount: 0,
          missing: [],
        }),
      ),
    ];
    const api = variantApi({ w });
    api.on('POST /api/engines/ninfer/build-plan', () => plan({ existing: true, source: { url: 'https://github.com/Neroued/ninfer.git' } }));
    renderLib('/engines', api);
    await userEvent.click(within(await screen.findByRole('region', { name: 'Local' })).getByRole('button', { name: 'Compila' }));
    const build = await screen.findByRole('dialog', { name: 'Compila Local' });
    expect(within(build).getByText(/LLM Bench scarica NInfer da GitHub e lo compila dentro Ubuntu-24.04/)).toBeTruthy();
    expect(within(build).queryByText(/^Da: /)).toBeNull();
  });

  it('on Linux it runs on this PC: no distro to choose', async () => {
    bridge();
    const api = variantApi({ w: world({ system: linux }) });
    api.on('POST /api/engines/ninfer/build-plan', () => plan({ kind: 'ninfer-native', distro: undefined }));
    renderLib('/engines', api);
    const dialog = await newVariant();
    await userEvent.type(within(dialog).getByLabelText('Repository git'), FUSION.url);
    expect(await within(dialog).findByText(/e lo compila su questo PC/)).toBeTruthy();
    expect(within(dialog).queryByRole('combobox', { name: 'Distribuzione WSL' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scarica e compila NInfer' }));
    const build = await screen.findByRole('dialog', { name: 'Scarica e compila NInfer' });
    expect(within(build).getByText(/e lo compila su questo PC/)).toBeTruthy();
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/engines/ninfer/build-plan')?.body).toEqual({ kind: 'ninfer-native', dir: '~/ninfer', source: { url: FUSION.url }, variant: { name: 'NInfer' } }));
  });

  it('WSL distros not read yet, or not readable: a placeholder, then no distro to pick', async () => {
    bridge();
    const api = variantApi();
    let answer: (v: unknown) => void = () => undefined;
    api.on('GET /api/engines/ninfer/distros', () => new Promise((resolve) => (answer = resolve)));
    renderLib('/engines', api);
    const dialog = await newVariant();
    expect(within(dialog).queryByRole('combobox', { name: 'Distribuzione WSL' })).toBeNull();
    expect(within(dialog).getByText(/e lo compila dentro –/)).toBeTruthy();
    act(() => answer({ wsl: true, distros: [] }));
    expect(await within(dialog).findByRole('combobox', { name: 'Distribuzione WSL' })).toBeTruthy();
  });

  it('WSL distros that cannot be read: nothing to pick, the build waits for a distro', async () => {
    bridge();
    const api = variantApi();
    api.on('GET /api/engines/ninfer/distros', () => {
      throw new Error('wsl.exe did not answer');
    });
    renderLib('/engines', api);
    const dialog = await newVariant();
    await userEvent.type(within(dialog).getByLabelText('Repository git'), FUSION.url);
    expect((await within(dialog).findByRole('combobox', { name: 'Distribuzione WSL' })).textContent).not.toContain('Ubuntu');
    expect((within(dialog).getByRole('button', { name: 'Scarica e compila NInfer' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("another copy of NInfer-all (an older setup) is listed here: built and edited with its template; the folder checked again, a plan that fails, a build that stops", async () => {
    bridge();
    const all = engine({ id: 'ninfer-all', name: 'NInfer-all', base: 'ninfer', template: 'ninfer-all', run: { mode: 'ninfer', path: '/home/u/ninfer-all', distro: 'Ubuntu-24.04', source: ALL } });
    const old = engine({ id: 'old-all', name: 'Old all', base: 'ninfer', template: 'ninfer-all', run: { mode: 'ninfer', path: '/home/u/old-all', distro: 'Ubuntu-24.04', source: ALL } });
    const w = world({ settings: { ...world().settings, customEngines: [all, old] } });
    const notBuilt = customCheck({
      kind: 'ninfer-wsl',
      status: { kind: 'ninfer-wsl', available: false, installed: false, version: 'a1b2c3d4e5f6', problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'ninfer_not_found' }, supported: true },
      flagCount: 0,
      missing: [],
    });
    w.custom = [customInfo(all, notBuilt), customInfo(old, notBuilt)];
    const api = variantApi({ w });
    api.on('POST /api/engines/ninfer/build-plan', () => plan({ existing: true, dir: '/home/u/old-all', source: ALL }));
    renderLib('/engines', api);
    const card = await screen.findByRole('region', { name: 'Old all' });
    await userEvent.click(within(card).getByRole('button', { name: 'Compila' }));
    const build = await screen.findByRole('dialog', { name: 'Compila Old all' });
    await waitFor(() => expect(api.calls.find((x) => x.path === '/api/engines/ninfer/build-plan')?.body).toMatchObject({ dir: '/home/u/old-all', variant: { name: 'Old all', id: 'old-all', template: 'ninfer-all' } }));
    // An empty folder is NInfer's usual one; a check that fails says why.
    const folder = within(build).getByRole('textbox', { name: 'Cartella' });
    await userEvent.clear(folder);
    api.on('POST /api/engines/ninfer/build-plan', () => {
      throw new Error('wsl.exe did not answer');
    });
    await userEvent.click(within(build).getByRole('button', { name: 'Controlla' }));
    await waitFor(() => expect(api.calls.filter((x) => x.path === '/api/engines/ninfer/build-plan').at(-1)?.body).toMatchObject({ dir: '~/ninfer' }));
    expect((await within(build).findAllByText(/imprevisto|wsl\.exe did not answer/)).length).toBeGreaterThan(0);
    api.on('POST /api/engines/ninfer/build-plan', () => plan({ existing: true, dir: '/home/u/old-all', source: ALL }));
    await userEvent.type(folder, '/home/u/old-all');
    await userEvent.click(within(build).getByRole('button', { name: 'Controlla' }));
    await userEvent.click(await within(build).findByRole('button', { name: 'Compila' }));
    await waitFor(() => expect(api.calls.some((x) => x.path === '/api/engines/ninfer/build')).toBe(true));
    // "Annulla" while it builds: a cancel that fails changes nothing.
    api.on('POST /api/engines/ninfer/build/cancel', () => {
      throw new Error('gone');
    });
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-variant', label: 'Old all', stage: 'build', bytesDone: 1, step: 1, steps: 4 }));
    await userEvent.click(within(await within(build).findByRole('progressbar', { name: 'Compilazione di Old all' }).then(() => build)).getAllByRole('button', { name: 'Annulla' })[0] as HTMLElement);
    await waitFor(() => expect(api.calls.some((x) => x.path === '/api/engines/ninfer/build/cancel')).toBe(true));
    // It stops: said (without an error of its own: the catalog's words); then its reading.
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-variant', label: 'Old all', stage: 'error', bytesDone: 0 }));
    expect(await within(build).findByText('Installazione del motore non riuscita')).toBeTruthy();
    act(() =>
      api.emit({ type: 'engine.install', kind: 'ninfer-variant', label: 'Old all', stage: 'error', bytesDone: 0, error: { code: 'ENGINE_INSTALL_FAILED', message: 'x', detail: 'No space left on device', params: { stage: 'build', reading: 'disk-full' } } }),
    );
    expect(await within(build).findByText('Il disco è pieno')).toBeTruthy();
    // Done without a path in its result: still said, and the dialog closes.
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-variant', label: 'Old all', stage: 'done', bytesDone: 0 }));
    expect((await screen.findAllByText(/^Old all è pronto/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Compila Old all' })).toBeNull());
    // Edited: its build keeps its template.
    await userEvent.click(within(card).getByRole('button', { name: 'Modifica' }));
    const edit = await screen.findByRole('dialog', { name: 'Modifica Old all' });
    await userEvent.click(within(edit).getByRole('button', { name: 'Scarica e compila Old all' }));
    await screen.findByRole('dialog', { name: 'Compila Old all' });
    await waitFor(() => expect(api.calls.filter((x) => x.path === '/api/engines/ninfer/build-plan').at(-1)?.body).toMatchObject({ variant: { id: 'old-all', template: 'ninfer-all' } }));
  });
});

describe('the words of a build', () => {
  it('repository, folder, estimate, progress label', () => {
    const f = createFormatters('it');
    expect(repoText(ALL.url)).toBe('github.com/iamwavecut/ninfer-all');
    expect(variantDir({ name: 'NInfer-all', templateId: 'ninfer-all' })).toBe('~/ninfer-all');
    expect(variantDir({ name: 'Mio Fork!', templateId: undefined })).toBe('~/mio-fork');
    expect(variantDir({ name: '***', templateId: undefined })).toBe('~/ninfer');
    expect(buildEstimate({ existing: false, minutes: 12 }, f)).toEqual(['Compilazione: circa 12 minuti.']);
    expect(installLabel(f.t, { type: 'engine.install', kind: 'ninfer-wsl', stage: 'build', bytesDone: 0 })).toBe('Compilazione di NInfer');
    expect(installLabel(f.t, { type: 'engine.install', kind: 'ninfer-all', stage: 'build', bytesDone: 0 })).toBe('Compilazione di NInfer-all');
    expect(installLabel(f.t, { type: 'engine.install', kind: 'ninfer-variant', stage: 'build', bytesDone: 0 })).toBe('Compilazione di NInfer');
    expect(installLabel(f.t, { type: 'engine.install', kind: 'ninfer-variant', label: 'NInfer-all', stage: 'build', bytesDone: 0 })).toBe('Compilazione di NInfer-all');
  });
});
