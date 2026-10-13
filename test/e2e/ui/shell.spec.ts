import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, launchApp, test } from '../fixtures';
import { currentTheme, h1, openPalette, PAGES, skipWelcome } from './helpers';

test('first launch shows the welcome wizard, with the core version', async ({ gb }) => {
  const { page } = gb;
  await expect(h1(page, 'Benvenuto in GPU Bench')).toBeVisible();
  await expect(page.getByText('Controllo del sistema').first()).toBeVisible();
  await expect(page.getByLabel(/^Versione /)).toHaveText(/^v\d+\.\d+\.\d+$/);
  await page.getByRole('button', { name: 'Continua' }).click();
  await expect(page.getByRole('heading', { name: 'Configurazione consigliata', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Usa questa configurazione' }).click();
  await page.getByRole('button', { name: 'Vai al Benchmark' }).click();
  await expect(h1(page, 'Benchmark')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Avvia benchmark' })).toBeVisible();
});

test('every sidebar item opens its page', async ({ gb }) => {
  const { page } = gb;
  await skipWelcome(page);
  const nav = page.getByRole('navigation', { name: 'Navigazione principale' });
  for (const [link, heading] of PAGES.it) {
    await nav.getByRole('link', { name: link }).click();
    await expect(h1(page, heading)).toBeVisible();
    await expect(nav.getByRole('link', { name: link })).toHaveAttribute('aria-current', 'page');
  }
});

test('the sidebar works with the keyboard only', async ({ gb }) => {
  const { page } = gb;
  await skipWelcome(page);
  const nav = page.getByRole('navigation', { name: 'Navigazione principale' });
  const first = nav.getByRole('link', { name: 'Benchmark' });
  // Tab from the top of the document until the first sidebar link has focus.
  // Start from the top of a fresh window: skip link → title bar → sidebar.
  await page.reload();
  await expect(h1(page, 'Benchmark')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Vai al contenuto' })).toBeFocused();
  for (let i = 0; i < 6; i++) {
    if (await first.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(nav.getByRole('link', { name: 'Server' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(nav.getByRole('link', { name: 'Risultati' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(h1(page, 'Risultati')).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(nav.getByRole('link', { name: 'Motori' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(h1(page, 'Motori')).toBeVisible();
});

test('the command palette opens with Ctrl+K and navigates', async ({ gb }) => {
  const { page } = gb;
  await skipWelcome(page);
  await openPalette(page);
  await page.getByRole('combobox').fill('Modelli');
  await page.keyboard.press('Enter');
  await expect(h1(page, 'Modelli')).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Apri la palette dei comandi' }).click();
  await page.getByRole('option', { name: 'Avvia benchmark' }).click();
  await expect(h1(page, 'Benchmark')).toBeVisible();
});

test('the theme toggle switches light and dark', async ({ gb }) => {
  const { page } = gb;
  await skipWelcome(page);
  const before = await currentTheme(page);
  await page.getByRole('button', { name: 'Cambia tema' }).click();
  await expect.poll(() => currentTheme(page)).not.toBe(before);
  await page.getByRole('button', { name: 'Cambia tema' }).click();
  await expect.poll(() => currentTheme(page)).toBe(before);
});

test('the language switches to English and back, and survives a restart', async () => {
  // Our own profile folder: launchApp() only deletes the folders it created itself.
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-lang-'));
  const first = await launchApp({ userData });
  try {
    await skipWelcome(first.page);
    await openPalette(first.page);
    await first.page.getByRole('option', { name: 'Switch to English' }).click();
    const nav = first.page.getByRole('navigation', { name: 'Main navigation' });
    for (const [link] of PAGES.en) await expect(nav.getByRole('link', { name: link })).toBeVisible();
    await expect(h1(first.page, 'Benchmark')).toBeVisible();
    await expect(first.page.getByRole('button', { name: 'Start benchmark' })).toBeVisible();
    await first.close();

    const second = await launchApp({ userData });
    try {
      await expect(second.page.getByRole('button', { name: 'Start benchmark' })).toBeVisible();
      await second.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Settings' }).click();
      await expect(h1(second.page, 'Settings')).toBeVisible();
      await openPalette(second.page);
      await second.page.getByRole('option', { name: 'Passa all’italiano' }).click();
      await expect(h1(second.page, 'Impostazioni')).toBeVisible();
    } finally {
      await second.close();
    }
  } finally {
    // Windows may hold the profile for a while after Electron exits: it is a temp folder, so a
    // failed cleanup must not fail the test.
    await rm(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => undefined);
  }
});
