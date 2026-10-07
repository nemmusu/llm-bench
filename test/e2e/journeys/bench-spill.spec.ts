import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BORDERLINE_PROFILE, SPILL_PROFILE, TUNE_SLOW_PROFILE } from '../../fakes/fake-engine/profiles.mjs';
import { buildGguf, llamaLikeGguf } from '../../fakes/fake-hub/model-files.mjs';
import type { Page } from '@playwright/test';
import { expect, launchApp, ROOT, test, type AppHandle } from '../fixtures';
import type { LatencyPoint, RunResult, Stat } from '../../../src/contract/results';
import { h1, scan, seedRuns, skipWelcome } from './bench-helpers';

test.describe.configure({ timeout: 300_000 });

/**
 * The app with one GGUF in its library (and no other model): `file` in models/local, a llama-like
 * model of `layers` × 8 KV heads × 128 (KV: layers × 4 KiB per token).
 */
async function withModel(file: string, gguf: { name: string; sizeLabel: string; layers: number; ctx: number }, profile: object, env: Record<string, string> = {}): Promise<AppHandle> {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-spill-'));
  const local = path.join(userData, 'models', 'local');
  mkdirSync(local, { recursive: true });
  writeFileSync(path.join(local, file), buildGguf({ ...llamaLikeGguf({ ...gguf, kvHeads: 8, headDim: 128 }), totalSize: 96 * 1024 }));
  const handle = await launchApp({ userData, seedModel: false, env: { FAKE_ENGINE_PROFILE: JSON.stringify(profile), ...env } });
  return {
    ...handle,
    close: async () => {
      await handle.close();
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

async function nav(page: Page, to: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: to }).click();
}

test('a run that spills into shared memory says so, and its quick fixes run it again with what fits', async () => {
  // 64 layers: 256 MiB of KV per 1K tokens, 64 GB at the model's 256K (the real 27B of the bug report).
  const gb = await withModel('Qwen3-27B-Q4_K_M.gguf', { name: 'Qwen3 27B', sizeLabel: '27B', layers: 64, ctx: 262_144 }, SPILL_PROFILE);
  try {
    const { page } = gb;
    await skipWelcome(page);

    // A clean Rapido first: the card's usual speed for this model.
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('button', { name: 'Scarica e avvia' }).click();
    await expect(h1(page, /Qwen3-27B/)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole('alert').filter({ hasText: 'Il modello non è entrato tutto nella memoria della scheda' })).toHaveCount(0);

    // The whole 256K context: the plan says before starting that it does not fit, with the fixes.
    await nav(page, 'Benchmark');
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await expect(page.getByText(/^Provato su questa GPU · [\d.,]+ tok\/s$/)).toBeVisible();
    await page.getByRole('switch', { name: 'Modalità esperto' }).click();
    await page.getByLabel('Contesto (token)').fill('262144');
    const risk = page.getByRole('list', { name: 'Avvisi' }).getByRole('listitem').filter({ hasText: 'Il modello non entra tutto nella scheda video' });
    await expect(risk).toContainText('Windows metterà il resto nella RAM condivisa');
    await expect(risk.getByRole('button', { name: 'Usa cache q4_0' })).toBeVisible();
    await expect(risk.getByRole('button', { name: /^Contesto massimo che entra: \d+K$/ })).toBeVisible();
    await scan(page, 'plan with a spill warning');

    // Started anyway: it loads, generation collapses, the result says so first.
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    await expect(h1(page, /Qwen3-27B/)).toBeVisible({ timeout: 90_000 });
    const warning = page.getByRole('alert').filter({ hasText: 'Il modello non è entrato tutto nella memoria della scheda' });
    await expect(warning).toContainText(/Genera [\d,]+ tok\/s invece dei soliti [\d.,]+, circa \d+ volte più lento/);
    await expect(warning).toContainText('Questi numeri non sono quelli veri della scheda.');
    await expect(warning.getByRole('button', { name: 'Trova le impostazioni migliori' })).toBeVisible();
    await expect(warning.getByRole('button', { name: 'Riprova con cache q4_0' })).toBeVisible();
    const lessContext = warning.getByRole('button', { name: /^Riprova con meno contesto \(\d+K\)$/ });
    await expect(lessContext).toBeVisible();
    await expect(page.getByText('Falsata dalla RAM condivisa')).toBeVisible();
    await scan(page, 'spilled result');

    // One click: the same test with the largest context that fits; this one is clean.
    await lessContext.click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    await expect(h1(page, /Qwen3-27B/)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole('alert').filter({ hasText: 'Il modello non è entrato tutto nella memoria della scheda' })).toHaveCount(0);

    // Lists say which run spilled; "Provato su questa GPU" keeps quoting a clean one.
    await nav(page, 'Benchmark');
    await expect(page.getByText(/^Provato su questa GPU · [\d.,]+ tok\/s$/)).toBeVisible();
    // "Ultimi risultati": the badge on the spilled run only.
    await expect(page.getByRole('heading', { name: 'Ultimi risultati' })).toBeVisible();
    await expect(page.getByText('RAM condivisa', { exact: true })).toHaveCount(1);
    await nav(page, 'Risultati');
    await expect(page.getByText('3 risultati')).toBeVisible();
    await expect(page.getByText('RAM condivisa', { exact: true })).toHaveCount(1);
  } finally {
    await gb.close();
  }
});

test('a search that runs out of time keeps what it measured: partial combinations, a recommendation, a preset', async () => {
  // Generation far slower than its forecast expects: the search's own time limit ends it early.
  const gb = await withModel('Qwen3-16K-Q4_K_M.gguf', { name: 'Qwen3 16K', sizeLabel: '0.6B', layers: 4, ctx: 16_384 }, TUNE_SLOW_PROFILE);
  try {
    const { page } = gb;
    await skipWelcome(page);
    await page.getByRole('radio', { name: /Trova le impostazioni migliori/ }).click();
    await expect(page.getByRole('radio', { name: /^Veloce/ })).toBeChecked();
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('button', { name: 'Scarica e avvia' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });

    await expect(h1(page, /Qwen3-16K/)).toBeVisible({ timeout: 240_000 });
    await expect(page.getByText('Mi sono fermato prima: tempo finito')).toBeVisible();
    await expect(page.getByText(/Le combinazioni «misurate in parte» hanno i numeri presi fin lì/)).toBeVisible();
    const recommended = page.getByRole('region', { name: 'Combinazione consigliata' });
    await expect(recommended).toBeVisible();
    await expect(recommended.getByText('Misurata in parte (tempo finito)')).toBeVisible();    await scan(page, 'tune result cut by its time limit');

    // The header's preset is the recommended combination: back on Benchmark with its settings.
    // (The header's group comes first; every ranking row has its own.)
    await page.getByRole('group', { name: 'Preset di Qwen3-16K-Q4_K_M' }).first().getByRole('button', { name: 'Usa questo preset' }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await expect(page.getByText('Impostazioni copiate nel Benchmark')).toBeVisible();
    await expect(page.getByLabel('Contesto (token)')).toHaveValue('16384');
  } finally {
    await gb.close();
  }
});

test('a launch of the search that spills while it runs (240K: clean once loaded, starved by its first request) is given up at once; the search goes on lower and ends', async () => {
  // 34 layers × 8 KV heads × 128: 136 KiB of f16 KV per token, so the estimate puts f16 at ~244K (240K tried
  // first). The per-process readings (dedicated and shared memory) come from the fake monitor.
  const monitor = path.join(ROOT, 'test', 'fakes', 'fake-nvidia-smi', 'fake-gpu-memory.mjs');
  const gb = await withModel('Qwen3-27B-Q4_K_XL.gguf', { name: 'Qwen3 27B', sizeLabel: '27B', layers: 34, ctx: 262_144 }, BORDERLINE_PROFILE, {
    GPUBENCH_GPU_MEMORY_MONITOR: JSON.stringify([process.execPath, monitor]),
  });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await page.getByRole('radio', { name: /Trova le impostazioni migliori/ }).click();
    await expect(page.getByRole('radio', { name: /^Veloce/ })).toBeChecked();
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('button', { name: 'Scarica e avvia' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });

    // Live: 240K is in the list the moment it is given up (its probe never answers), and the search goes on.
    const attempts = page.getByRole('table', { name: 'Prove fatte' });
    const border = attempts.getByRole('row').filter({ hasText: '240K' }).filter({ hasText: 'Usa la RAM condivisa (lento)' });
    await expect(border).toBeVisible({ timeout: 120_000 });
    await expect(attempts.getByRole('row').filter({ hasText: '224K' }).filter({ hasText: 'Caricato' }).first()).toBeVisible({ timeout: 120_000 });
    await scan(page, 'live tune run with a launch given up');

    // It ends, on its own: f16 holds 224K (240K did not fit), q8_0 the whole 256K.
    await expect(h1(page, /Qwen3-27B/)).toBeVisible({ timeout: 240_000 });
    await expect(page.getByText(/^Mi sono fermato prima/)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Combinazione consigliata' })).toBeVisible();
    const capacity = page.getByRole('table', { name: 'Contesto massimo per tipo di cache' });
    const f16 = capacity.getByRole('row').filter({ hasText: 'f16' });
    await expect(f16).toContainText('224K');
    await expect(f16).toContainText('Limite trovato: a 240K non entra più.');
    await expect(capacity.getByRole('row').filter({ hasText: 'q8_0' })).toContainText('256K');
    await page.getByRole('button', { name: /Prove scartate/ }).click();
    await expect(page.getByText(/Con contesto 240K non stava tutto nella memoria video: Windows ha spostato 1,3 GB nella RAM condivisa/)).toBeVisible();
    await scan(page, 'tune result after a launch given up');
  } finally {
    await gb.close();
  }
});

test('an older run saved before the shared memory was measured, far slower than the others here: a probable spill', async () => {
  // The seeded Gemma 4 31B Standard (58,6 tok/s) and the same test an hour earlier, saved by GPU Bench
  // 0.3.0 while it spilled: 3,5 tok/s and nothing in its file that says why.
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-legacy-'));
  const results = path.join(userData, 'results');
  const [seeded] = seedRuns(results, (f) => f.includes('01K6WQ8D3N7B2X5C9V4M6K1JHT'));
  const clean = JSON.parse(readFileSync(path.join(results, seeded as string), 'utf8')) as RunResult;
  const slow = (s: Stat): Stat => ({ ...s, median: 3.5, mean: 3.5, min: 3.4, max: 3.6, values: s.values.map(() => 3.5) });
  const spilled: RunResult = {
    ...clean,
    id: '01K6WM0LEGACY0SPILL0000000',
    createdAt: '2026-10-05T17:10:00.000Z',
    finishedAt: '2026-10-05T17:25:00.000Z',
    metrics: {
      ...clean.metrics,
      latency: clean.metrics.latency.map((p): LatencyPoint => ({ ...p, decodeTps: slow(p.decodeTps), ...(p.decodeTpsEngine ? { decodeTpsEngine: slow(p.decodeTpsEngine) } : {}) })),
    },
  };
  const file = path.join(results, `2026-10-05_17-10-00_${spilled.id}.json`);
  writeFileSync(file, JSON.stringify(spilled));
  const saved = readFileSync(file, 'utf8');
  const gb = await launchApp({ userData });
  try {
    const { page } = gb;
    await skipWelcome(page);
    // "Ultimi risultati" and Risultati: the badge on the older run only.
    await expect(page.getByRole('heading', { name: 'Ultimi risultati' })).toBeVisible();
    await expect(page.getByText('RAM condivisa', { exact: true })).toHaveCount(1);
    await nav(page, 'Risultati');
    await expect(page.getByText('2 risultati')).toBeVisible();
    await expect(page.getByText('RAM condivisa', { exact: true })).toHaveCount(1);

    // Its page says so first, as a probability, with the numbers.
    await page.getByRole('row').filter({ hasText: 'RAM condivisa' }).getByRole('link', { name: /Gemma 4 31B/ }).click();
    await expect(h1(page, /Gemma 4 31B/)).toBeVisible();
    const warning = page.getByRole('alert').filter({ hasText: 'Probabilmente il modello non è entrato tutto nella memoria della scheda' });
    await expect(warning).toContainText('Questo test è stato circa 17 volte più lento degli altri dello stesso modello su questa scheda (3,5 tok/s invece di 58,6)');
    await expect(warning).toContainText('con ogni probabilità il modello è finito nella RAM condivisa');
    await expect(warning.getByRole('button', { name: 'Trova le impostazioni migliori' })).toBeVisible();
    await expect(page.getByText('Falsata dalla RAM condivisa')).toBeVisible();
    await scan(page, 'probable spill of an older run');
    // The file stays as it was saved.
    expect(readFileSync(file, 'utf8')).toBe(saved);
  } finally {
    await gb.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
