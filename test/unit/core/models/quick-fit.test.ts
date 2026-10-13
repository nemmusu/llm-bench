import { describe, expect, it } from 'vitest';
import type { HubModel } from '../../../../src/contract/models';
import { maxFittingParamsB, quickFit, quickFits, safetensorsQuant } from '../../../../src/core/models/quick-fit';

const gpu = { totalMiB: 32 * 1024, freeMiB: 30 * 1024 };
const model = (patch: Partial<HubModel>): HubModel => ({ repo: 'o/m', author: 'o', name: 'm', downloads: 0, likes: 0, gated: false, formats: [], otherFormats: [], tags: [], ...patch });

describe('quick fit of search results', () => {
  it('reads the precision of safetensors repos from name and tags', () => {
    expect(safetensorsQuant({ name: 'Qwen3-8B-AWQ', tags: [] })).toBe('AWQ');
    expect(safetensorsQuant({ name: 'Llama-3.1-8B-Instruct-GPTQ-Int4', tags: [] })).toBe('GPTQ');
    expect(safetensorsQuant({ name: 'm', tags: ['bnb', '4-bit'] })).toBe('INT4');
    expect(safetensorsQuant({ name: 'Qwen3-30B-A3B-FP8', tags: [] })).toBe('FP8');
    expect(safetensorsQuant({ name: 'gpt-oss-20b', tags: ['mxfp4'] })).toBe('MXFP4');
    expect(safetensorsQuant({ name: 'Qwen3-8B', tags: ['safetensors'] })).toBe('BF16');
    // "AWQ" only as a word: not inside another name.
    expect(safetensorsQuant({ name: 'Hawqwen-7B', tags: [] })).toBe('BF16');
    // The search result's own precision (from the hub's dtype counts) wins.
    expect(safetensorsQuant({ name: 'Qwen3-8B', tags: [], precision: 'NVFP4' })).toBe('NVFP4');
  });

  it('judges GGUF repos at Q4_K_M on llama.cpp and safetensors repos on vLLM', () => {
    expect(quickFit(model({ formats: ['gguf'] }), gpu)).toBeUndefined();
    const small = quickFit(model({ paramsB: 8, formats: ['gguf', 'safetensors'] }), gpu);
    expect(small).toMatchObject({ level: 'perfect', quant: 'Q4_K_M', engine: 'llamacpp' });
    expect(small?.availableMiB).toBeGreaterThan(0);
    expect(quickFit(model({ paramsB: 8, formats: ['gguf'] }), gpu, 'safetensors')).toMatchObject({ quant: 'BF16', engine: 'vllm' });
    expect(quickFit(model({ paramsB: 8, formats: ['safetensors'] }), gpu, 'gguf')).toMatchObject({ quant: 'Q4_K_M', engine: 'llamacpp' });
    expect(quickFit(model({ paramsB: 70, formats: ['safetensors'] }), gpu)?.level).toBe('no');
    expect(quickFit(model({ paramsB: 120, formats: ['gguf'] }), gpu)?.level).toBe('partial');
  });

  it('judges NInfer artifacts at their precision when the filter or the formats say so', () => {
    expect(quickFit(model({ name: 'Qwen3.8-27B-nvfp4-NInfer', paramsB: 27, formats: ['ninfer'] }), gpu)).toMatchObject({ engine: 'ninfer', quant: 'NVFP4' });
    expect(quickFit(model({ name: 'Q-27B-NInfer', paramsB: 27, formats: ['gguf', 'ninfer'] }), gpu, 'ninfer')).toMatchObject({ engine: 'ninfer', quant: 'NVFP4' });
    expect(quickFit(model({ name: 'Q-27B-fp8-NInfer', paramsB: 27, formats: ['ninfer'] }), gpu)?.quant).toBe('FP8');
    expect(quickFit(model({ paramsB: 8, formats: ['safetensors', 'ninfer'] }), gpu)?.engine).toBe('vllm');
    expect(maxFittingParamsB(gpu, 'ninfer')).toBe(maxFittingParamsB(gpu, 'gguf'));
  });

  it('counts only full-VRAM verdicts as fitting', () => {
    expect(quickFits(undefined)).toBe(false);
    expect(quickFits(quickFit(model({ paramsB: 8, formats: ['gguf'] }), gpu))).toBe(true);
    expect(quickFits(quickFit(model({ paramsB: 120, formats: ['gguf'] }), gpu))).toBe(false);
  });

  it('finds the largest parameter count that fits', () => {
    const gguf = maxFittingParamsB(gpu, 'gguf');
    expect(gguf).toBeGreaterThan(30);
    expect(gguf).toBeLessThan(60);
    expect(quickFits(quickFit(model({ paramsB: gguf, formats: ['gguf'] }), gpu))).toBe(true);
    expect(quickFits(quickFit(model({ paramsB: gguf + 1, formats: ['gguf'] }), gpu))).toBe(false);
    expect(maxFittingParamsB(gpu, 'safetensors')).toBeLessThan(gguf);
    // The card's total counts, not what is free now; a card smaller than the reserve fits nothing.
    expect(maxFittingParamsB({ totalMiB: 8192, freeMiB: 0 }, 'any')).toBeGreaterThan(8);
    expect(maxFittingParamsB({ totalMiB: 1024, freeMiB: 1024 }, 'any')).toBe(0);
  });
});
