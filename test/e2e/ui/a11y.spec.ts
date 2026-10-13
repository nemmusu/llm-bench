import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { currentTheme, goToHash, h1, skipWelcome } from './helpers';

/**
 * Every screen, reached the way the app routes them, with the heading that proves it rendered.
 * The live run and a single result need real runs: test/e2e/journeys/bench-*.spec.ts scan them.
 */
const SCREENS: [hash: string, heading: string | RegExp][] = [
  ['#/welcome', 'Benvenuto in LLM Bench'],
  ['#/', 'Benchmark'],
  ['#/servers', /^Server$/],
  ['#/servers/new', 'Avvia un server'],
  ['#/results', 'Risultati'],
  ['#/compare', 'Confronta'],
  ['#/models', 'Modelli'],
  ['#/engines', 'Motori'],
  ['#/monitor', 'Monitor GPU'],
  ['#/settings', 'Impostazioni'],
];

async function scan(page: Page, label: string) {
  // Legacy mode runs axe inside the page itself: Electron cannot open the helper page axe uses otherwise.
  const results = await new AxeBuilder({ page }).setLegacyMode(true).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  const summary = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => `${n.target.join(' ')} → ${n.failureSummary ?? ''}`).join(', ')}`,
  );
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test(`no axe violations on any screen (${theme})`, async ({ gb }) => {
    const { page } = gb;
    // Scan settled frames: no page-transition fade (axe would measure half-transparent text).
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    if ((await currentTheme(page)) !== theme) {
      await page.getByRole('button', { name: 'Cambia tema' }).click();
      await expect.poll(() => currentTheme(page)).toBe(theme);
    }
    for (const [hash, heading] of SCREENS) {
      await goToHash(page, hash);
      await expect(h1(page, heading)).toBeVisible();
      // Let async data, gauges and charts settle before scanning: no element is still loading.
      await expect.poll(() => page.evaluate(() => document.querySelectorAll('[aria-busy="true"]').length)).toBe(0);
      await scan(page, `${hash} (${theme})`);
    }
  });
}

test('dialogs and the palette are accessible too', async ({ gb }) => {
  const { page } = gb;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await skipWelcome(page);
  await page.getByRole('button', { name: /Cambia modello/ }).click();
  await expect(page.getByRole('dialog', { name: 'Scegli un modello' })).toBeVisible();
  await scan(page, 'model picker');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog')).toBeVisible();
  await scan(page, 'command palette');
});
