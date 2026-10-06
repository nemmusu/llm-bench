/** Shared steps of the benchmark journeys: seeded history, axe scans, the welcome skip. */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, ROOT, type AppHandle, type LaunchOptions } from '../fixtures';

export { skipWelcome, h1 } from '../ui/helpers';

/** Realistic saved runs (test/fixtures/runs): "__THIS_PC__" becomes this computer's name. */
export const SEED_DIR = path.join(ROOT, 'test', 'fixtures', 'runs');

export function seedRuns(resultsDir: string, only?: (file: string) => boolean): string[] {
  mkdirSync(resultsDir, { recursive: true });
  const files = readdirSync(SEED_DIR).filter((f) => f.endsWith('.json') && (!only || only(f)));
  for (const f of files) {
    const text = readFileSync(path.join(SEED_DIR, f), 'utf8').replaceAll('__THIS_PC__', os.hostname());
    writeFileSync(path.join(resultsDir, f), text);
  }
  return files;
}

/** Launches the app with a seeded results folder; the folder is removed on close. */
export async function launchSeeded(opts: LaunchOptions = {}, only?: (file: string) => boolean): Promise<AppHandle> {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-bench-'));
  seedRuns(path.join(userData, 'results'), only);
  const handle = await launchApp({ ...opts, userData });
  return {
    ...handle,
    close: async () => {
      await handle.close();
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

/** WCAG 2.1 AA + best practices on what is on screen now. */
export async function scan(page: Page, label: string): Promise<void> {
  // Legacy mode runs axe inside the page itself: Electron cannot open the helper page axe uses otherwise.
  const results = await new AxeBuilder({ page }).setLegacyMode(true).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => `${n.target.join(' ')} → ${n.failureSummary ?? ''}`).join(', ')}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

/** Writes the fake nvidia-smi state (GPU numbers and the processes using it). */
export function setGpuState(userData: string, state: Record<string, unknown>): void {
  writeFileSync(path.join(userData, 'fake-nvidia-smi.json'), JSON.stringify(state));
}

/** Makes the next native "Save as" dialog answer with `filePath` (main process). */
export async function answerSaveDialog(handle: AppHandle, filePath: string): Promise<void> {
  await handle.app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
  }, filePath);
}

export function tempFile(name: string): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-out-')), name);
}
