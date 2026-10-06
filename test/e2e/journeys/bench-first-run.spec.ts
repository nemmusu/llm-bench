import { expect, test } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';

test.describe.configure({ timeout: 120_000 });

test('first benchmark: install llama.cpp inline, watch it run, read the result', async ({ gb }) => {
  const { page } = gb;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await skipWelcome(page);

  // The seeded model is already chosen; llama.cpp is not installed yet.
  await expect(page.getByRole('button', { name: /Cambia modello: Qwen3 0\.6B/ })).toBeVisible();
  await expect(page.getByText(/Verrà installato prima del test/).first()).toBeVisible();
  await expect(page.getByRole('radio', { name: /Rapido/ })).toBeChecked();
  // The preview is complete before the install: what is prepared first, and the exact command.
  await expect(page.getByText('· verrà installato prima del test')).toBeVisible();
  await page.getByRole('button', { name: /Anteprima comando/ }).click();
  await expect(page.getByText('llama.cpp non è ancora installato: il comando usa già la cartella dove lo installerò prima del test.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Anteprima comando' })).toContainText('Qwen3-0.6B-Q4_K_M.gguf');
  await scan(page, 'benchmark home');

  await page.getByRole('button', { name: 'Avvia benchmark' }).click();
  const confirm = page.getByRole('dialog', { name: 'Prima di iniziare scarico quello che manca' });
  await expect(confirm.getByText('Installo llama.cpp')).toBeVisible();
  await scan(page, 'needs confirmation');
  await confirm.getByRole('button', { name: 'Scarica e avvia' }).click();

  // The live screen: phases, gauges, log.
  await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('list', { name: 'Fasi del test' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Installazione' })).toBeVisible();
  await scan(page, 'live run');

  // The result opens by itself when the run is over.
  await expect(h1(page, /Qwen3-0\.6B-Q4_K_M/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Completato', { exact: true })).toBeVisible();
  const kpis = page.getByRole('region', { name: 'Numeri principali' });
  await expect(kpis.getByText('Generazione')).toBeVisible();
  await expect(page.getByText(/Scrive circa \d+ parole al secondo/)).toBeVisible();
  await scan(page, 'result overview');

  await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
  await expect(page.getByText('tutto in GPU')).toBeVisible();
  await page.getByRole('button', { name: 'Mostra comando' }).click();
  await expect(page.getByRole('region', { name: 'Comando' })).toContainText('llama-server');
  await page.getByRole('button', { name: 'Copia il comando' }).click();
  await expect(page.getByText('Comando copiato').first()).toBeVisible();
  await scan(page, 'result launch tab');

  // The new run is in the history and on the home page.
  await page.getByRole('link', { name: 'Tutti i risultati' }).click();
  await expect(h1(page, 'Risultati')).toBeVisible();
  await expect(page.getByRole('link', { name: /Qwen3-0\.6B-Q4_K_M/ })).toBeVisible();
});
