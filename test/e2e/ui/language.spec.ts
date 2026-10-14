/**
 * The language: a new install speaks English and its welcome offers Italian at the top, the title
 * bar's menu switches at once (mouse or keyboard), the choice is kept after a restart and the tray
 * menu follows it.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, launchApp, test } from '../fixtures';
import { expectTrayLine } from '../journeys/server-helpers';
import { h1 } from './helpers';

test('a new install speaks English; Italian is one click away, kept after a restart, and the tray follows', async () => {
  // Our own profile folder: launchApp() only deletes the folders it created itself.
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-lang-'));
  // What a new install reads: no language stored (and never this PC's model folders).
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ scanKnownLocations: false }));
  const language = () => (JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8')) as { language?: string }).language;
  try {
    const first = await launchApp({ userData });
    try {
      const { page, app } = first;
      await expect(h1(page, 'Welcome to LLM Bench')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Language: English' })).toBeVisible();
      await expectTrayLine(app, /^Open LLM Bench$/);

      // The welcome's own choice, at the top: one click.
      await page.getByRole('radiogroup', { name: 'Language' }).getByRole('radio', { name: 'Italiano' }).click();
      await expect(h1(page, 'Benvenuto in LLM Bench')).toBeVisible();
      await expectTrayLine(app, /^Apri LLM Bench$/);
      await expect.poll(language).toBe('it');
      await page.getByRole('button', { name: 'Salta, lo farò dopo' }).click();
      await expect(h1(page, 'Benchmark')).toBeVisible();

      // The title bar's menu, on every page: back to English.
      await page.getByRole('button', { name: 'Lingua: Italiano' }).click();
      await page.getByRole('menuitemradio', { name: 'English' }).click();
      await expect(page.getByRole('button', { name: 'Start benchmark' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
      await expectTrayLine(app, /^Open LLM Bench$/);
      await expect.poll(language).toBe('en');
    } finally {
      await first.close();
    }

    const second = await launchApp({ userData });
    try {
      const { page, app } = second;
      const button = page.getByRole('button', { name: 'Language: English' });
      await expect(button).toBeVisible();
      await expect(page.getByRole('button', { name: 'Start benchmark' })).toBeVisible();
      await expectTrayLine(app, /^Open LLM Bench$/);
      // Keyboard only: open, move to Italiano, pick it.
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menuitemradio', { name: 'English' })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menuitemradio', { name: 'Italiano' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Avvia benchmark' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Lingua: Italiano' })).toBeFocused();
      await expectTrayLine(app, /^Apri LLM Bench$/);
    } finally {
      await second.close();
    }
  } finally {
    // Windows may hold the profile for a while after Electron exits: it is a temp folder, so a
    // failed cleanup must not fail the test.
    await rm(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => undefined);
  }
});
