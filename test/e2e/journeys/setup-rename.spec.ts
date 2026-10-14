/**
 * The rename GPU Bench → LLM Bench on a PC that used GPU Bench: at the first start its data folder
 * becomes LLM Bench's (a pretend one in a temp folder, never this PC's %APPDATA%\GPU Bench), the
 * results and settings are there, and the window says it once.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, launchApp, test } from '../fixtures';
import { h1, seedRuns } from './bench-helpers';

test.describe.configure({ timeout: 120_000 });

test('GPU Bench’s data at the first start of LLM Bench: moved, results and settings there, said once', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'llmbench-e2e-rename-'));
  const legacy = path.join(root, 'GPU Bench');
  const userData = path.join(root, 'LLM Bench');
  const stateDir = path.join(root, 'state');
  // GPU Bench 0.3.0's folder: settings (Italian, welcome done, compact layout) and nine results.
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, 'settings.json'), JSON.stringify({ scanKnownLocations: false, language: 'it', onboardingDone: true, density: 'compact' }));
  seedRuns(path.join(legacy, 'results'));
  try {
    const first = await launchApp({ userData, legacyUserData: legacy, stateDir });
    try {
      const { page } = first;
      const notice = page.getByRole('listitem').filter({ hasText: 'I tuoi dati di GPU Bench sono stati spostati in LLM Bench' });
      await expect(notice).toBeVisible({ timeout: 20_000 });
      expect(existsSync(legacy)).toBe(false);
      expect(JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'))).toMatchObject({ onboardingDone: true, density: 'compact' });
      await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: 'Risultati' }).click();
      await expect(h1(page, 'Risultati')).toBeVisible();
      await expect(page.getByText('9 risultati')).toBeVisible();
      // It stays until it is closed; closed, it is never shown again.
      await notice.getByRole('button', { name: 'Chiudi' }).click();
      await expect(notice).toHaveCount(0);
      await expect.poll(() => JSON.parse(readFileSync(path.join(userData, 'app-notices.json'), 'utf8')) as unknown[]).toEqual([]);
    } finally {
      await first.close();
    }
    // Next start: nothing to take over, nothing said.
    const second = await launchApp({ userData, legacyUserData: legacy, stateDir });
    try {
      await expect(h1(second.page, 'Benchmark')).toBeVisible();
      await expect(second.page.getByText('I tuoi dati di GPU Bench sono stati spostati in LLM Bench')).toHaveCount(0);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
