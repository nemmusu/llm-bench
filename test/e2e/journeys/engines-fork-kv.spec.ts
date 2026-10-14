/**
 * A llama.cpp fork with its own KV caches, as a person meets it: added on the Engines page (the fake
 * engine as a TurboQuant-like fork: its --help lists turbo4, turbo3, turbo2, turbo1.5, turbo3_tcq), its
 * check names them, the Benchmark's expert mode offers them with their size, and a test with turbo3
 * runs with -ctk turbo3 -ctv turbo3.
 */
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, launchApp, ROOT, test } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';
import { openPage, startLibraryWorld, stubDesktop, type LibraryWorld } from './library-helpers';

test.describe.configure({ timeout: 180_000 });

const TURBO = path.join(ROOT, 'test', 'fakes', 'fake-engine', 'turbo.mjs');

let world: LibraryWorld;

test.beforeAll(async () => {
  world = await startLibraryWorld();
});

test.afterAll(async () => {
  await world.close();
});

/** A run that finished: the result page opens by itself. */
async function waitForResult(page: Page, model: RegExp): Promise<void> {
  await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 60_000 });
  await expect(h1(page, model)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Completato', { exact: true })).toBeVisible();
}

test('a fork with its own KV caches: detected by its check, offered in expert mode, benchmarked with turbo3', async () => {
  const gb = await launchApp({ env: world.env });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await stubDesktop(gb, TURBO);
    await openPage(page, 'Motori');
    await page.getByRole('button', { name: 'Aggiungi motore' }).click();
    const dialog = page.getByRole('dialog', { name: 'Aggiungi un motore' });
    await dialog.getByRole('radio', { name: /Fork di llama\.cpp/ }).click();
    await dialog.getByRole('button', { name: 'Avanti' }).click();
    await dialog.getByLabel('Nome').fill('TurboQuant');
    await dialog.getByRole('button', { name: 'Scegli file…' }).click();
    await expect(dialog.getByLabel('Il programma llama-server')).toHaveValue(TURBO);
    await dialog.getByRole('button', { name: 'Prova' }).click();
    await expect(dialog.getByText('Funziona · versione b7001')).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText('Cache KV in più rispetto a llama.cpp: turbo4, turbo3, turbo2, turbo1.5, turbo3_tcq')).toBeVisible();
    await scan(page, 'add engine: a fork with its own KV caches');
    await dialog.getByRole('button', { name: 'Avanti' }).click();
    await dialog.getByRole('button', { name: 'Salva motore' }).click();
    await expect(dialog).toBeHidden();

    const card = page.getByRole('region', { name: 'TurboQuant' });
    await expect(card.getByText('Funziona come llama.cpp')).toBeVisible();
    await card.getByRole('button', { name: 'Usa nel Benchmark' }).click();

    // The Benchmark: expert mode lists the fork's caches with their size.
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Cambia motore' })).toContainText('llama.cpp · TurboQuant');
    await page.getByRole('switch', { name: 'Modalità esperto' }).click();
    await page.getByRole('combobox', { name: 'Tipo di cache KV' }).click();
    const turbo3 = page.getByRole('option', { name: /^turbo3\b/ }).first();
    await expect(turbo3).toContainText('3,125 bit per valore');
    await expect(page.getByRole('option', { name: /^turbo1\.5/ })).toContainText('2 bit per valore');
    await turbo3.click();
    const command = page.getByRole('region', { name: 'Anteprima comando' });
    await expect(command).toContainText('-ctk turbo3 -ctv turbo3', { timeout: 30_000 });
    await expect(command).toContainText('-fa on');
    await scan(page, 'benchmark with a fork’s KV cache');
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await waitForResult(page, /Qwen3-0\.6B-Q4_K_M/);
    await expect(page.getByText(/TurboQuant b7001/).first()).toBeVisible();
    await scan(page, 'result with turbo3');
  } finally {
    await gb.close();
  }
});
