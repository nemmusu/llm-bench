import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '../fixtures';
import { launchApp } from '../fixtures';
import { answerSaveDialog, h1, scan, skipWelcome, tempFile } from './bench-helpers';

test.describe.configure({ timeout: 240_000 });

/**
 * A fake engine whose prompt reading scales with the micro-batch (×4 at -ub 2048): the second run
 * reads the context faster, the comparison says so in words.
 */
const PROFILE = JSON.stringify({ loadMsCold: 600, loadMsWarm: 300, prefillTps: 5000, decodeTps: 1500, tokensPerChunk: 4, speed: { ubatchExponent: 1 } });

test('long conversations: run them, read the cache reuse and the queue, compare two setups in words, share the sheet', async () => {
  const gb = await launchApp({ env: { FAKE_ENGINE_PROFILE: PROFILE } });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await page.getByRole('switch', { name: 'Modalità esperto' }).click();
    await page.getByRole('radio', { name: /Personalizzato/ }).click();
    await page.getByLabel('Caricamenti a freddo').fill('0');
    await page.getByLabel('Caricamenti a caldo').fill('1');
    await page.getByLabel('Lunghezze dei prompt').fill('');
    await page.getByLabel('Utenti contemporanei').fill('');
    // "2" = one conversation alone, then two at once.
    await page.getByLabel('Conversazioni lunghe insieme').fill('2');
    await page.getByLabel('Contesto di ogni conversazione (token)').fill('2048');
    await page.getByLabel('Messaggi per conversazione').fill('3');
    await expect(page.getByText(/il primo messaggio legge tutto il contesto, i successivi riusano quanto già letto/)).toBeVisible();
    await expect(page.getByText(/conversazioni lunghe da 2\.048 token: 1 e 2 alla volta, 3 messaggi ciascuna/)).toBeVisible();
    await scan(page, 'expert panel with long conversations');

    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('button', { name: 'Scarica e avvia' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('list', { name: 'Fasi del test' }).getByText('Conversazioni lunghe')).toBeVisible();
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 120_000 });

    // The result: the cache is reused from the second message, the second conversation queues.
    const section = page.getByRole('region', { name: 'Conversazioni lunghe', exact: true });
    await expect(section).toBeVisible();
    await expect(section.getByText(/^Con 1 sessione il primo messaggio aspetta .* per leggere 2\.048 token; dal secondo il server riusa il 9\d,\d% del contesto/)).toBeVisible();
    await expect(section.getByText(/^Con 2 sessioni la seconda aspetta in coda /)).toBeVisible();
    await expect(section.getByText('Contesto tenuto in memoria:')).toBeVisible();
    const table = section.getByRole('table', { name: 'Conversazioni lunghe, per numero di sessioni insieme' });
    await expect(table.getByRole('columnheader', { name: 'Attesa prima risposta a 2.048 token' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Contesto riusato (%)' })).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(3);
    // llama.cpp says how long it read: the queue is measured, not estimated.
    await expect(section.getByText(/Attesa in coda stimata/)).toHaveCount(0);
    await scan(page, 'result with long conversations');

    // Same conversations with a bigger micro-batch: the context is read faster.
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await page.getByRole('button', { name: 'Usa queste impostazioni' }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await expect(page.getByLabel('Conversazioni lunghe insieme')).toHaveValue('2');
    await expect(page.getByLabel('Contesto di ogni conversazione (token)')).toHaveValue('2048');
    await page.getByLabel('Micro-batch').fill('2048');
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 120_000 });

    // Compare the two: "Confronta" on each, then the tray; the older one is A.
    await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: 'Risultati' }).click();
    await expect(page.getByText('2 risultati')).toBeVisible();
    const toggles = page.getByRole('button', { name: /^Confronta Qwen3/ });
    await toggles.nth(0).click();
    await toggles.nth(1).click();
    await page.getByRole('region', { name: 'Da confrontare' }).getByRole('button', { name: 'Confronta', exact: true }).click();
    await expect(h1(page, 'Confronta')).toBeVisible();
    const cmp = page.getByRole('table', { name: 'Confronto misura per misura' });
    const read = cmp.getByRole('row', { name: /Lettura del contesto a 2\.048 token/ });
    await expect(read).toContainText('il più veloce');
    await expect(read).toContainText(/volte più lento/);
    await expect(cmp.getByRole('row', { name: /Attesa prima risposta a 2\.048 token/ })).toContainText(/volte più tempo|\+\d+%/);
    await expect(cmp.getByRole('row', { name: /Contesto tenuto in memoria/ })).toContainText('uguale');
    await scan(page, 'compare long conversations');

    // The sheet for the team, with the comparison.
    await page.getByRole('button', { name: 'Scheda da condividere' }).click();
    const dialog = page.getByRole('dialog', { name: 'Scheda da condividere' });
    await dialog.getByLabel('Nome del servizio').fill('Assistente E2E');
    await dialog.getByLabel('Indirizzo').fill('http://utente:password123@gpu:8080/v1');
    await scan(page, 'sheet dialog');
    const file = tempFile('scheda.md');
    await answerSaveDialog(gb, file);
    await dialog.getByRole('button', { name: 'Salva la scheda' }).click();
    await expect(page.getByText(/Scheda salvata: /)).toBeVisible();
    await expect.poll(() => (existsSync(file) ? readFileSync(file, 'utf8').length : 0)).toBeGreaterThan(500);
    const sheet = readFileSync(file, 'utf8');
    expect(sheet).toContain('# Assistente E2E: ');
    for (const heading of ['Il servizio', 'Modello e configurazione', 'Velocità e tempi di attesa', 'Il contesto si legge una volta sola', 'Come funziona la coda', 'Contesto tenuto in memoria', 'Confronto con le altre configurazioni', 'Glossario']) {
      expect(sheet).toContain(`## ${heading}`);
    }
    expect(sheet).toMatch(/\| Lettura del contesto a 2\.048 token \| .* \| .* \| B · Qwen3-0\.6B.*: \d+(,\d)? volte più veloce \|/);
    expect(sheet).toContain('(questa scheda)');
    expect(sheet).toContain('http://gpu:8080/v1');
    expect(sheet).not.toContain('password123');
    expect(sheet).toContain('llama-server');
  } finally {
    await gb.close();
  }
});
