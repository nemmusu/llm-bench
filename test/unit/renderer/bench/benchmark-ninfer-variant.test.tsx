/**
 * A GGUF-NInfer artifact on the Benchmark page: with NInfer chosen, NInfer-all runs it by itself and the
 * page says so ("NInfer · versione NInfer-all"); not built yet, the page offers to build it, and "Avvia
 * benchmark" builds it first ("Questo modello funziona solo con NInfer-all"), then starts the test by
 * itself. NInfer-all starts from the model card's settings. The server flow does the same.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StartRunRequest, StartServerRequest } from '../../../../src/contract/api';
import { customEngineSchema } from '../../../../src/contract/custom-engines';
import type { NinferBuildInfo } from '../../../../src/contract/ninfer';
import type { RunResult } from '../../../../src/contract/results';
import { unreadableFor } from '../../../../src/renderer/components/engines/engine-suggestion';
import { needsNinferAll } from '../../../../src/renderer/components/bench/start-flow';
import { renderApp } from '../helpers';
import { IDS, seeded } from './fixtures';
import { apiError, benchApi, ENGINES, localModel, ninferPlanFor, planFor } from './world';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});
afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
});

const posted = (api: ReturnType<typeof benchApi>, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);
const lastPlan = (api: ReturnType<typeof benchApi>) => posted(api, '/api/runs/plan').at(-1)?.body as StartRunRequest | undefined;

const gguf = localModel('gguf', {
  format: 'ninfer',
  displayName: 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP',
  repo: 'nerkyor/Qwen3.8-27B-Coder390-GGUF-NInfer',
  file: 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP.ninfer',
  files: ['Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP.ninfer'],
  quant: 'Q6_K',
  // Its manifest (at the start of the file) lists GGUF blocks.
  facts: { components: ['text', 'mtp', 'vision'], layouts: ['contiguous_le_v1', 'gguf_blocks_v1', 'row_split_k128_v1'], paramsB: 27 },
});
const renamed = localModel('renamed', { format: 'ninfer', displayName: 'my-model', file: 'my-model.ninfer', files: ['my-model.ninfer'], quant: undefined, weakKey: 'local/my-model.ninfer' });
const ninferAll = customEngineSchema.parse({
  id: 'ninfer-all',
  name: 'NInfer-all',
  base: 'ninfer',
  template: 'ninfer-all',
  run: { mode: 'ninfer', path: '/home/u/ninfer-all', distro: 'Ubuntu-24.04', source: { url: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master' } },
  match: { names: ['GGUF-NInfer'], quants: [], layouts: ['gguf_blocks_v1'] },
});
const engines = [
  ...ENGINES,
  { kind: 'ninfer-wsl' as const, available: true, installed: true, version: 'e31bc99b13f5', variant: 'Ubuntu-24.04', location: '/home/u/ninfer/build/apps/ninfer-serve', problems: [], supported: true },
  { kind: 'ninfer-native' as const, available: false, installed: false, problems: [], supported: false },
];
const allBuild = (state: NinferBuildInfo['state']): NinferBuildInfo => ({
  build: 'all',
  kind: 'ninfer-wsl',
  state,
  source: { url: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master' },
  dir: '/home/u/ninfer-all',
  customEngineId: 'ninfer-all',
  kvDtypes: ['bf16', 'int8', 'rk8v4'],
});

async function chooseNinfer() {
  const trigger = await screen.findByRole('combobox', { name: 'Cambia motore' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  // NInfer itself (a variant of it is listed right under it).
  fireEvent.click((await screen.findAllByRole('option', { name: /^NInfer \(WSL\)/ })).find((o) => !/NInfer-all/.test(o.textContent ?? '')) as HTMLElement);
}

describe('a GGUF-NInfer artifact on the Benchmark page', () => {
  it('NInfer chosen, NInfer-all not built: said, its card\'s settings first; "Avvia benchmark" builds it, then starts by itself', async () => {
    const api = benchApi({ engines, local: [gguf] }, { onboardingDone: true, lastModelId: 'gguf' });
    let built = false;
    api.world.plan = () => planFor({ ninferBuild: { build: 'all', why: 'layout', layout: 'gguf_blocks_v1', ready: built, ...(built ? { customEngineId: 'ninfer-all' } : {}) } });
    renderApp('/', api);
    await chooseNinfer();
    expect(await screen.findByText('Serve NInfer-all: lo compilo prima del test')).toBeTruthy();
    expect(screen.getByText(/NInfer \(WSL\) · versione NInfer-all/)).toBeTruthy();
    const callout = (await screen.findByText('Questo modello funziona solo con NInfer-all')).closest('[role="note"]') as HTMLElement;
    expect(within(callout).getByText(/Il NInfer ufficiale non sa leggere i suoi pesi/)).toBeTruthy();
    // The model card's settings (NInfer-all has rk8v4) are the first choice.
    const settings = await screen.findByRole('radiogroup', { name: 'Impostazioni di NInfer' });
    expect(within(settings).getByRole('radio', { name: /Consigliata dalla scheda del modello: 100K per richiesta, KV rk8v4 condivisa, quanta ne entra, 4 utenti, MTP 3/ }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(lastPlan(api)).toMatchObject({ engine: { kind: 'ninfer-wsl' }, params: { contextSize: 102_400, parallel: 4, ninfer: { kvCapacity: 'auto', kvDtype: 'rk8v4', spec: 'mtp', draftTokens: 3 } } }));

    // "Scarica e compila NInfer-all" from the page: the same gate, in its own dialog.
    await userEvent.click(within(callout).getByRole('button', { name: 'Scarica e compila NInfer-all' }));
    const own = await screen.findByRole('dialog', { name: 'Questo modello funziona solo con NInfer-all' });
    await userEvent.click(within(own).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // "Avvia benchmark": NInfer-all first, then the test.
    await userEvent.click(screen.getByRole('button', { name: 'Avvia benchmark' }));
    const gate = await screen.findByRole('dialog', { name: 'Questo modello funziona solo con NInfer-all' });
    expect(await within(gate).findByText('Lo scarico (circa 38,4 MB) e lo compilo io dentro Ubuntu-24.04 (circa 10 min). Poi riparto da solo.')).toBeTruthy();
    expect(within(gate).getByText(/Il NInfer ufficiale non sa leggere i blocchi GGUF/)).toBeTruthy();
    expect(within(gate).getByText('Tutto quello che serve per compilarlo c’è.')).toBeTruthy();
    // "Avanzate": the repository and the exact commands, never fields to fill in.
    await userEvent.click(within(gate).getByText('Avanzate'));
    expect(within(gate).getByText('github.com/iamwavecut/ninfer-all (ramo master)')).toBeTruthy();
    expect(within(gate).getByRole('region', { name: 'Comandi che eseguirò' })).toBeTruthy();
    await userEvent.click(within(gate).getByRole('button', { name: 'Scarica e compila' }));
    await waitFor(() => expect(posted(api, '/api/engines/ninfer/build').at(-1)?.body).toEqual({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', build: 'all', dir: '/home/u/ninfer-all', confirm: true }));
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-all', stage: 'build', bytesDone: 12, step: 12, steps: 345 }));
    expect(await within(gate).findByText(/Se lasci aperta questa finestra, quando ha finito riparto da solo/)).toBeTruthy();
    expect(within(gate).getByRole('button', { name: 'Chiudi (la compilazione continua)' })).toBeTruthy();
    built = true;
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-all', stage: 'done', bytesDone: 0, result: { customEngineId: 'ninfer-all' } }));
    await waitFor(() => expect(posted(api, '/api/runs')).toHaveLength(1));
  });

  it('what is missing in the distro first: CUDA too old, the apt line, "Ricontrolla"; a check that fails; a build that stops', async () => {
    const api = benchApi({ engines, local: [gguf] }, { onboardingDone: true, lastModelId: 'gguf' });
    api.world.plan = () => planFor({ ninferBuild: { build: 'all', why: 'layout', layout: 'gguf_blocks_v1', ready: false } });
    api.world.ninferPlan = ninferPlanFor({
      ready: false,
      existing: true,
      prereqs: [{ id: 'cuda', found: false, version: '13.0', need: '13.1', packages: ['cuda-toolkit-13-3'] }],
      aptCommand: 'sudo apt install cuda-toolkit-13-3',
      cuda: { need: '13.1', have: '13.0', package: 'cuda-toolkit-13-3', allNeeds: true },
    });
    renderApp('/', api);
    await chooseNinfer();
    await userEvent.click(await screen.findByRole('button', { name: 'Avvia benchmark' }));
    const gate = await screen.findByRole('dialog', { name: 'Questo modello funziona solo con NInfer-all' });
    expect(await within(gate).findByText('Prima serve qualcosa dentro Ubuntu-24.04: ecco cosa manca e il comando da copiare. Poi premi Ricontrolla.')).toBeTruthy();
    expect(within(gate).getByRole('region', { name: 'Comando da copiare' }).textContent).toContain('sudo apt install cuda-toolkit-13-3');
    // A check that fails, then works: an existing copy, built in place.
    api.world.routes['POST /api/engines/ninfer/build-plan'] = () => {
      throw new Error('wsl does not answer');
    };
    await userEvent.click(within(gate).getByRole('button', { name: 'Ricontrolla' }));
    expect((await within(gate).findAllByText(/imprevisto|non risponde|wsl does not answer/)).length).toBeGreaterThan(0);
    delete api.world.routes['POST /api/engines/ninfer/build-plan'];
    api.world.ninferPlan = ninferPlanFor({ existing: true, downloadBytes: undefined });
    await userEvent.click(within(gate).getByRole('button', { name: 'Ricontrolla' }));
    expect(await within(gate).findByText('C’è già una copia: la compilo io dentro Ubuntu-24.04 (circa 10 min), senza riscaricarla. Poi riparto da solo.')).toBeTruthy();
    // Another folder (Avanzate) is checked as asked.
    await userEvent.click(within(gate).getByText('Avanzate'));
    await userEvent.type(within(gate).getByRole('textbox', { name: 'Cartella' }), '~/src/ninfer-all');
    await userEvent.click(within(gate).getByRole('button', { name: 'Controlla' }));
    await waitFor(() => expect(posted(api, '/api/engines/ninfer/build-plan').at(-1)?.body).toEqual({ kind: 'ninfer-wsl', distro: 'Ubuntu-24.04', build: 'all', dir: '~/src/ninfer-all' }));
    await userEvent.click(within(gate).getByRole('button', { name: 'Compila' }));
    await waitFor(() => expect(posted(api, '/api/engines/ninfer/build')).toHaveLength(1));
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-all', stage: 'error', bytesDone: 0, error: { code: 'ENGINE_INSTALL_FAILED', message: 'x', detail: 'c++: fatal error: Killed signal', params: { stage: 'build', reading: 'out-of-memory' } } }));
    expect(await within(gate).findByText('Il PC ha finito la memoria durante la compilazione')).toBeTruthy();
    await userEvent.click(within(gate).getByRole('button', { name: 'Riprova' }));
    await waitFor(() => expect(posted(api, '/api/engines/ninfer/build')).toHaveLength(2));
    // A start that finds NInfer-all gone after all: the same gate.
    expect(needsNinferAll(undefined, { code: 'ENGINE_NOT_INSTALLED', message: 'x', params: { reason: 'ninfer_all_missing' } })).toBe(true);
    expect(needsNinferAll(planFor({}), { code: 'ENGINE_NOT_INSTALLED', message: 'x' })).toBe(false);
  });

  it('a start that fails because NInfer-all went missing shows the gate too', async () => {
    const api = benchApi({ engines, local: [gguf] }, { onboardingDone: true, lastModelId: 'gguf' });
    api.world.ninferBuilds = { kind: 'ninfer-wsl', builds: [allBuild('ready')] };
    let starts = 0;
    api.world.routes['POST /api/runs'] = () => {
      starts += 1;
      if (starts === 1) throw apiError('ENGINE_NOT_INSTALLED', { reason: 'ninfer_all_missing', engine: 'NInfer-all' });
      return { runId: 'RUN-AFTER-BUILD' };
    };
    renderApp('/', api);
    await chooseNinfer();
    await userEvent.click(await screen.findByRole('button', { name: 'Avvia benchmark' }));
    const gate = await screen.findByRole('dialog', { name: 'Questo modello funziona solo con NInfer-all' });
    await userEvent.click(await within(gate).findByRole('button', { name: 'Scarica e compila' }));
    await waitFor(() => expect(posted(api, '/api/engines/ninfer/build')).toHaveLength(1));
    // Built: the same start again, by itself.
    act(() => api.emit({ type: 'engine.install', kind: 'ninfer-all', stage: 'done', bytesDone: 0, result: { customEngineId: 'ninfer-all' } }));
    await waitFor(() => expect(starts).toBe(2));
  });

  it('no WSL distro to build in: the gate says how to get one, with nothing to press', async () => {
    const api = benchApi({ engines, local: [gguf] }, { onboardingDone: true, lastModelId: 'gguf' });
    api.world.plan = () => planFor({ ninferBuild: { build: 'all', why: 'layout', layout: 'gguf_blocks_v1', ready: false } });
    api.world.routes['GET /api/engines/ninfer/distros'] = () => ({ wsl: true, distros: [] });
    renderApp('/', api);
    await chooseNinfer();
    await userEvent.click(await screen.findByRole('button', { name: 'Avvia benchmark' }));
    const gate = await screen.findByRole('dialog', { name: 'Questo modello funziona solo con NInfer-all' });
    await waitFor(() => expect(within(gate).queryByRole('button', { name: /Scarica e compila|Ricontrolla|Compila/ })).toBeNull());
    expect(await within(gate).findByText(/Su Windows NInfer gira dentro WSL 2/)).toBeTruthy();
    expect(within(gate).getByText(/Il NInfer ufficiale non sa leggere i blocchi GGUF/)).toBeTruthy();
    expect(posted(api, '/api/engines/ninfer/build-plan')).toHaveLength(0);
  });

  it('a model an earlier run could not read runs on NInfer-all too', async () => {
    const base = seeded(IDS.quick);
    const failed: RunResult = {
      ...base,
      id: 'FAILED-GGUF',
      status: 'failed',
      error: { code: 'ENGINE_MODEL_UNSUPPORTED', message: 'x', params: { engine: 'NInfer', reason: 'layout', value: 'gguf_blocks_v1' } },
      model: { ...base.model, format: 'ninfer', weakKey: renamed.identity.weakKey, sha256: undefined },
    };
    expect(unreadableFor(undefined, 'x')).toBeUndefined();
    renderApp('/', benchApi({ engines, local: [renamed], runs: [failed] }, { onboardingDone: true, lastModelId: 'renamed' }));
    await chooseNinfer();
    expect(await screen.findByText('Questo modello funziona solo con NInfer-all')).toBeTruthy();
  });

  it('NInfer-all built: NInfer runs it with NInfer-all, said in the engine card; nothing to add or choose', async () => {
    const api = benchApi({ engines, local: [gguf] }, { onboardingDone: true, lastModelId: 'gguf', customEngines: [ninferAll] });
    api.world.ninferBuilds = { kind: 'ninfer-wsl', builds: [allBuild('ready')] };
    renderApp('/', api);
    await chooseNinfer();
    expect(await screen.findByText('Versione NInfer-all (serve per questo modello)')).toBeTruthy();
    expect(screen.queryByText('Questo modello funziona solo con NInfer-all')).toBeNull();
    expect(screen.queryByText('Per questo modello c’è NInfer-all')).toBeNull();
    const settings = await screen.findByRole('radiogroup', { name: 'Impostazioni di NInfer' });
    expect(within(settings).getByRole('radio', { name: /Consigliata dalla scheda del modello/ }).getAttribute('aria-checked')).toBe('true');
    // Chosen on purpose, it is said the same way.
    const trigger = screen.getByRole('combobox', { name: 'Cambia motore' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: /NInfer-all/ }));
    await waitFor(() => expect(lastPlan(api)).toMatchObject({ engine: { kind: 'ninfer-wsl', customEngineId: 'ninfer-all' } }));
    expect(screen.getByText('Versione NInfer-all (serve per questo modello)')).toBeTruthy();
  });

  it('a build of NInfer-all without rk8v4: the model card\'s settings are not offered', async () => {
    const api = benchApi({ engines, local: [gguf] }, { onboardingDone: true, lastModelId: 'gguf' });
    api.world.ninferBuilds = { kind: 'ninfer-wsl', builds: [{ ...allBuild('stale'), kvDtypes: ['bf16', 'int8', 'fp8'] }] };
    renderApp('/', api);
    await chooseNinfer();
    // Once its build is known (its --help without rk8v4).
    await waitFor(() => expect(within(screen.getByRole('radiogroup', { name: 'Impostazioni di NInfer' })).queryByRole('radio', { name: /Consigliata dalla scheda del modello/ })).toBeNull());
    expect(within(screen.getByRole('radiogroup', { name: 'Impostazioni di NInfer' })).getByRole('radio', { name: /Consigliata da NInfer/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('"Avvia solo il server": NInfer-all chosen for the model by itself, with the card\'s settings', async () => {
    const api = benchApi({ engines, local: [gguf] }, { onboardingDone: true, customEngines: [ninferAll] });
    api.world.ninferBuilds = { kind: 'ninfer-wsl', builds: [allBuild('ready')] };
    api.world.custom = [{ engine: ninferAll, kind: 'ninfer-wsl', config: { kind: 'ninfer-wsl', customEngineId: 'ninfer-all' }, check: { kind: 'ninfer-wsl', status: { kind: 'ninfer-wsl', available: true, installed: true, problems: [], supported: true }, flagCount: 40, missing: [] } }];
    renderApp('/servers/new', api);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Motore' }).textContent).toContain('NInfer-all'));
    expect(await screen.findByText('Versione NInfer-all (serve per questo modello)')).toBeTruthy();
    await waitFor(() => expect((posted(api, '/api/servers/plan').at(-1)?.body as StartServerRequest | undefined)?.engine).toEqual({ kind: 'ninfer-wsl', customEngineId: 'ninfer-all' }));
    await userEvent.click(screen.getByRole('tab', { name: 'I tuoi preset' }));
    expect(screen.getByRole('radio', { name: /Consigliata dalla scheda del modello/ }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect((posted(api, '/api/servers/plan').at(-1)?.body as StartServerRequest).params?.ninfer).toMatchObject({ kvDtype: 'rk8v4', kvCapacity: 'auto' }));
  });

  it('"Avvia solo il server" without NInfer-all yet: said, with its build', async () => {
    const api = benchApi({ engines, local: [gguf] }, { onboardingDone: true });
    renderApp('/servers/new', api);
    expect(await screen.findByText('Userà la versione NInfer-all (serve per questo modello): la compilo prima di avviarlo.')).toBeTruthy();
    expect(screen.getByText('Questo modello funziona solo con NInfer-all')).toBeTruthy();
  });
});
