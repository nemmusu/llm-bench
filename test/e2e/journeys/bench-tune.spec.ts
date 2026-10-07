import { TUNE_PROFILE } from '../../fakes/fake-engine/profiles.mjs';
import { expect, launchApp, test } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';

// A 'fast' search against the fake engine: 14 launches, about half a minute.
test.describe.configure({ timeout: 240_000 });

test('find the best settings: watch the attempts, read the ranking, use the winner', async () => {
  const gb = await launchApp({ env: { FAKE_ENGINE_PROFILE: JSON.stringify(TUNE_PROFILE) } });
  try {
    const { page } = gb;
    await skipWelcome(page);

    // One more choice next to Rapido / Standard / Completo, said plainly.
    await page.getByRole('radio', { name: /Trova le impostazioni migliori/ }).click();
    await expect(page.getByText(/Provo da solo le impostazioni/)).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Veloce ~5 min' })).toBeChecked();
    await scan(page, 'benchmark with the tune profile');
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('dialog', { name: 'Prima di iniziare scarico quello che manca' }).getByRole('button', { name: 'Scarica e avvia' }).click();

    // The live screen: every launch as it happens, the configuration in use, the measurements so far.
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    const steps = page.getByRole('list', { name: 'Fasi del test' });
    await expect(steps.getByText('Contesto massimo')).toBeVisible();
    await expect(steps.getByText('Impostazioni')).toBeVisible();
    const attempts = page.getByRole('table', { name: 'Prove fatte' });
    await expect(attempts.getByText('Caricato').first()).toBeVisible({ timeout: 60_000 });
    await expect(attempts.getByText('Memoria esaurita').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Configurazione del server' })).toBeVisible();
    await expect(page.getByText(/cache KV (f16|q8_0|q4_0)/).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Misure finora' })).toBeVisible();
    await scan(page, 'live tune run');

    // The result: one sentence from the numbers, the recommended combination, the ranking.
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 180_000 });
    await expect(page.getByText(/Con cache q4_0 arrivi a 40K/)).toBeVisible();
    const recommended = page.getByRole('region', { name: 'Combinazione consigliata' });
    await expect(recommended.getByText(/Cache KV q4_0 · flash attention · ub 2048/)).toBeVisible();

    const ranking = page.getByRole('table', { name: /^Classifica delle combinazioni a/ });
    await expect(ranking).toHaveAccessibleName('Classifica delle combinazioni a 16K');
    const q4 = ranking.getByRole('row', { name: /^Cache KV q4_0/ });
    await expect(q4.getByText('Consigliata')).toBeVisible();
    await expect(q4.getByRole('cell', { name: '40K', exact: true })).toBeVisible();
    // Up to 16K the most precise cache is the fastest.
    await expect(ranking.getByRole('row').nth(1)).toContainText('Cache KV f16');

    // Compared at 32K, where f16 no longer fits: another winner, and f16 says how far it gets.
    await page.getByRole('radiogroup', { name: 'Confronta a' }).getByRole('radio', { name: '32K' }).click();
    await expect(ranking).toHaveAccessibleName('Classifica delle combinazioni a 32K');
    await expect(ranking.getByRole('row').nth(1)).toContainText('Cache KV q8_0');
    await expect(ranking.getByRole('row').last()).toContainText('arriva solo a 16K');

    // Every number traces back to its measurements and the exact command.
    await q4.getByRole('button', { name: 'Misure' }).click();
    await expect(page.getByRole('table', { name: /^Misure di Cache KV q4_0/ })).toBeVisible();
    await expect(page.getByRole('region', { name: /^Comando di Cache KV q4_0/ })).toContainText('llama-server');

    await page.getByRole('button', { name: /Prove scartate/ }).click();
    await expect(page.getByText('Memoria esaurita').first()).toBeVisible();
    await expect(page.getByText('Usa la RAM condivisa (lento)').first()).toBeVisible();
    await expect(page.getByRole('table', { name: 'Contesto massimo per tipo di cache' })).toContainText('q4_0');
    await scan(page, 'tune result');

    // The winner, one click away: back on Benchmark with its settings filled in.
    await q4.getByRole('button', { name: 'Usa questo preset' }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await expect(page.getByText('Preset copiato nel Benchmark')).toBeVisible();
    await expect(page.getByLabel('Contesto (token)')).toHaveValue('40960');
    await expect(page.getByLabel('Micro-batch')).toHaveValue('2048');
    await expect(page.getByRole('region', { name: 'Anteprima comando' })).toContainText('q4_0');
  } finally {
    await gb.close();
  }
});
