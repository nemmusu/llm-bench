/** TensorRT-LLM's launch settings: the launch fields panel (Benchmark and "Avvia un server"), the form, the words of a result. */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { configParamsOf } from '../../../../src/contract/configs';
import { EMPTY_ENGINE_FORM, ENGINE_ORDER } from '../../../../src/renderer/components/bench/engine-form';
import { DEFAULT_SCENARIO_FORM, EMPTY_PARAMS_FORM, formFromParams, hasCustomParams, paramsFromForm, type ParamsForm } from '../../../../src/renderer/components/bench/expert-form';
import { ExpertPanel } from '../../../../src/renderer/components/bench/expert-panel';
import { kvShown, LaunchFields } from '../../../../src/renderer/components/bench/launch-fields-panel';
import { engineKindOfLabel } from '../../../../src/renderer/components/bench/live-now';
import { engineName } from '../../../../src/renderer/components/bench/load-progress';
import { formatNoteOf } from '../../../../src/renderer/components/bench/model-options';
import { guessNeeds } from '../../../../src/renderer/components/bench/needs';
import { configParts, launchSummaryParts } from '../../../../src/renderer/components/bench/summary';
import { paramText } from '../../../../src/renderer/components/compare/compare-diff';
import { reservesMemory } from '../../../../src/renderer/components/compare/compare-model';
import { engineChoices } from '../../../../src/renderer/components/servers/server-flow';
import { glossaryTerms } from '../../../../src/renderer/components/tune/tune-sections';
import { createFormatters } from '../../../../src/renderer/i18n';
import { fakeApi, renderUi } from '../helpers';
import { patchPointer } from '../library/fake';

patchPointer();

const GPU = { index: 0, uuid: 'g', name: 'RTX 5090', vendor: 'nvidia', memoryTotalMiB: 32607 };

/** A fake core whose /api/system lists `gpus` graphics cards. */
function apiWith(gpus: number) {
  const api = fakeApi();
  const get = api.get;
  api.get = vi.fn(async (p: string) => (p === '/api/system' ? { gpus: Array.from({ length: gpus }, (_, i) => ({ ...GPU, index: i })), os: { platform: 'win32' } } : get(p))) as typeof api.get;
  return api;
}

/** TensorRT-LLM's fields with their own form state, so typing shows up. */
function Harness({ start = EMPTY_PARAMS_FORM, use = 'test' as const, onChange }: { start?: ParamsForm; use?: 'test' | 'server'; onChange?: (f: ParamsForm) => void }) {
  const [form, setForm] = useState(start);
  const { invalid } = paramsFromForm(form, { base: 'trtllm' });
  return (
    <LaunchFields
      base="trtllm"
      form={form}
      invalid={invalid}
      use={use}
      onForm={(patch) => {
        const next = { ...form, ...patch };
        setForm(next);
        onChange?.(next);
      }}
    />
  );
}

describe('TensorRT-LLM fields', () => {
  it('plain labels with units, what empty means, each flag; a wrong value is said', async () => {
    let last: ParamsForm = EMPTY_PARAMS_FORM;
    renderUi(<Harness onChange={(f) => (last = f)} />, { withSettings: true, api: apiWith(1) });
    const ctx = screen.getByLabelText('Contesto per richiesta (token)');
    for (const flag of ['--max_seq_len', '--kv_cache_dtype', '--kv_cache_free_gpu_memory_fraction', '--max_batch_size', '--max_num_tokens']) expect(screen.getByText(flag)).toBeTruthy();
    expect((screen.getByLabelText('Memoria per la cache KV') as HTMLInputElement).placeholder).toBe('0,90');
    expect(screen.getByText(/La parte della memoria rimasta libera dopo il modello che va alla cache KV.*Vuoto: 0,90\./)).toBeTruthy();
    // One card: no tensor parallel; no YaRN either (trtllm-serve has no RoPE flag LLM Bench passes).
    expect(screen.queryByText('Schede video usate insieme')).toBeNull();
    expect(screen.queryByText(/YaRN/)).toBeNull();
    await userEvent.type(ctx, '32k');
    expect(ctx.getAttribute('aria-invalid')).toBe('true');
    await userEvent.clear(ctx);
    await userEvent.type(ctx, '32768');
    await userEvent.type(screen.getByLabelText('Memoria per la cache KV'), '2');
    expect(screen.getByLabelText('Memoria per la cache KV').getAttribute('aria-invalid')).toBe('true');
    await userEvent.type(screen.getByLabelText('Richieste contemporanee'), '8');
    await userEvent.type(screen.getByLabelText('Token per passo'), '8192');
    await userEvent.click(screen.getByRole('combobox', { name: 'Tipo di cache KV' }));
    await userEvent.click(await screen.findByRole('option', { name: 'nvfp4 (RTX 50, sperimentale)' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Codice del modello' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Sì' }));
    expect(last).toMatchObject({ maxModelLen: '32768', trtllmKvMemory: '2', parallel: '8', batchSize: '8192', kvCacheType: 'nvfp4', trtllmTrustRemoteCode: 'on' });
    expect(paramsFromForm(last, { base: 'trtllm' }).params.trtllm?.trustRemoteCode).toBe(true);
    expect(formFromParams({ trtllm: { trustRemoteCode: false }, extraArgs: [], env: {} }).trtllmTrustRemoteCode).toBe('off');
    // The words a beginner may not know have their "?".
    expect(screen.getByRole('button', { name: 'Che cos’è «Memoria per la cache KV»?' })).toBeTruthy();
  });

  it('several cards: how many split the model; a saved value this PC cannot offer stays visible', async () => {
    let last: ParamsForm = EMPTY_PARAMS_FORM;
    renderUi(<Harness use="server" start={{ ...EMPTY_PARAMS_FORM, trtllmTp: '8' }} onChange={(f) => (last = f)} />, { withSettings: true, api: apiWith(2) });
    const tp = await screen.findByRole('combobox', { name: 'Schede video usate insieme' });
    expect(tp.textContent).toContain('8 schede');
    expect(screen.getByRole('button', { name: 'Che cos’è «Tensor parallel»?' })).toBeTruthy();
    await userEvent.click(tp);
    expect(screen.getByRole('option', { name: '2 schede' })).toBeTruthy();
    await userEvent.click(screen.getByRole('option', { name: 'Una sola' }));
    expect(last.trtllmTp).toBe('');
    await userEvent.click(screen.getByRole('combobox', { name: 'Schede video usate insieme' }));
    await userEvent.click(await screen.findByRole('option', { name: '2 schede' }));
    expect(last.trtllmTp).toBe('2');
    expect(screen.getByText('--tp_size')).toBeTruthy();
  });

  it('one card but a saved value: the field shows so it can be cleared', async () => {
    renderUi(<Harness start={{ ...EMPTY_PARAMS_FORM, trtllmTp: '1' }} />, { withSettings: true, api: apiWith(1) });
    expect((await screen.findByRole('combobox', { name: 'Schede video usate insieme' })).textContent).toContain('Una sola');
  });

  it('the KV cache select reads nvfp4 as it is and any 8/4-bit choice as fp8', () => {
    expect(kvShown('trtllm', 'nvfp4')).toBe('nvfp4');
    expect(kvShown('trtllm', 'q8_0')).toBe('fp8');
    expect(kvShown('trtllm', 'auto')).toBe('default');
    expect(kvShown('vllm', 'nvfp4')).toBe('default');
  });

  it('the Benchmark’s advanced parameters: TensorRT-LLM’s fields, the image only in Docker', async () => {
    const onEngine = vi.fn();
    const props = {
      engineForm: EMPTY_ENGINE_FORM,
      engineInvalid: [],
      onEngine,
      params: { ...EMPTY_PARAMS_FORM, maxModelLen: '8192' },
      paramsInvalid: [],
      onParams: vi.fn(),
      custom: false,
      scenario: DEFAULT_SCENARIO_FORM,
      scenarioInvalid: [],
      onScenario: vi.fn(),
      defaultImage: 'nvcr.io/nvidia/tensorrt-llm/release:1.4.0rc0',
      recipe: { name: 'R', patch: { params: { maxModelLen: 4096, extraArgs: [], env: {} }, args: [], env: {} } as never },
    };
    const { rerender } = renderUi(<ExpertPanel engine="trtllm-docker" {...props} />, { withSettings: true, api: apiWith(1) });
    expect(screen.getByLabelText('Contesto per richiesta (token)')).toBeTruthy();
    expect(screen.getByText('--kv_cache_free_gpu_memory_fraction')).toBeTruthy();
    expect((screen.getByLabelText('Immagine Docker') as HTMLInputElement).placeholder).toBe('nvcr.io/nvidia/tensorrt-llm/release:1.4.0rc0');
    rerender(<ExpertPanel engine="trtllm-native" {...props} />);
    expect(screen.queryByLabelText('Immagine Docker')).toBeNull();
  });
});

describe('TensorRT-LLM in the form, the labels and the pickers', () => {
  const f = createFormatters('it');
  const en = createFormatters('en');

  it('TensorRT-LLM’s own settings go to params.trtllm and back; another engine never sends them', () => {
    expect(paramsFromForm({ ...EMPTY_PARAMS_FORM, trtllmTp: '2', trtllmKvMemory: '85%' }, { base: 'trtllm' }).params.trtllm).toEqual({ tensorParallel: 2, kvCacheFreeMemoryFraction: 0.85 });
    expect(paramsFromForm({ ...EMPTY_PARAMS_FORM, trtllmTp: '2', trtllmKvMemory: '85%' }, { base: 'vllm' }).params.trtllm).toBeUndefined();
    expect(paramsFromForm({ ...EMPTY_PARAMS_FORM, trtllmTp: '1' }).params.trtllm).toBeUndefined();
    expect(paramsFromForm({ ...EMPTY_PARAMS_FORM, trtllmTp: 'x' }).invalid).toEqual(['trtllmTp']);
    expect(paramsFromForm({ ...EMPTY_PARAMS_FORM, trtllmTp: '16' }).invalid).toEqual(['trtllmTp']);
    expect(paramsFromForm({ ...EMPTY_PARAMS_FORM, trtllmKvMemory: '3' }).invalid).toEqual(['trtllmKvMemory']);
    expect(formFromParams({ trtllm: { tensorParallel: 4, kvCacheFreeMemoryFraction: 0.8 }, extraArgs: [], env: {} })).toMatchObject({ trtllmTp: '4', trtllmKvMemory: '0.8' });
    expect(formFromParams({ extraArgs: [], env: {} })).toMatchObject({ trtllmTp: '', trtllmKvMemory: '' });
    expect(hasCustomParams({ trtllm: {}, extraArgs: [], env: {} })).toBe(false);
    expect(hasCustomParams({ trtllm: { tensorParallel: 2 }, extraArgs: [], env: {} })).toBe(true);
  });


  it('its flags group configurations (Docker after the image, WSL after trtllm-serve); defaults and LLM Bench’s own file do not count', () => {
    const argv = [
      'docker', 'run', '--gpus', 'all', 'nvcr.io/nvidia/tensorrt-llm/release:1.2.0', 'trtllm-serve', '/models/Qwen3-8B-FP8',
      '--host', '0.0.0.0', '--port', '8000', '--max_seq_len', '32768', '--max_batch_size', '8', '--max_num_tokens', '8192',
      '--kv_cache_free_gpu_memory_fraction', '0.85', '--tp_size', '2', '--backend', 'pytorch', '--extra_llm_api_options', '/tmp/llmbench-trtllm.yaml',
      '--trust_remote_code', '--enable_chunked_prefill', '--log_level', 'info', '--served_model_name', 'gpubench-1', '--kv_cache_dtype', 'fp8',
    ];
    const p = configParamsOf({ engineKind: 'trtllm-docker', argv, image: 'nvcr.io/nvidia/tensorrt-llm/release:1.2.0' });
    expect(p).toEqual({ contextSize: 32768, parallel: 8, maxNumBatchedTokens: 8192, gpuMemoryUtilization: 0.85, tensorParallel: 2, cacheTypeK: 'fp8', cacheTypeV: 'fp8', other: [] });
    const wsl = configParamsOf({ engineKind: 'trtllm-native', argv: ['wsl.exe', '-d', 'Ubuntu', '--', '/home/me/trtllm/bin/trtllm-serve', 'serve', '/m', '--max-seq-len', '4096', '--tensor_parallel_size', '1', '--free_gpu_memory_fraction', '0.7', '--backend', 'tensorrt'] });
    expect(wsl).toEqual({ contextSize: 4096, gpuMemoryUtilization: 0.7, other: ['--backend tensorrt'] });
    // A count or a backend that says nothing changes nothing.
    expect(configParamsOf({ engineKind: 'trtllm-native', argv: ['trtllm-serve', 'serve', '/m', '--tp_size', 'x', '--backend'] })).toEqual({ other: [] });
    // Params alone (a tune combination, a label): the tokens per step and the cards.
    expect(configParamsOf({ engineKind: 'trtllm-native', params: { maxModelLen: 8192, batchSize: 4096, kvCacheType: 'q8_0', trtllm: { tensorParallel: 2, kvCacheFreeMemoryFraction: 0.9 }, extraArgs: [], env: {} } })).toEqual({
      contextSize: 8192,
      cacheTypeK: 'fp8',
      cacheTypeV: 'fp8',
      maxNumBatchedTokens: 4096,
      tensorParallel: 2,
      other: [],
    });
    // vLLM's batch is still read from its command only.
    expect(configParamsOf({ engineKind: 'vllm-docker', params: { batchSize: 4096, extraArgs: [], env: {} } }).maxNumBatchedTokens).toBeUndefined();
  });

  it('in words: the KV cache’s share of free memory, the cards in tensor parallel, Docker named', () => {
    const p = configParamsOf({ engineKind: 'trtllm-docker', params: { maxModelLen: 32768, trtllm: { tensorParallel: 2, kvCacheFreeMemoryFraction: 0.8, kvCacheDtype: 'nvfp4' }, extraArgs: [], env: {} } });
    expect(configParts('trtllm-docker', p, f)).toContain('cache KV nvfp4');
    expect(configParts('trtllm-docker', p, f)).toContain('cache KV 80% della memoria libera');
    expect(configParts('trtllm-docker', p, f)).toContain('2 schede in tensor parallel');
    expect(configParts('trtllm-native', p, en)).toContain('KV cache 80% of free memory');
    expect(configParts('vllm-docker', { gpuMemoryUtilization: 0.8, other: [] }, f)).toContain('memoria GPU 80%');
    const run = { engine: { kind: 'trtllm-docker' as const, name: 'TensorRT-LLM', version: '1.2.0' }, model: { displayName: 'Qwen3 8B FP8' }, launch: { params: { extraArgs: [], env: {} } } };
    expect(launchSummaryParts(run as never, f)[0]).toBe('TensorRT-LLM 1.2.0 · Docker');
  });

  it('the glossary explains the KV cache share and tensor parallel only when a launch has them', () => {
    const launch = (params: object) => ({ params: { extraArgs: [], env: {}, ...params } });
    const tuning = { combinations: [launch({ trtllm: { tensorParallel: 2, kvCacheFreeMemoryFraction: 0.8 } })], attempts: [] };
    expect(glossaryTerms('trtllm-docker', tuning as never)).toEqual(expect.arrayContaining(['kvShare', 'tp']));
    expect(glossaryTerms('vllm-docker', { combinations: [launch({ gpuMemoryUtilization: 0.8 })], attempts: [] } as never)).not.toContain('kvShare');
  });

  it('pickers, names and needs know TensorRT-LLM', () => {
    expect(ENGINE_ORDER).toEqual(expect.arrayContaining(['trtllm-docker', 'trtllm-native']));
    expect(formatNoteOf('trtllm-docker')).toBe('trtllm');
    expect(formatNoteOf('vllm-docker')).toBe('vllm');
    expect(f.t('models.picker.formatNote.trtllm')).toContain('FP8 o NVFP4');
    expect(engineName('trtllm-native')).toBe('TensorRT-LLM');
    expect(engineKindOfLabel('TensorRT-LLM 1.2.0')).toBe('trtllm-docker');
    expect(engineKindOfLabel('vLLM v0.12.0')).toBe('vllm-docker');
    expect(guessNeeds({ engine: { kind: 'trtllm-docker' }, status: { kind: 'trtllm-docker', available: false, installed: false, location: 'nvcr.io/nvidia/tensorrt-llm/release:1.2.0', problems: ['ENGINE_NOT_INSTALLED'], supported: true }, option: undefined, modelLabel: 'm' })).toEqual([
      { kind: 'image', engine: 'trtllm-docker', label: 'nvcr.io/nvidia/tensorrt-llm/release:1.2.0' },
    ]);
    expect(engineChoices('safetensors', [], [], 'win32').map((c) => c.kind)).toEqual(expect.arrayContaining(['trtllm-docker', 'trtllm-native']));
    expect(paramText('trtllm', { trtllm: { tensorParallel: 2 }, extraArgs: [], env: {} }, 'auto')).toBe('tp_size 2');
    expect(paramText('trtllm', { extraArgs: [], env: {} }, 'auto')).toBe('auto');
    expect(reservesMemory({ engine: { kind: 'trtllm-native' } } as never)).toBe(true);
  });
});

describe('waits', () => {
  it('the system is read before the card count is known (one card meanwhile)', async () => {
    renderUi(<Harness />, { withSettings: true, api: apiWith(4) });
    expect(screen.queryByText('Schede video usate insieme')).toBeNull();
    await waitFor(() => expect(screen.getByText('Schede video usate insieme')).toBeTruthy());
  });
});
