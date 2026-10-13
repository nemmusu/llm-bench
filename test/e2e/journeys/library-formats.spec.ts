import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { buildSafetensors, llamaLikeGguf } from '../../fakes/fake-hub/model-files.mjs';
import { expect, launchApp, test } from '../fixtures';
import { h1, newUserData, openPage, scan, skipWelcome, startLibraryWorld, stubDesktop, type LibraryWorld } from './library-helpers';

/**
 * Mixed repos, the search kept across a model page and back, and the VRAM verdict on a busy card, done
 * the way a person does them: search, scroll, open, download one format, go back.
 */
test.describe.configure({ timeout: 180_000 });

let world: LibraryWorld;
const ARTIFACT = Buffer.alloc(24 * 1024, 7);
const MIXED = 'mixed/Tiny-Mixed-GGUF-NInfer';

test.beforeAll(async () => {
  world = await startLibraryWorld();
  // A repo with every format: GGUF in a sub-folder (with an mmproj), a safetensors folder for vLLM /
  // SGLang, an NInfer artifact with its manifest and checksums, a README, a picture and a video.
  world.hub.addRepo({
    id: MIXED,
    downloads: 900,
    likes: 12,
    trendingScore: 1,
    license: 'apache-2.0',
    pipelineTag: 'text-generation',
    numParameters: 600_000_000,
    safetensorsTotal: 600_000_000,
    safetensorsParameters: { F8_E4M3: 600_000_000 },
    tags: ['gguf', 'safetensors', 'text-generation'],
    readme: '# Tiny mixed\n',
    files: [
      { path: 'assets/demo.mp4', size: 4096 },
      { path: 'GGUF/Tiny-Mixed-Q4_K_M.gguf', gguf: { ...llamaLikeGguf({ name: 'Tiny Mixed', sizeLabel: '0.6B' }), totalSize: 64 * 1024 } },
      { path: 'GGUF/mmproj-Tiny-F16.gguf', gguf: { metadata: { 'general.architecture': 'clip', 'general.type': 'mmproj' }, totalSize: 8 * 1024 } },
      { path: 'FP8/config.json', content: JSON.stringify({ architectures: ['Qwen3ForCausalLM'], num_hidden_layers: 4, num_attention_heads: 8, num_key_value_heads: 2, head_dim: 64, quantization_config: { quant_method: 'fp8' } }) },
      { path: 'FP8/tokenizer.json', content: '{}' },
      { path: 'FP8/model.safetensors', safetensors: { tensors: { w: { dtype: 'F8_E4M3', shape: [64, 64] } }, totalSize: 32 * 1024 } },
      { path: 'NInfer/tiny_nvfp4.ninfer', content: new Uint8Array(ARTIFACT) },
      { path: 'NInfer/Tiny.artifact-manifest.json', content: JSON.stringify({ artifact: { filename: 'tiny_nvfp4.ninfer', name: 'qwen3.8-27b', container_version: 3, components: ['text'] } }) },
      { path: 'NInfer/Tiny.SHA256SUMS', content: `${createHash('sha256').update(ARTIFACT).digest('hex')}  tiny_nvfp4.ninfer\n` },
    ],
  });
  // Enough models for two pages of results (30 per page).
  for (let i = 1; i <= 45; i++) {
    const n = String(i).padStart(2, '0');
    world.hub.addRepo({ id: `bulk/Bulk-Model-${n}-GGUF`, downloads: 1000 - i, tags: ['gguf'], files: [{ path: `Bulk-Model-${n}-Q4_K_M.gguf`, size: 1024 }] });
  }
});

test.afterAll(async () => {
  await world.close();
});

const main = (page: Page) => page.getByRole('main');
const scrollTop = (page: Page) => main(page).evaluate((el) => el.scrollTop);

test('search, scroll two pages, open a model, come back: everything is as it was', async () => {
  const gb = await launchApp({ env: world.env });
  try {
    const { page } = gb;
    await stubDesktop(gb);
    await skipWelcome(page);
    await openPage(page, 'Modelli');
    await page.getByRole('tab', { name: 'Scarica' }).click();
    const filters = page.getByRole('complementary', { name: 'Filtri' });
    await filters.getByRole('radio', { name: 'Tutti', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Cerca un modello su Hugging Face' }).fill('bulk');
    await expect(page.getByRole('heading', { name: 'Risultati per «bulk»' })).toBeVisible({ timeout: 20_000 });
    const results = page.getByRole('list', { name: 'Modelli trovati' });
    await expect(results.getByRole('listitem')).toHaveCount(30);
    // Scrolling down loads the second page by itself.
    await main(page).evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(results.getByRole('listitem')).toHaveCount(45, { timeout: 20_000 });
    const target = results.getByRole('link', { name: 'bulk/Bulk-Model-40-GGUF' });
    await target.scrollIntoViewIfNeeded();
    const before = await scrollTop(page);
    expect(before).toBeGreaterThan(200);
    await target.click();
    await expect(h1(page, 'Bulk-Model-40-GGUF')).toBeVisible();
    // A new page starts at its top.
    expect(await scrollTop(page)).toBe(0);

    // The window's own "back" (the mouse button, Alt+←).
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Risultati per «bulk»' })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Cerca un modello su Hugging Face' })).toHaveValue('bulk');
    await expect(filters.getByRole('radio', { name: 'Tutti', exact: true })).toBeChecked();
    await expect(results.getByRole('listitem')).toHaveCount(45);
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(before - 60);
    expect(await scrollTop(page)).toBeLessThan(before + 60);

    // The page's own "← Modelli" does the same.
    await results.getByRole('link', { name: 'bulk/Bulk-Model-40-GGUF' }).click();
    await expect(h1(page, 'Bulk-Model-40-GGUF')).toBeVisible();
    await main(page).getByRole('link', { name: 'Modelli', exact: true }).click();
    await expect(results.getByRole('listitem')).toHaveCount(45);
    await expect(page.getByRole('searchbox', { name: 'Cerca un modello su Hugging Face' })).toHaveValue('bulk');
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(before - 60);
  } finally {
    await gb.close();
  }
});

test('a mixed repo: formats as badges, one section per format, a GGUF download never pulls the safetensors', async () => {
  const userData = newUserData();
  // A download stopped at 1 of 4 files: listed as incomplete, never offered for a test.
  const partial = path.join(userData, 'models', 'orcarouter', 'OrcaSAQ-2-27B');
  mkdirSync(partial, { recursive: true });
  writeFileSync(path.join(partial, 'config.json'), '{"num_hidden_layers": 2}');
  writeFileSync(path.join(partial, 'model-00001-of-00004.safetensors'), buildSafetensors({ tensors: { w: { dtype: 'BF16', shape: [8, 8] } } }));
  const gb = await launchApp({ env: world.env, userData });
  try {
    const { page } = gb;
    await stubDesktop(gb);
    await skipWelcome(page);
    await openPage(page, 'Modelli');
    // The library, grouped by format.
    const vllmLibrary = page.getByRole('list', { name: 'Per vLLM / SGLang (safetensors)' });
    await expect(vllmLibrary.getByText('Incompleto · 1 di 4 file')).toBeVisible({ timeout: 20_000 });
    await expect(vllmLibrary.getByRole('button', { name: /^Fai il benchmark/ })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Scarica' }).click();
    await page.getByRole('complementary', { name: 'Filtri' }).getByRole('radio', { name: 'Tutti', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Cerca un modello su Hugging Face' }).fill('tiny-mixed');
    const row = page.getByRole('list', { name: 'Modelli trovati' }).getByRole('listitem').filter({ has: page.getByRole('link', { name: MIXED, exact: true }) });
    await expect(row.getByText('GGUF', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText('Safetensors', { exact: true })).toBeVisible();
    await expect(row.getByText('FP8', { exact: true })).toBeVisible();
    await expect(row.getByText('NInfer', { exact: true })).toBeVisible();
    await scan(page, 'catalog with formats');
    await row.getByRole('link', { name: MIXED, exact: true }).click();

    await expect(h1(page, 'Tiny-Mixed-GGUF-NInfer')).toBeVisible();
    const gguf = page.getByRole('radiogroup', { name: 'Scegli la versione da scaricare: Per llama.cpp (GGUF)' });
    const st = page.getByRole('radiogroup', { name: 'Scegli la versione da scaricare: Per vLLM / SGLang (safetensors)' });
    const ninfer = page.getByRole('radiogroup', { name: 'Scegli la versione da scaricare: Per NInfer (ottimizzato per RTX 5090)' });
    await expect(gguf.getByRole('radio', { name: /Q4_K_M/ })).toBeChecked({ timeout: 30_000 });
    await expect(st.getByRole('radio', { name: /FP8/ })).toBeChecked({ timeout: 30_000 });
    await expect(ninfer.getByRole('radio', { name: /tiny_nvfp4\.ninfer/ })).toBeVisible({ timeout: 30_000 });
    await scan(page, 'mixed model page');

    // The GGUF quant: its file and nothing else.
    await page.getByRole('button', { name: /^Scarica Q4_K_M · / }).click();
    await page.getByRole('dialog', { name: /^Scaricare Tiny-Mixed-GGUF-NInfer · Q4_K_M\?$/ }).getByRole('button', { name: /^Scarica · / }).click();
    const dest = path.join(userData, 'models', 'mixed', 'Tiny-Mixed-GGUF-NInfer');
    await expect.poll(() => existsSync(path.join(dest, 'GGUF', 'Tiny-Mixed-Q4_K_M.gguf')), { timeout: 30_000 }).toBe(true);
    // The safetensors folder: exactly its files.
    await page.getByRole('button', { name: /^Scarica FP8 · / }).click();
    await page.getByRole('dialog', { name: /^Scaricare Tiny-Mixed-GGUF-NInfer · FP8\?$/ }).getByRole('button', { name: /^Scarica · / }).click();
    await expect.poll(() => existsSync(path.join(dest, 'FP8', 'model.safetensors')), { timeout: 30_000 }).toBe(true);
    // The NInfer artifact, checked against its SHA256SUMS.
    await page.getByRole('button', { name: /^Scarica tiny_nvfp4\.ninfer · / }).click();
    await page.getByRole('dialog', { name: /^Scaricare Tiny-Mixed-GGUF-NInfer · tiny_nvfp4\.ninfer\?$/ }).getByRole('button', { name: /^Scarica · / }).click();
    await expect.poll(() => existsSync(path.join(dest, 'NInfer', 'tiny_nvfp4.ninfer')), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => existsSync(path.join(dest, 'FP8', 'tokenizer.json'))).toBe(true);
    expect(existsSync(path.join(dest, 'README.md'))).toBe(false);
    expect(existsSync(path.join(dest, 'assets'))).toBe(false);
    expect(existsSync(path.join(dest, 'GGUF', 'mmproj-Tiny-F16.gguf'))).toBe(false);

    // Back in the library: each download in its format's group.
    await page.getByRole('link', { name: 'Modelli', exact: true }).first().click();
    await page.getByRole('tab', { name: /Sul tuo PC/ }).click();
    await expect(page.getByRole('list', { name: 'Per llama.cpp (GGUF)' }).getByText('Tiny-Mixed-Q4_K_M', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(vllmLibrary.getByText(`${MIXED} · FP8`, { exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Per NInfer (RTX 5090)' }).getByText('tiny_nvfp4', { exact: true })).toBeVisible();
    await scan(page, 'library grouped by format');
    // The Benchmark page offers the model that is whole, never the one stopped halfway.
    await openPage(page, 'Benchmark');
    await page.getByRole('button', { name: /^Cambia modello:/ }).click();
    const picker = page.getByRole('dialog', { name: 'Scegli un modello' });
    await expect(picker.getByText('llama.cpp usa i modelli GGUF: qui vedi solo quelli.', { exact: false })).toBeVisible();
    await expect(picker.getByText(/OrcaSAQ/)).toHaveCount(0);
  } finally {
    await gb.close();
  }
});

test('a busy card: the verdict stays on the card, a calm note says what is free now', async () => {
  const busy = { gpus: [{ memUsedMiB: 24_000, powerW: 60, utilPct: 3, tempC: 44 }] };
  const userData = newUserData(busy);
  const gb = await launchApp({ env: world.env, userData });
  try {
    const { page } = gb;
    await stubDesktop(gb);
    await skipWelcome(page);
    const plan = page.getByRole('region', { name: 'Anteprima' });
    await expect(plan.getByText(/^Ora altri programmi usano .+ della scheda\.$/)).toBeVisible({ timeout: 30_000 });
    await expect(plan.getByText(/oppure il test partirà con meno memoria/)).toBeVisible();
    await expect(plan.getByText('Entra perfettamente')).toBeVisible();
    await expect(plan.getByText(/^Stima: .+ su 30,8 GB della scheda$/)).toBeVisible();
    await scan(page, 'busy card plan');
    await plan.getByRole('button', { name: 'Che cos’è «Come giudico la memoria»?' }).click();
    await expect(page.getByRole('tooltip').getByText(/memoria totale della scheda/)).toBeVisible();
    await page.keyboard.press('Escape');
    // The catalog says it once, on top.
    await openPage(page, 'Modelli');
    await page.getByRole('tab', { name: 'Scarica' }).click();
    await expect(page.getByText(/^Ora altri programmi usano .+ della scheda\.$/)).toBeVisible({ timeout: 20_000 });
    // The programs are closed: no note, the same verdict on the same card.
    writeFileSync(path.join(userData, 'fake-nvidia-smi.json'), JSON.stringify({ gpus: [{ memUsedMiB: 1600 }] }));
    await openPage(page, 'Benchmark');
    await page.reload();
    await expect(plan.getByText(/^Stima: .+ su 30,8 GB della scheda$/)).toBeVisible({ timeout: 30_000 });
    await expect(plan.getByText('Entra perfettamente')).toBeVisible();
    await expect(plan.getByText(/^Ora altri programmi usano/)).toHaveCount(0);
  } finally {
    await gb.close();
  }
});
