import { describe, expect, it } from 'vitest';
import { bytesPerParam, DEFAULT_BYTES_PER_PARAM, ftypeName, normalizeQuant, paramsFromLabel, quantFromFilename, round3 } from '../../../../src/core/models/quant';

describe('quant labels', () => {
  it('parses quant labels from file names, keeping the UD- prefix', () => {
    expect(quantFromFilename('Qwen3-4B-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(quantFromFilename('gemma-4-31B-it-UD-Q4_K_XL.gguf')).toBe('UD-Q4_K_XL');
    expect(quantFromFilename('Qwopus3.8-27B-Flash-V2-abliterated.Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(quantFromFilename('mmproj-F16.gguf')).toBe('F16');
    expect(quantFromFilename('model-bf16-00001-of-00002.gguf')).toBe('BF16');
    expect(quantFromFilename('gpt-oss-20b-MXFP4.gguf')).toBe('MXFP4');
    expect(quantFromFilename('no-quant-here.gguf')).toBeUndefined();
  });

  it('names llama_ftype values', () => {
    expect(ftypeName(15)).toBe('Q4_K_M');
    expect(ftypeName(7)).toBe('Q8_0');
    expect(ftypeName(1)).toBe('F16');
    expect(ftypeName(32)).toBe('BF16');
    expect(ftypeName(undefined)).toBeUndefined();
    expect(ftypeName(9999)).toBeUndefined();
  });

  it('normalizes decorations', () => {
    expect(normalizeQuant('ud-q4_k_xl')).toBe('Q4_K_XL');
  });
});

describe('bytesPerParam (llmfit table)', () => {
  it('uses the exact table entries', () => {
    expect(bytesPerParam('Q8_0')).toBe(1.05);
    expect(bytesPerParam('Q6_K')).toBe(0.8);
    expect(bytesPerParam('Q5_K_M')).toBe(0.68);
    expect(bytesPerParam('Q4_K_M')).toBe(0.58);
    expect(bytesPerParam('Q4_0')).toBe(0.58);
    expect(bytesPerParam('Q3_K_M')).toBe(0.48);
    expect(bytesPerParam('Q2_K')).toBe(0.37);
    expect(bytesPerParam('F16')).toBe(2);
    expect(bytesPerParam('BF16')).toBe(2);
    expect(bytesPerParam('F32')).toBe(4);
  });

  it('falls back to the bit family, then to the default', () => {
    expect(bytesPerParam('UD-Q4_K_XL')).toBe(0.58);
    expect(bytesPerParam('Q6_K_L')).toBe(0.8);
    expect(bytesPerParam('Q5_0')).toBe(0.68);
    expect(bytesPerParam('IQ3_XXS')).toBe(0.48);
    expect(bytesPerParam('IQ2_M')).toBe(0.37);
    expect(bytesPerParam('IQ1_S')).toBe(0.25);
    expect(bytesPerParam('FP8')).toBe(1.05);
    expect(bytesPerParam('AWQ-4bit')).toBe(0.58);
    expect(bytesPerParam('WEIRD')).toBe(DEFAULT_BYTES_PER_PARAM);
    expect(bytesPerParam(undefined)).toBe(DEFAULT_BYTES_PER_PARAM);
  });
});

describe('paramsFromLabel', () => {
  it('reads size labels and repo names', () => {
    expect(paramsFromLabel('31B')).toBe(31);
    expect(paramsFromLabel('470M')).toBe(0.47);
    expect(paramsFromLabel('8x7B')).toBe(56);
    expect(paramsFromLabel('30B-A3B')).toBe(30);
    expect(paramsFromLabel('1.5T')).toBe(1500);
    expect(paramsFromLabel('Qwen3-0.6B-GGUF')).toBe(0.6);
    expect(paramsFromLabel('Meta-Llama-3.1-8B-Instruct')).toBe(8);
    expect(paramsFromLabel('Phi-3-mini-4k')).toBeUndefined();
    expect(paramsFromLabel('model-8bit')).toBeUndefined();
    expect(paramsFromLabel('')).toBeUndefined();
    expect(paramsFromLabel(undefined)).toBeUndefined();
    expect(round3(1.23456)).toBe(1.235);
  });
});
