/**
 * NInfer variants on the Engines page: "Aggiungi NInfer-all" from its template (the deep link a failed run
 * or the Benchmark opens), downloaded and built by LLM Bench from its repository and saved by itself; one
 * of the user's own, pointed at; a saved variant not built yet, compiled in place; its build's progress.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customEngineSchema, type CustomEngine } from '../../../../src/contract/custom-engines';
import type { NinferBuildPlan } from '../../../../src/contract/ninfer';
import { installLabel } from '../../../../src/renderer/components/library/downloads-panel';
import { variantDir } from '../../../../src/renderer/components/engines/ninfer-variant';
import { buildEstimate, repoText } from '../../../../src/renderer/components/engines/ninfer-build-dialog';
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
const linux = system({ os: { platform: 'linux', release: '6', arch: 'x64', name: 'Ubuntu 24.04', isWsl: false } });
const engine = (o: Partial<CustomEngine> & Pick<CustomEngine, 'id' | 'name' | 'base' | 'run'>): CustomEngine => customEngineSchema.parse(o);

const plan = (over: Partial<NinferBuildPlan> = {}): NinferBuildPlan => ({
  kind: 'ninfer-wsl',
  distro: 'Ubuntu-24.04',
  dir: '/home/u/ninfer-all',
  servePath: '/home/u/ninfer-all/build/apps/ninfer-serve',
  existing: false,
  source: ALL,
  commands: ['git clone --progress --branch master https://github.com/iamwavecut/ninfer-all.git /home/u/ninfer-all', 'cmake --build /home/u/ninfer-all/build -j'],
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

describe('Aggiungi NInfer-all', () => {
  it('from its template: downloaded from its repository, built in its own folder inside the distro, then saved by the core', async () => {
    bridge();
    const api = variantApi();
    renderLib(`/engines?customTemplate=ninfer-all&model=nerkyor%2Fgguf&modelName=${encodeURIComponent('Qwen3.8-27B-Coder390 Q6_K')}`, api);
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi un motore' });
    expect(within(dialog).getByText('Serve per Qwen3.8-27B-Coder390 Q6_K')).toBeTruthy();
    expect((within(dialog).getByLabelText('Nome') as HTMLInputElement).value).toBe('NInfer-all');
    expect((within(dialog).getByLabelText('Repository git') as HTMLInputElement).value).toBe(ALL.url);
    expect((within(dialog).getByLabelText('Ramo') as HTMLInputElement).value).toBe('master');
    expect(await within(dialog).findByText(/LLM Bench lo scarica da github\.com\/iamwavecut\/ninfer-all e lo compila dentro Ubuntu-24\.04/)).toBeTruthy();
    expect((within(dialog).getByLabelText('Dove si trova, come lo vede Linux') as HTMLInputElement).placeholder).toBe('~/ninfer-all');

    // A repository that is not one: said, and nothing to build from.
    const repo = within(dialog).getByLabelText('Repository git');
    await userEvent.clear(repo);
    expect((within(dialog).getByRole('button', { name: 'Scarica e compila NInfer-all' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(repo, 'git@github.com:x/y.git');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    expect(within(dialog).getByText(/Serve un indirizzo https di un repository git/)).toBeTruthy();
    await userEvent.clear(repo);
    await userEvent.type(repo, ALL.url);
    // Another distro.
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Distribuzione WSL' }));
    await userEvent.click(await screen.findByRole('option', { name: /Debian/ }));

    // A path that names the program, not its checkout: the build goes to its own folder.
    await userEvent.type(within(dialog).getByLabelText('Dove si trova, come lo vede Linux'), '/opt/bin/ninfer-serve');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scarica e compila NInfer-all' }));
    const build = await screen.findByRole('dialog', { name: 'Scarica e compila NInfer-all' });
    expect(within(build).getByText('Da: github.com/iamwavecut/ninfer-all (ramo master)')).toBeTruthy();
    expect(await within(build).findByText('Da scaricare: circa 38,4 MB.')).toBeTruthy();
    await waitFor(() =>
      expect(api.calls.find((c) => c.path === '/api/engines/ninfer/build-plan')?.body).toEqual({
        kind: 'ninfer-wsl',
        dir: '~/ninfer-all',
        distro: 'Debian',
        source: ALL,
        variant: { name: 'NInfer-all', template: 'ninfer-all' },
      }),
    );
    await userEvent.click(within(build).getByRole('button', { name: 'Scarica e compila' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/engines/ninfer/build')?.body).toMatchObject({ dir: '/home/u/ninfer-all', confirm: true, variant: { template: 'ninfer-all' } }));
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-variant', label: 'NInfer-all', stage: 'build', bytesDone: 2, step: 2, steps: 4 }));
    expect(await within(build).findByRole('progressbar', { name: 'Compilazione di NInfer-all' })).toBeTruthy();
    act(() =>
      api.emit({ type: 'engine.install', kind: 'ninfer-variant', label: 'NInfer-all', stage: 'done', bytesDone: 0, result: { ninferPath: '/home/u/ninfer-all/build/apps/ninfer-serve', distro: 'Debian', customEngineId: 'ninfer-all' } }),
    );
    expect(await screen.findByText('NInfer-all è pronto: /home/u/ninfer-all/build/apps/ninfer-serve')).toBeTruthy();
    expect(await screen.findByText('NInfer-all è pronto: lo trovi tra i motori personalizzati.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('one of the user\'s own: the kind "Variante di NInfer", its path checked ("Prova": the KV types it knows), then saved', async () => {
    bridge();
    const w = world();
    w.customCheck = () =>
      customCheck({ kind: 'ninfer-wsl', status: { kind: 'ninfer-wsl', available: true, installed: true, version: 'a1b2c3d4e5f6', problems: [], supported: true }, flagCount: 40, missing: [], kvDtypes: ['bf16', 'int8', 'rk8v4'] });
    const api = variantApi({ w });
    renderLib('/engines', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Aggiungi motore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi un motore' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /Variante di NInfer/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    // No name yet: the button says NInfer; no repository: nothing to download.
    expect((within(dialog).getByRole('button', { name: 'Scarica e compila NInfer' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Fusion KV');
    expect((within(dialog).getByLabelText('Dove si trova, come lo vede Linux') as HTMLInputElement).placeholder).toBe('~/fusion-kv');
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

  it('a saved variant: where it is, a checkout not built yet compiled in place, its build\'s progress on the page', async () => {
    bridge();
    const all = engine({ id: 'ninfer-all', name: 'NInfer-all', base: 'ninfer', template: 'ninfer-all', run: { mode: 'ninfer', path: '/home/u/ninfer-all', distro: 'Ubuntu-24.04', source: ALL } });
    const w = world({ settings: { ...world().settings, customEngines: [all] } });
    w.custom = [
      customInfo(
        all,
        customCheck({
          kind: 'ninfer-wsl',
          status: { kind: 'ninfer-wsl', available: false, installed: false, version: 'a1b2c3d4e5f6', problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'ninfer_not_found', path: '/home/u/ninfer-all/build/apps/ninfer-serve' }, supported: true },
          flagCount: 0,
          missing: [],
        }),
      ),
    ];
    const api = variantApi({ w });
    api.on('POST /api/engines/ninfer/build-plan', () => plan({ existing: true, commands: ['cmake --build /home/u/ninfer-all/build -j'] }));
    renderLib('/engines', api);
    const c = await screen.findByRole('region', { name: 'NInfer-all' });
    expect(within(c).getByText('/home/u/ninfer-all · Ubuntu-24.04')).toBeTruthy();
    expect(within(c).getByText('NInfer c’è ma non è ancora compilato')).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Compila' }));
    const build = await screen.findByRole('dialog', { name: 'Compila NInfer-all' });
    await waitFor(() =>
      expect(api.calls.find((x) => x.path === '/api/engines/ninfer/build-plan')?.body).toEqual({
        kind: 'ninfer-wsl',
        dir: '/home/u/ninfer-all',
        distro: 'Ubuntu-24.04',
        source: ALL,
        variant: { name: 'NInfer-all', id: 'ninfer-all', template: 'ninfer-all' },
      }),
    );
    expect(within(build).getByText('Niente da scaricare: compilo la copia che c’è già.')).toBeTruthy();
    await userEvent.click(within(build).getByRole('button', { name: 'Annulla' }));
    // Edited: "Scarica e compila" from its dialog updates this very engine.
    await userEvent.click(within(c).getByRole('button', { name: 'Modifica' }));
    const edit = await screen.findByRole('dialog', { name: 'Modifica NInfer-all' });
    await userEvent.click(within(edit).getByRole('button', { name: 'Scarica e compila NInfer-all' }));
    await screen.findByRole('dialog', { name: 'Compila NInfer-all' });
    await waitFor(() => expect(api.calls.filter((x) => x.path === '/api/engines/ninfer/build-plan').at(-1)?.body).toMatchObject({ dir: '/home/u/ninfer-all', variant: { id: 'ninfer-all', template: 'ninfer-all' } }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Compila NInfer-all' })).getByRole('button', { name: 'Annulla' }));
    await userEvent.click(within(edit).getByRole('button', { name: 'Chiudi' }));
    // A build under way (its dialog closed): the page says so.
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-variant', label: 'NInfer-all', stage: 'configure', bytesDone: 0 }));
    expect(await screen.findByRole('progressbar', { name: 'Compilazione di NInfer-all in corso' })).toBeTruthy();
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

  it('on Linux it runs on this PC: no distro to choose', async () => {
    bridge();
    const api = variantApi({ w: world({ system: linux }) });
    renderLib('/engines?customTemplate=ninfer-all', api);
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi un motore' });
    expect(await within(dialog).findByText(/e lo compila su questo PC/)).toBeTruthy();
    expect(within(dialog).queryByRole('combobox', { name: 'Distribuzione WSL' })).toBeNull();
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
    expect(installLabel(f.t, { type: 'engine.install', kind: 'ninfer-variant', stage: 'build', bytesDone: 0 })).toBe('Compilazione di NInfer');
    expect(installLabel(f.t, { type: 'engine.install', kind: 'ninfer-variant', label: 'NInfer-all', stage: 'build', bytesDone: 0 })).toBe('Compilazione di NInfer-all');
  });
});
