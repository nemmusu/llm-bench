import type { Page } from '@playwright/test';
import { expect, launchApp, test } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';

test.describe.configure({ timeout: 240_000 });

/** A fast fake engine: a short custom test takes a few seconds. */
const FAST = JSON.stringify({ loadMsCold: 600, loadMsWarm: 200, prefillTps: 20000, decodeTps: 1500, tokensPerChunk: 4 });

/** A short custom test (one warm load, prompts of 256 and 1024 tokens, nobody in parallel) with this micro-batch. */
async function shortPlan(page: Page, ubatch: string): Promise<void> {
  await page.getByRole('radio', { name: /Personalizzato/ }).click();
  await page.getByLabel('Caricamenti a freddo').fill('0');
  await page.getByLabel('Caricamenti a caldo').fill('1');
  await page.getByLabel('Lunghezze dei prompt').fill('256, 1024');
  await page.getByLabel('Token generati').fill('32');
  await page.getByLabel('Ripetizioni', { exact: true }).fill('1');
  await page.getByLabel('Utenti contemporanei').fill('');
  await page.getByLabel('Micro-batch').fill(ubatch);
}

test('two settings of one model, compared by configuration; a preset back to the Benchmark page and to a server', async () => {
  const gb = await launchApp({ env: { FAKE_ENGINE_PROFILE: FAST } });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await page.getByRole('switch', { name: 'Modalità esperto' }).click();

    // First test: micro-batch 256 (llama.cpp is installed first).
    await shortPlan(page, '256');
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('button', { name: 'Scarica e avvia' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 90_000 });

    // Second test: the same model with micro-batch 1024.
    await page.getByRole('link', { name: 'Benchmark' }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await shortPlan(page, '1024');
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 90_000 });

    // Risultati → Configurazioni: one row per setting, fastest first.
    await page.getByRole('link', { name: 'Tutti i risultati' }).click();
    await page.getByRole('tab', { name: 'Configurazioni' }).click();
    const configs = page.getByRole('table', { name: 'Configurazioni provate' });
    await expect(configs.getByRole('row')).toHaveCount(3);
    await expect(configs.getByText('ub 256', { exact: true })).toBeVisible();
    await expect(configs.getByText('ub 1024', { exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Generazione/ })).toHaveAttribute('aria-sort', 'descending');
    const decodeOf = async (row: number) => Number((await configs.getByRole('row').nth(row).getByRole('cell').nth(3).innerText()).replace(/\./g, '').replace(',', '.'));
    expect(await decodeOf(1)).toBeGreaterThanOrEqual(await decodeOf(2));
    await expect(page.getByRole('combobox', { name: 'Confronta a' })).toContainText('256 token');
    await scan(page, 'results by configuration');

    // Compared at 1K tokens of prompt.
    await page.getByRole('combobox', { name: 'Confronta a' }).click();
    await page.getByRole('option', { name: '1K token' }).click();
    await expect(page.getByRole('combobox', { name: 'Confronta a' })).toContainText('1K token');

    // The test behind a configuration.
    const big = configs.getByRole('row', { name: /ub 1024/ });
    await big.getByRole('button', { name: /^Mostra il test di Qwen3-0\.6B/ }).click();
    const tests = page.getByRole('dialog', { name: 'Test di questa configurazione' });
    await expect(tests.getByRole('columnheader', { name: /Generazione a 1K/ })).toBeVisible();
    await expect(tests.getByRole('link')).toHaveCount(1);
    await scan(page, 'tests of a configuration');
    await tests.getByRole('button', { name: 'Chiudi' }).click();

    // "Usa questo preset": the Benchmark page with where it came from, the settings and the exact command.
    await big.getByRole('button', { name: 'Usa questo preset' }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();
    const banner = page.getByRole('region', { name: 'Preset' });
    await expect(banner).toContainText('Preset da «Qwen3-0.6B-Q4_K_M»');
    await expect(banner).toContainText('tok/s a 1K');
    await expect(page.getByLabel('Micro-batch')).toHaveValue('1024');
    await expect(page.getByRole('region', { name: 'Anteprima comando' })).toContainText('-ub 1024');
    await scan(page, 'benchmark with a preset');
    await banner.getByRole('button', { name: 'Chiudi il preset' }).click();
    await expect(banner).toBeHidden();

    // "Avvia il server così" from the list: the server confirmation.
    await page.getByRole('link', { name: 'Risultati' }).click();
    await page.getByRole('tab', { name: 'Configurazioni' }).click();
    await configs.getByRole('row', { name: /ub 256/ }).getByRole('button', { name: 'Avvia il server così' }).click();
    const serve = page.getByRole('dialog', { name: 'Avvia il server' });
    await expect(serve).toBeVisible({ timeout: 30_000 });
    await expect(serve.getByRole('region', { name: 'Comando esatto' })).toContainText('-ub 256');
    await serve.getByRole('button', { name: 'Annulla' }).click();
    await expect(serve).toBeHidden();
  } finally {
    await gb.close();
  }
});
