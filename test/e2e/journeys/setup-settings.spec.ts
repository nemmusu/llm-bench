import type { Page } from '@playwright/test';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, launchApp, test } from '../fixtures';
import { h1, newUserData, openPage, opened, scan, skipWelcome, startLibraryWorld, stubDesktop, type LibraryWorld } from './library-helpers';

test.describe.configure({ timeout: 150_000 });

/** Best effort: Windows may keep a just-closed app's folder busy for a moment. */
function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* left in the temp folder */
    }
  }
}

/**
 * "Misure a freddo reali". Windows: an opt-in, its explanation first (never confirmed here: it would
 * show a real UAC prompt). Linux: the model file leaves the page cache without special rights, so there
 * is nothing to turn on.
 */
async function checkColdMeasurements(page: Page): Promise<void> {
  const cold = page.getByRole('switch', { name: 'Misure a freddo reali' });
  if (process.platform !== 'win32') {
    await expect(page.getByText('Su Linux lo faccio da solo, senza permessi speciali.')).toBeVisible();
    await expect(cold).toHaveCount(0);
    return;
  }
  await expect(cold).toBeVisible();
  await cold.click();
  const ask = page.getByRole('alertdialog', { name: 'Attivare le misure a freddo reali?' });
  await expect(ask.getByText(/«PurgeStandby» di LLM Bench/)).toBeVisible();
  await scan(page, 'cold measurements explanation');
  await ask.getByRole('button', { name: 'Annulla' }).click();
  await expect(cold).not.toBeChecked();
}

let world: LibraryWorld;

test.beforeAll(async () => {
  world = await startLibraryWorld();
});

test.afterAll(async () => {
  await world.close();
});

test('settings survive a restart: appearance, options, folders, Hugging Face token', async () => {
  const userData = newUserData();
  // A "shared" folder somewhere else on the disk (like a synced OneDrive folder).
  const shared = path.join(newUserData(), 'shared-results');
  try {
    let gb = await launchApp({ userData, env: world.env });
    let page = gb.page;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubDesktop(gb, shared);
    await skipWelcome(page);
    await openPage(page, 'Impostazioni');
    await scan(page, 'settings');
    await page.getByRole('radio', { name: 'Scuro' }).click();
    await page.getByRole('radio', { name: 'Compatta' }).click();
    await page.getByRole('switch', { name: 'Modalità esperto' }).click();
    await page.getByRole('combobox', { name: 'Letture della GPU durante i test' }).click();
    await page.getByRole('option', { name: '2 al secondo' }).click();
    await page.getByRole('button', { name: 'Scegli cartella… Cartella dei risultati' }).click();
    await expect(page.getByText(shared, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Aggiungi cartella' }).click();
    await expect(page.getByRole('list', { name: 'Altre cartelle con modelli' }).getByText(shared)).toBeVisible();
    await page.getByLabel('Token di accesso').fill('hf_test_token');
    await page.getByRole('button', { name: 'Salva' }).click();
    await expect(page.getByText(/^Salvato/)).toBeVisible();
    await expect(page.getByLabel('Token di accesso')).toHaveCount(0);
    await scan(page, 'settings changed (dark, compact)');
    await checkColdMeasurements(page);
    // About: credits open in the browser.
    await page.getByRole('button', { name: 'llmfit' }).click();
    await expect.poll(() => opened(gb)).toEqual(['https://github.com/AlexsJones/llmfit']);
    await gb.close();

    gb = await launchApp({ userData, env: world.env });
    page = gb.page;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await openPage(page, 'Impostazioni');
    await expect(page.getByRole('radio', { name: 'Scuro' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Compatta' })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Modalità esperto' })).toBeChecked();
    await expect(page.getByRole('combobox', { name: 'Letture della GPU durante i test' })).toHaveText('2 al secondo');
    await expect(page.getByText(shared, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('list', { name: 'Altre cartelle con modelli' }).getByText(shared)).toBeVisible();
    await expect(page.getByText(/^Salvato/)).toBeVisible();
    // Remove the token and the extra folder.
    await page.getByRole('button', { name: 'Rimuovi' }).click();
    await expect(page.getByLabel('Token di accesso')).toBeVisible();
    await page.getByRole('button', { name: `Togli ${shared}` }).click();
    await expect(page.getByRole('list', { name: 'Altre cartelle con modelli' })).toHaveCount(0);
    await gb.close();

    gb = await launchApp({ userData, env: world.env });
    page = gb.page;
    await openPage(page, 'Impostazioni');
    await expect(page.getByLabel('Token di accesso')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Altre cartelle con modelli' })).toHaveCount(0);
    await gb.close();
  } finally {
    cleanup(userData, path.dirname(shared));
  }
});

test('language switch: setup and library screens speak English', async () => {
  const gb = await launchApp({ env: world.env });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByText('Controllo del sistema').first()).toBeVisible();
    await page.getByRole('button', { name: 'Salta, lo farò dopo' }).click();
    await openPage(page, 'Impostazioni');
    await page.getByRole('combobox', { name: 'Lingua' }).click();
    await page.getByRole('option', { name: 'English' }).click();
    await expect(h1(page, 'Settings')).toBeVisible();
    await expect(page.getByText('Real cold measurements')).toBeVisible();
    await scan(page, 'settings in English');
    await openPage(page, 'Models');
    await expect(page.getByRole('tab', { name: /On your PC/ })).toBeVisible();
    await page.getByRole('tab', { name: 'Download' }).click();
    await expect(page.getByRole('heading', { name: 'Trending on Hugging Face' })).toBeVisible();
    await page.getByRole('radio', { name: /^Recommended/ }).click();
    await expect(page.getByRole('heading', { name: 'Recommended for your GPU' })).toBeVisible();
    await scan(page, 'models in English');
    await openPage(page, 'Engines');
    const check = page.getByRole('region', { name: 'System check' });
    await expect(check.getByText('NVIDIA driver')).toBeVisible({ timeout: 20_000 });
    await scan(page, 'engines in English');
    await openPage(page, 'GPU monitor');
    await expect(page.getByText('Other programs using the GPU')).toBeVisible();
    await scan(page, 'monitor in English');
    await page.getByRole('button', { name: 'Downloads and installs' }).click();
    await expect(page.getByRole('dialog', { name: 'Downloads and installs' }).getByRole('heading', { name: 'No downloads' })).toBeVisible();
    await scan(page, 'downloads panel in English');
  } finally {
    await gb.close();
  }
});

test('GPU monitor: live values every second and the other programs using the GPU', async () => {
  const userData = newUserData({
    gpus: [{ memUsedMiB: 4096, powerW: 61, utilPct: 7, tempC: 44, smMHz: 1200, throttle: '0x0000000000000004' }],
    apps: [
      { pid: 4242, name: 'llama-server.exe', usedMiB: 3000 },
      { pid: 4343, name: 'Steam.exe', usedMiB: null },
    ],
  });
  const gb = await launchApp({ userData, env: world.env });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await openPage(page, 'Monitor GPU');
    const tiles = page.getByRole('region', { name: 'Valori dal vivo' });
    await expect(tiles.getByText('4,0', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('limite di potenza')).toBeVisible();
    const users = page.getByRole('list', { name: 'Altri programmi che usano la GPU' });
    await expect(users.getByText('llama-server.exe')).toBeVisible({ timeout: 20_000 });
    await expect(users.getByText('Steam.exe')).toBeVisible();
    await expect(page.getByText(/possono falsare i risultati/)).toBeVisible();
    await scan(page, 'monitor');
    // The card's memory changes: the tile follows within a couple of seconds.
    writeFileSync(path.join(userData, 'fake-nvidia-smi.json'), JSON.stringify({ gpus: [{ memUsedMiB: 8192, powerW: 300, utilPct: 95, tempC: 60 }], apps: [] }));
    await expect(tiles.getByText('8,0', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(tiles.getByText('95', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Mostra tabella' }).first().click();
    await expect(page.getByRole('table', { name: 'Dati del grafico «Utilizzo (%)»' })).toBeVisible();
    await scan(page, 'monitor table');
  } finally {
    await gb.close();
    cleanup(userData);
  }
});
