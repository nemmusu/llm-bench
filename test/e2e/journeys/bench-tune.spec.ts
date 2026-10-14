import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MULTI_PROFILE, TUNE_PROFILE } from '../../fakes/fake-engine/profiles.mjs';
import { expect, launchApp, ROOT, test } from '../fixtures';
import { goToHash } from '../ui/helpers';
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
    await expect(page.getByRole('radio', { name: /^Veloce/ })).toBeChecked();
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
    // The quick check after every start is said once, in the header; a speed measured elsewhere says where.
    await expect(attempts.getByRole('columnheader', { name: /^Generazione \(tok\/s\) a 1K/ })).toBeVisible();
    await expect(attempts.getByRole('columnheader', { name: /^Contesto all’avvio/ })).toBeVisible();
    await expect(attempts.getByText(/^a [\d,]+K, contesto pieno$/).first()).toBeVisible({ timeout: 60_000 });
    // The page uses the window: the table never scrolls sideways; the caches go below it on a normal
    // window and beside it on a big one.
    const region = page.getByRole('region', { name: 'Prove fatte' });
    const capacity = page.getByRole('heading', { name: 'Contesto massimo per cache' });
    for (const [width, beside] of [
      [1024, false],
      [1366, false],
      [1920, true],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => region.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      const table = (await region.boundingBox())!;
      const side = (await capacity.boundingBox())!;
      expect({ width, beside: side.x > table.x + table.width, below: side.y > table.y + table.height }).toEqual({ width, beside, below: !beside });
    }
    await expect(page.getByRole('heading', { name: 'Configurazione del server' })).toBeVisible();
    await expect(page.getByText(/cache KV (f16|q8_0|q4_0)/).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Misure finora' })).toBeVisible();
    // Every launch's engine start, stage by stage: where the loading time goes.
    await expect(page.getByText(/^pronto in \d+:\d\d$/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Fasi dell’avvio e quanto sono durate' })).toContainText('Pesi');
    await scan(page, 'live tune run');

    // The result: one sentence from the numbers, the recommended combination, the ranking.
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 180_000 });
    await expect(page.getByText(/Con cache q4_0 arrivi a 40K/)).toBeVisible();
    const recommended = page.getByRole('region', { name: 'Combinazione consigliata' });
    await expect(recommended.getByText(/Cache KV q4_0 · flash attention · ub 2048/)).toBeVisible();

    // Every combination with its own largest context full, the largest context first.
    const ranking = page.getByRole('table', { name: /^Classifica delle combinazioni a/ });
    await expect(ranking).toHaveAccessibleName('Classifica delle combinazioni al contesto massimo');
    await expect(ranking.getByRole('columnheader', { name: /^Generazione \(tok\/s\) al contesto massimo/ })).toBeVisible();
    const q4 = ranking.getByRole('row', { name: /^Cache KV q4_0/ });
    await expect(q4.getByText('Consigliata')).toBeVisible();
    await expect(q4.getByRole('cell', { name: '40K', exact: true })).toBeVisible();
    // The recommendation on top, with the best generation among those with its context (within the
    // noise of a busy PC they all count as best).
    const first = ranking.getByRole('row').nth(1);
    await expect(first.getByRole('cell').nth(0)).toHaveText('1');
    await expect(first.getByRole('cell').nth(2)).toContainText('il migliore');
    await expect(ranking.getByRole('row')).toHaveCount(4);

    // Compared at 32K, where f16 no longer fits: it drops to the bottom and says how far it gets.
    await page.getByRole('radiogroup', { name: 'Confronta a' }).getByRole('radio', { name: '32K' }).click();
    await expect(ranking).toHaveAccessibleName('Classifica delle combinazioni a 32K');
    await expect(ranking.getByRole('row').nth(1)).not.toContainText('Cache KV f16');
    await expect(ranking.getByRole('row').last()).toContainText('Cache KV f16');
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
    await expect(page.getByText('Impostazioni copiate nel Benchmark')).toBeVisible();
    await expect(page.getByLabel('Contesto (token)')).toHaveValue('40960');
    await expect(page.getByLabel('Micro-batch')).toHaveValue('2048');
    await expect(page.getByRole('region', { name: 'Anteprima comando' })).toContainText('q4_0');

    // Risultati → Configurazioni: every combination at its own largest context, with the context full.
    await page.getByRole('link', { name: 'Risultati' }).click();
    await page.getByRole('tab', { name: 'Configurazioni' }).click();
    const configs = page.getByRole('table', { name: 'Configurazioni provate' });
    await expect(page.getByRole('combobox', { name: 'Confronta a' })).toContainText('Contesto massimo');
    await expect(page.getByRole('columnheader', { name: /Generazione/ })).toContainText('al contesto massimo');
    const winner = configs.getByRole('row', { name: /q4_0.*ub 2048/ });
    await expect(winner).toContainText('40.960');
    await expect(winner).not.toContainText('non misurata');
  } finally {
    await gb.close();
  }
});

test('a NInfer search saved before the context full was measured reads at the largest context, and says why the time ran out', async () => {
  // The real run of the report (sanitized): 256K launched, nothing measured beyond 64K, each start ~1,5 min.
  const id = '01M4X46BTJW9EH2YHE32Q7N9ZM';
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-tune-'));
  mkdirSync(path.join(userData, 'results'), { recursive: true });
  copyFileSync(path.join(ROOT, 'test', 'fixtures', 'runs', 'tune', `2026-10-14_11-54-04_${id}.json`), path.join(userData, 'results', `2026-10-14_11-54-04_${id}.json`));
  const gb = await launchApp({ userData });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await goToHash(page, `#/results/${id}`);
    await expect(h1(page, /Qwen3\.8-27B/)).toBeVisible();
    await expect(page.getByText(/Al contesto massimo \(256K\) la velocità non è stata misurata\. Misurata solo fino a 64K/)).toBeVisible();
    await expect(page.getByText('Ogni avvio del motore ha richiesto in media 1 min 36 s.')).toBeVisible();
    const recommended = page.getByRole('region', { name: 'Combinazione consigliata' });
    await expect(recommended.getByText('non misurata')).toHaveCount(3);
    await expect(recommended.getByText('Misurata solo fino a 64K (tempo finito): rifai la ricerca per avere la velocità a 256K.')).toBeVisible();
    const ranking = page.getByRole('table', { name: 'Classifica delle combinazioni al contesto massimo' });
    await expect(ranking.getByText('non misurata a 256K')).toHaveCount(2);
    await expect(ranking.getByText(/arriva solo/)).toHaveCount(0);
    const capacity = page.getByRole('table', { name: 'Contesto massimo per tipo di cache' });
    await expect(capacity.getByRole('row').filter({ hasText: 'int8' })).toContainText('Almeno 128K: a 236K non entra più, in mezzo non provato.');
    await expect(capacity.getByRole('row').filter({ hasText: 'nvfp4' })).toContainText('Arriva al contesto massimo del modello.');
    await expect(page.getByText('Flash attention', { exact: true })).toHaveCount(0);
    await scan(page, 'tune result of an older NInfer search');
  } finally {
    await gb.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('"Più utenti", only 2 users at once: no lower levels, the phases and the result say so', async () => {
  const gb = await launchApp({ env: { FAKE_ENGINE_PROFILE: JSON.stringify(MULTI_PROFILE) } });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await page.getByRole('radio', { name: /Trova le impostazioni migliori/ }).click();
    await page.getByRole('radio', { name: 'Più utenti' }).click();
    await page.getByRole('textbox', { name: 'Utenti insieme' }).fill('2');
    await expect(page.getByRole('radio', { name: 'Da 1 a 2 utenti' })).toBeChecked();
    await page.getByRole('radio', { name: 'Solo 2 utenti insieme' }).click();
    await scan(page, 'benchmark, several users, only N');
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('dialog', { name: 'Prima di iniziare scarico quello che manca' }).getByRole('button', { name: 'Scarica e avvia' }).click();

    // The live screen lists the phases of this search, in its own words (no users 1 … N phase).
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    const steps = page.getByRole('list', { name: 'Fasi del test' });
    await expect(steps.getByText('Utenti che ci stanno')).toBeVisible();
    await expect(steps.getByText('Impostazioni')).toBeVisible();
    await expect(steps.getByText('Più utenti')).toHaveCount(0);
    await expect(steps.getByText('Contesto per gradi')).toHaveCount(0);

    // The result: every configuration with 2 users at once only.
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 180_000 });
    await expect(page.getByText(/^Con 2 utenti da 8K a testa la più veloce per utente è/)).toBeVisible();
    const ranking = page.getByRole('table', { name: 'Classifica delle configurazioni con 2 utenti' });
    await ranking.getByRole('button', { name: 'Misure' }).first().click();
    const measures = page.getByRole('table', { name: /^Utenti insieme con / });
    await expect(measures.getByRole('row')).toHaveCount(2);
    await expect(measures.getByRole('row').nth(1).getByRole('rowheader')).toHaveText('2');
    await expect(page.getByText(/^Solo 2 utenti insieme, un messaggio a testa\./)).toBeVisible();
    await scan(page, 'tune result, only 2 users at once');
  } finally {
    await gb.close();
  }
});
