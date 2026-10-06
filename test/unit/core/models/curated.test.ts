import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CURATED_FILE, CURATED_TIERS, curatedForVram, curatedListSchema, loadCurated } from '../../../../src/core/models/curated';
import { tempDir } from './helpers';

const RESOURCES = path.join(process.cwd(), 'resources');

describe('resources/curated-models.json', () => {
  it('is valid, has a pinned 8 GB reference and entries for every tier', async () => {
    const list = await loadCurated(RESOURCES);
    expect(list.reference).toMatchObject({ repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', quant: 'Q4_K_M' });
    expect(list.reference.sizeBytes).toBeLessThan(4 * 1024 ** 3);
    for (const tier of [8, 12, 16, 24, 32, 48]) expect(list.models.some((m) => m.tier === tier)).toBe(true);
    const ref = list.models.find((m) => m.reference);
    expect(ref).toMatchObject({ repo: list.reference.repo, file: list.reference.file, sha256: list.reference.sha256, revision: list.reference.revision, tier: 8 });
    expect(list.models.filter((m) => m.engine === 'vllm').length).toBeGreaterThanOrEqual(6);
    expect(new Set(list.models.map((m) => m.id)).size).toBe(list.models.length);
  });

  it('filters by VRAM: closest tier first, then larger files', async () => {
    const list = await loadCurated(RESOURCES);
    const for32 = curatedForVram(list, 31.8);
    expect(for32.every((m) => m.tier <= 31.8)).toBe(true);
    expect(for32[0]?.tier).toBe(24);
    const tiers = for32.map((m) => m.tier);
    expect([...tiers].sort((a, b) => b - a)).toEqual(tiers);
    expect(curatedForVram(list, 8, 'vllm').every((m) => m.engine === 'vllm' && m.tier === 8)).toBe(true);
    expect(curatedForVram(list, 4)).toEqual([]);
    expect(CURATED_TIERS).toContain(80);
  });
});

describe('loadCurated errors', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir('gb-curated-');
  });
  afterEach(() => t.cleanup());

  it('reports a missing, unparsable or invalid file as INTERNAL', async () => {
    await expect(loadCurated(t.dir)).rejects.toMatchObject({ code: 'INTERNAL' });
    writeFileSync(path.join(t.dir, CURATED_FILE), '{');
    await expect(loadCurated(t.dir)).rejects.toMatchObject({ code: 'INTERNAL' });
    const good = JSON.parse(readFileSync(path.join(RESOURCES, CURATED_FILE), 'utf8')) as { models: Record<string, unknown>[] };
    const broken = { ...good, models: [{ ...good.models[0], tier: 10 }] };
    writeFileSync(path.join(t.dir, CURATED_FILE), JSON.stringify(broken));
    await expect(loadCurated(t.dir)).rejects.toMatchObject({ code: 'INTERNAL', detail: expect.stringContaining('tier') });
  });

  it('requires a file for llama.cpp entries and none for vLLM ones', () => {
    const good = JSON.parse(readFileSync(path.join(RESOURCES, CURATED_FILE), 'utf8')) as { models: Record<string, unknown>[] };
    const vllmWithFile = { ...good, models: [{ ...good.models.find((m) => m.engine === 'vllm'), file: 'x.gguf' }] };
    expect(curatedListSchema.safeParse(vllmWithFile).success).toBe(false);
    const ggufNoFile = { ...good, models: [{ ...good.models[0], file: undefined }] };
    expect(curatedListSchema.safeParse(ggufNoFile).success).toBe(false);
  });
});
