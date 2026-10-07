import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { launchParamsSchema, type LaunchParams } from '../../../../src/contract/engines';
import type { LatencyPoint, RunResult, TuneCombination } from '../../../../src/contract/results';
import { defaultDepth, depthChoices, pointAt, sourceFor } from '../../../../src/renderer/components/configs/depths';
import { UnitHeader } from '../../../../src/renderer/components/configs/unit-header';
import { presetOf } from '../../../../src/renderer/components/bench/rerun';
import { scenarioLines } from '../../../../src/renderer/components/bench/summary';
import { provenanceText, shortDate, tokensShort } from '../../../../src/renderer/components/presets/format';
import { createFormatters } from '../../../../src/renderer/i18n';
import { configsSearch } from '../../../../src/renderer/lib/queries-configs';
import { renderApp } from '../helpers';
import { IDS, seeded, seededRuns } from '../bench/fixtures';
import { benchApi, curatedModel, localModel } from '../bench/world';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

const it_ = createFormatters('it');
const P = (over: Partial<LaunchParams> = {}): LaunchParams => launchParamsSchema.parse(over);
const posted = (api: ReturnType<typeof benchApi>, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);
const TUNE_ID = '01K6ZT2B3C4D5E6F7G8H9J0KMN';

function point(depth: number, decode: number): LatencyPoint {
  const p = seeded(IDS.full).metrics.latency[0]!;
  return { ...p, promptTokens: depth, decodeTps: { ...p.decodeTps, median: decode } };
}

function combo(params: Partial<LaunchParams>, maxContext: number, sweep: LatencyPoint[], tags: TuneCombination['tags'] = []): TuneCombination {
  const argv = ['C:\\Users\\utente\\AppData\\Roaming\\GPU Bench\\engines\\llamacpp\\b11438-cuda-13.4\\llama-server.exe', '-m', 'x.gguf', '-c', String(maxContext)];
  return { params: P(params), kvType: params.kvCacheType === 'q8_0' ? 'q8_0' : 'f16', maxContext, vramPeakMiB: 30000, sweep, command: { argv, powershell: argv.join(' '), bash: argv.join(' ') }, outcome: 'ok', tags };
}

/** "Trova le impostazioni migliori" on the seeded Qwen3 8B: a q8_0 combination up to 64K (recommended) and an f16 one. */
function tuneRun(): RunResult {
  const full = seeded(IDS.full);
  return {
    ...full,
    id: TUNE_ID,
    scenario: { profile: 'tune', seed: 42, steps: [] },
    metrics: { ...full.metrics, latency: [], contextSweep: [], concurrency: [] },
    tuning: {
      budget: 'fast',
      maxLaunches: 20,
      dimensions: [],
      capacity: [],
      depths: [1024, 32768],
      attempts: [],
      combinations: [
        combo({ contextSize: 65536, kvCacheType: 'q8_0', flashAttention: 'on' }, 65536, [point(1024, 210), point(32624, 82)], ['draft']),
        combo({ contextSize: 32768 }, 32768, [point(1024, 220)]),
      ],
      recommended: 0,
      fastestByDepth: [],
    },
  };
}

function api(runs: RunResult[] = [...seededRuns(), tuneRun()]) {
  return benchApi({ runs, local: [localModel('qwen3-8b', { weakKey: seeded(IDS.full).model.weakKey })] });
}

describe('result page header: the configuration and its preset', () => {
  it('a tune run: its recommended combination, as words and as a preset', async () => {
    const a = api();
    const { router } = renderApp(`/results/${TUNE_ID}`, a);
    expect(await screen.findByText(/^· Contesto 65\.536 · cache KV q8_0 · flash attention · decodifica speculativa$/)).toBeTruthy();
    // The header's actions come first (every row of the tune ranking has its own too).
    await userEvent.click((await screen.findAllByRole('button', { name: 'Avvia il server così' }))[0]!);
    expect(await screen.findByRole('dialog', { name: 'Avvia il server' })).toBeTruthy();
    expect(posted(a, '/api/servers/plan')[0]!.body).toMatchObject({ engine: { kind: 'llamacpp-native' }, model: { localId: 'qwen3-8b' }, params: { contextSize: 65536, kvCacheType: 'q8_0' } });
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Avvia il server' })).getByRole('button', { name: 'Annulla' }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Usa questo preset' })[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    const banner = await screen.findByRole('region', { name: 'Preset' });
    expect(within(banner).getByText('Preset da «Qwen3 8B · Q4_K_M · combinazione 1» del 06/10: 82 tok/s a 32K, 64K di contesto')).toBeTruthy();
    // A tune run's preset starts from the Quick test, with the combination's settings.
    expect(screen.getByRole('radio', { name: /Rapido/ }).getAttribute('aria-checked')).toBe('true');
    expect(((await screen.findByLabelText('Contesto (token)')) as HTMLInputElement).value).toBe('65536');
    await userEvent.click(within(banner).getByRole('link', { name: 'Apri il test' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/results/${TUNE_ID}`));
  });

  it('a normal run: header actions only for a completed test; external servers have no server to start', async () => {
    const quick = seeded(IDS.quick);
    const ext: RunResult = {
      ...quick,
      id: '01K6ZE2B3C4D5E6F7G8H9J0KMN',
      engine: { kind: 'external', name: 'llama.cpp server', variant: 'llamacpp' },
      model: { ...quick.model, displayName: 'demo', source: 'external', format: 'remote' },
      launch: { ...quick.launch, argv: [], params: P() },
    };
    renderApp(`/results/${ext.id}`, api([ext, seeded(IDS.failed)]));
    expect(await screen.findByRole('button', { name: 'Usa questo preset' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Avvia il server così' })).toBeNull();
  });

  it('a failed run has no preset in the header', async () => {
    renderApp(`/results/${IDS.failed}`, api([seeded(IDS.failed)]));
    expect(await screen.findByRole('heading', { level: 1, name: /Llama 3.3 70B/ })).toBeTruthy();
    expect(screen.getByText(/llama\.cpp b11402 \(CUDA 13\.4\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Usa questo preset' })).toBeNull();
  });

  it('a model to download first, or nowhere to find', async () => {
    const full = seeded(IDS.full);
    const hub: RunResult = { ...full, model: { ...full.model, source: 'hf', repo: 'Qwen/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf', sha256: undefined, weakKey: 'gone', path: undefined } };
    const { unmount } = renderApp(`/results/${IDS.full}`, api([hub]));
    expect(await screen.findByText('Il modello non è più sul PC: lo scarico prima (4,7 GB).')).toBeTruthy();
    unmount();
    const unsized: RunResult = { ...hub, model: { ...hub.model, sizeBytes: undefined } };
    const second = renderApp(`/results/${IDS.full}`, api([unsized]));
    expect(await screen.findByText('Il modello non è più sul PC: lo scarico prima.')).toBeTruthy();
    second.unmount();
    renderApp(`/results/${IDS.quick}`, api([seeded(IDS.quick)]));
    expect(await screen.findByRole('button', { name: 'Trova il modello' })).toBeTruthy();
    expect(screen.getByText(/non so da dove riscaricarlo/)).toBeTruthy();
  });
});

describe('Configurazioni with tune combinations', () => {
  it('one row per combination; its preset uses that combination', async () => {
    const a = api();
    const { router } = renderApp('/results?view=configs', a);
    await screen.findByRole('table', { name: 'Configurazioni provate' });
    const trigger = screen.getByRole('combobox', { name: 'Confronta a' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: '1K token' }));
    const row = screen.getAllByRole('row').find((r) => r.textContent?.includes('65.536'))!;
    expect(within(row).getByText('cache KV q8_0 · flash attention · decodifica speculativa')).toBeTruthy();
    expect(within(row).getByText('210,0')).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Mostra il test di Qwen3 8B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Test di questa configurazione' });
    expect(within(dialog).getByText('Trova le impostazioni migliori · combinazione 1')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chiudi' }));
    await userEvent.click(await within(row).findByRole('button', { name: 'Usa questo preset' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByText('Preset da «Qwen3 8B · Q4_K_M · combinazione 1» del 06/10: 210 tok/s a 1K, 64K di contesto')).toBeTruthy();
  });
});

describe('Benchmark page with a preset', () => {
  it('a model to download that is also a suggestion is that suggestion; another engine family gets nothing extra', async () => {
    const full = seeded(IDS.full);
    const sugg = curatedModel('qwen3-8b-gguf', { repo: 'Qwen/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf', label: 'Qwen3 8B · Q4_K_M' });
    const hub: RunResult = { ...full, model: { ...full.model, source: 'hf', repo: 'Qwen/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf', sha256: undefined, weakKey: 'gone', path: undefined } };
    const q8 = curatedModel('qwen3-8b-q8', { repo: 'Qwen/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q8_0.gguf', label: 'Qwen3 8B · Q8_0', quant: 'Q8_0' });
    // Another quant of the same repo is on the PC: not the preset's model.
    const a = benchApi({ runs: [hub], local: [localModel('q6', { repo: 'Qwen/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q6_K.gguf' })], curated: [q8, sugg] });
    const { router } = renderApp(`/results/${IDS.full}`, a);
    await userEvent.click(await screen.findByRole('button', { name: 'Usa questo preset' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByRole('button', { name: /^Cambia modello: Qwen3 8B Q4_K_M/ })).toBeTruthy();
    expect(screen.getByText('Consigliato per la tua scheda')).toBeTruthy();
    expect(screen.queryByText('Dal preset')).toBeNull();
    // vLLM lists safetensors models: the GGUF of the preset is not one of them.
    const trigger = screen.getByRole('combobox', { name: 'Cambia motore' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: /vLLM \(Docker\)/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Cambia modello: Qwen3 8B/ })).toBeNull());
  });

  it('a vLLM repo that is neither on the PC nor a suggestion becomes a choice to download', async () => {
    const vllm = seeded(IDS.vllm);
    const run: RunResult = { ...vllm, model: { ...vllm.model, repo: 'org/Rare-Model', displayName: 'Rare-Model', quant: undefined, sizeBytes: undefined, facts: undefined } };
    // Another file of the same repo is on the PC: not the same model.
    const a = benchApi({ runs: [run], local: [localModel('other', { format: 'safetensors', repo: 'org/Other' }), localModel('same-repo', { repo: 'org/Rare-Model', file: 'other.gguf' })] });
    const { router } = renderApp(`/results/${IDS.vllm}`, a);
    await userEvent.click(await screen.findByRole('button', { name: 'Usa questo preset' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByRole('button', { name: /^Cambia modello: Rare-Model$/ })).toBeTruthy();
    expect(screen.getByText('Dal preset')).toBeTruthy();
    await waitFor(() => expect(posted(a, '/api/runs/plan').at(-1)?.body).toMatchObject({ engine: { kind: 'vllm-docker' }, model: { repo: 'org/Rare-Model', revision: 'main' } }));
  });
});

describe('preset logic', () => {
  it('a run, or one of its combinations (ignored when the run has none)', () => {
    const lib = [localModel('m', { weakKey: seeded(IDS.full).model.weakKey })];
    const normal = presetOf(seeded(IDS.full), lib, undefined, { combo: 0 });
    expect(normal.params).toEqual(seeded(IDS.full).launch.params);
    expect(normal.provenance).toEqual({ runId: IDS.full, label: 'Qwen3 8B · Q4_K_M', date: seeded(IDS.full).createdAt, decodeTps: 183.45, depth: 512, contextSize: 8192 });
    expect(presetOf(seeded(IDS.full), lib, undefined, { at: 99 }).provenance).not.toHaveProperty('decodeTps');
    const tune = tuneRun();
    const second = presetOf(tune, lib, undefined, { combo: 1 });
    expect(second.params.contextSize).toBe(32768);
    expect(second.provenance).toMatchObject({ combo: 1, depth: 1024, decodeTps: 220, contextSize: 32768 });
    expect(second.serve.params).toEqual(second.params);
    expect(second.draft.profile).toBe('quick');
    // A tune run without a combination: its own launch, still from the Quick test; a combination that does not exist: the run.
    expect(presetOf(tune, lib, undefined).draft.profile).toBe('quick');
    expect(presetOf(tune, lib, undefined, { combo: 7 }).provenance).not.toHaveProperty('combo');
    // Sweeps only (no prompt lengths): the first measured point.
    const sweptOnly = { ...seeded(IDS.full), metrics: { ...seeded(IDS.full).metrics, latency: [], contextSweep: [point(4096, 150)] } };
    expect(presetOf(sweptOnly, lib, undefined).provenance).toMatchObject({ depth: 4096, decodeTps: 150 });
    // vLLM: the library copy of the repo, else a download.
    const vllm = seeded(IDS.vllm);
    expect(presetOf(vllm, [], undefined)).toMatchObject({ model: 'download', draft: { hub: { repo: 'Qwen/Qwen3-8B-FP8', revision: 'main', name: 'Qwen3-8B-FP8' } } });
    expect(presetOf(vllm, [localModel('st', { format: 'safetensors', repo: 'Qwen/Qwen3-8B-FP8' })], undefined).model).toBe('local');
    const noFacts = { ...vllm, model: { ...vllm.model, quant: undefined, sizeBytes: undefined, facts: undefined, revision: undefined } };
    expect(presetOf(noFacts, [], undefined).draft.hub).toEqual({ repo: 'Qwen/Qwen3-8B-FP8', revision: 'main', name: 'Qwen3-8B-FP8' });
  });

  it('formats depths, dates and the banner sentence', () => {
    expect(tokensShort(512, it_)).toBe('512');
    expect(tokensShort(32768, it_)).toBe('32K');
    expect(tokensShort(4864, it_)).toBe('4,8K');
    expect(shortDate('2026-10-07T09:00:00.000Z', 'it-IT')).toBe('07/10');
    const base = { runId: 'r', label: 'Qwen3 8B', date: '2026-10-07T09:00:00.000Z' };
    expect(provenanceText(base, it_)).toBe('Preset da «Qwen3 8B» del 07/10');
    expect(provenanceText({ ...base, decodeTps: 81.6, depth: 32768, contextSize: 65536 }, it_)).toBe('Preset da «Qwen3 8B» del 07/10: 82 tok/s a 32K, 64K di contesto');
    expect(provenanceText({ ...base, combo: 2, decodeTps: 80 }, it_)).toBe('Preset da «Qwen3 8B · combinazione 3» del 07/10');
  });

  it('chooses the depths to compare at, and the test a preset quotes', () => {
    const e = (...depths: number[]) => ({ points: depths.map((depth) => ({ depth, n: 1, decodeTps: 1 })) });
    expect(depthChoices([e(512, 4096), e(512, 1024), e(4096)])).toEqual([512, 4096]);
    expect(depthChoices([e(1024, 32768)])).toEqual([1024, 32768]);
    expect(depthChoices([])).toEqual([]);
    expect(defaultDepth([e(512, 4096), e(512, 4096)], [512, 4096])).toBe(512);
    expect(defaultDepth([e(512, 4096), e(4096)], [512, 4096])).toBe(4096);
    expect(defaultDepth([], [])).toBeUndefined();
    expect(pointAt(e(512), undefined)).toBeUndefined();
    expect(pointAt(e(512), 512)).toEqual({ depth: 512, n: 1, decodeTps: 1 });
    const s = (runId: string, depths: number[]) => ({ runId, date: '2026-10-07T09:00:00.000Z', profile: 'quick' as const, points: depths.map((depth) => ({ depth, decodeTps: 1 })) });
    expect(sourceFor({ sources: [s('a', [512]), s('b', [4096])] }, 4096).runId).toBe('b');
    expect(sourceFor({ sources: [s('a', [512]), s('b', [4096])] }, 8192).runId).toBe('a');
  });

  it('builds the configs query and splits a header from its unit', () => {
    expect(configsSearch({})).toBe('');
    expect(configsSearch({ gpu: undefined, engine: 'vllm-docker' })).toBe('?engine=vllm-docker');
    expect(scenarioLines({ profile: 'tune', seed: 42, steps: [{ kind: 'context-sweep', depths: [], fractions: false, outputTokens: 128, reps: 2 }] }, it_)).toEqual(['velocità con il contesto sempre più pieno']);
    expect(configsSearch({ gpu: 'all', minContext: 32768 })).toBe('?gpu=all&minContext=32768');
    const { container, unmount } = render(<UnitHeader text="Generazione (tok/s)" />);
    expect(container.textContent).toBe('Generazione(tok/s)');
    unmount();
    expect(render(<UnitHeader text="Modello" />).container.textContent).toBe('Modello');
  });
});
