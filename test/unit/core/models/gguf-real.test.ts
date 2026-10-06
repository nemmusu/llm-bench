/**
 * Reads the real GGUF headers on the dev machine (C:\models, read-only). Skipped wherever the
 * files are missing (CI, other PCs). Prints what was read so a human can eyeball it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { estimateFit } from '../../../../src/core/models/fit';
import { readLocalGgufFacts } from '../../../../src/core/models/gguf';

const GEMMA = 'C:\\models\\gemma4\\gemma-4-31B-it-UD-Q4_K_XL.gguf';
const GEMMA_MTP = 'C:\\models\\gemma4\\mtp-gemma-4-31B-it.gguf';
const GEMMA_MMPROJ = 'C:\\models\\gemma4\\mmproj-F16.gguf';
const QWEN = 'C:\\models\\Qwen3.8-27B-UD-Q4_K_XL.gguf';
const QWOPUS = 'C:\\models\\qwopus-flash-v2\\Qwopus3.8-27B-Flash-V2-abliterated.Q4_K_M.gguf';
const GPU_5090 = { totalMiB: 32607, freeMiB: 30900 };

function show(label: string, value: unknown): void {
  console.log(`[real gguf] ${label}: ${JSON.stringify(value)}`);
}

describe('real GGUF headers in C:\\models', () => {
  it.skipIf(!existsSync(GEMMA))('Gemma 4 31B (per-layer KV heads, SWA 1024, SWA head size 256)', async () => {
    const f = await readLocalGgufFacts([GEMMA]);
    show('gemma-4-31B', f);
    expect(f).toMatchObject({ architecture: 'gemma4', blockCount: 60, contextLength: 262144, slidingWindow: 1024, slidingWindowLayers: 50, fullAttentionLayers: 10, headCountKv: 16, keyLength: 512, quant: 'UD-Q4_K_XL', vocabSize: 262144 });
    expect(f.kv?.groups).toEqual([
      { layers: 50, kvHeads: 16, keyLength: 256, valueLength: 256, window: 1024 },
      { layers: 10, kvHeads: 4, keyLength: 512, valueLength: 512 },
    ]);
    // Tied embeddings: the GPU holds the whole file.
    expect(f.cpuOnlyFraction).toBeUndefined();
    const fit = estimateFit({ facts: f, fileBytes: statSync(GEMMA).size, gpu: GPU_5090, engine: 'llamacpp-native', params: { contextSize: 8192 } });
    show('gemma-4-31B fit @8k on 5090', fit);
    expect(['good', 'tight']).toContain(fit.level);
  });

  it.skipIf(!existsSync(QWEN))('Qwen3.8 27B (hybrid: 16 attention layers of 64, NextN excluded)', async () => {
    const f = await readLocalGgufFacts([QWEN]);
    show('Qwen3.8-27B', f);
    expect(f).toMatchObject({ architecture: 'qwen35', blockCount: 65, fullAttentionLayers: 16, headCountKv: 4, keyLength: 256, quant: 'UD-Q4_K_XL' });
    expect(f.kv?.recurrentLayers).toBe(48);
    expect(f.cpuOnlyFraction).toBeGreaterThan(0);
    const fit = estimateFit({ facts: f, fileBytes: statSync(QWEN).size, gpu: GPU_5090, engine: 'llamacpp-native', params: { contextSize: 32768 } });
    show('Qwen3.8-27B fit @32k on 5090', fit);
    expect(fit.level).not.toBe('no');
  });

  it.skipIf(!existsSync(QWOPUS))('Qwopus 27B (explicit recurrent_layers array)', async () => {
    const f = await readLocalGgufFacts([QWOPUS]);
    show('Qwopus3.8-27B', f);
    expect(f).toMatchObject({ architecture: 'qwen35', blockCount: 64, fullAttentionLayers: 16, quant: 'Q4_K_M' });
  });

  it.skipIf(!existsSync(GEMMA_MTP) || !existsSync(GEMMA_MMPROJ))('auxiliary files (MTP head, mmproj)', async () => {
    const mtp = await readLocalGgufFacts([GEMMA_MTP]);
    const mmproj = await readLocalGgufFacts([GEMMA_MMPROJ]);
    show('mtp-gemma-4-31B', mtp);
    show('mmproj-F16', mmproj);
    expect(mtp.architecture).toBe('gemma4-assistant');
    expect(mmproj.architecture).toBe('clip');
  });
});
