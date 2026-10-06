import { expect, type Page } from '@playwright/test';

/** Mock ids used by the M0 screens (src/renderer/mock/runs.ts). */
export const RESULT_ID = '01K6Y7Q2ZC4M8N3B5V9R1T0XWE';
export const LIVE_ID = '01K6YB3H8F2D6S9K4P7M1Q5ZRA';

/** Sidebar entries and the h1 each one leads to, per language. */
export const PAGES = {
  it: [
    ['Benchmark', 'Benchmark'],
    ['Risultati', 'Risultati'],
    ['Modelli', 'Modelli'],
    ['Motori', 'Motori'],
    ['Monitor GPU', 'Monitor GPU'],
    ['Impostazioni', 'Impostazioni'],
  ],
  en: [
    ['Benchmark', 'Benchmark'],
    ['Results', 'Results'],
    ['Models', 'Models'],
    ['Engines', 'Engines'],
    ['GPU monitor', 'GPU monitor'],
    ['Settings', 'Settings'],
  ],
} as const;

export function h1(page: Page, name: string | RegExp) {
  return page.getByRole('heading', { level: 1, name });
}

/** First launch lands on the welcome wizard: skip it like a user in a hurry would. */
export async function skipWelcome(page: Page): Promise<void> {
  await expect(h1(page, 'Benvenuto in GPU Bench')).toBeVisible();
  await page.getByRole('button', { name: 'Salta, lo farò dopo' }).click();
  await expect(h1(page, 'Benchmark')).toBeVisible();
}

/** Screens reached by URL (detail pages have no sidebar entry). */
export async function goToHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

export async function currentTheme(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset.theme);
}

/** Opens the command palette with the keyboard shortcut. */
export async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog')).toBeVisible();
}
