import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../..');

export interface LaunchOptions {
  /** Extra env vars (fake tool locations, endpoints…). */
  env?: Record<string, string>;
  /** Reuse an existing userData dir (to test persistence across restarts). */
  userData?: string;
}

export interface AppHandle {
  app: ElectronApplication;
  page: Page;
  userData: string;
  close(): Promise<void>;
}

export async function launchApp(opts: LaunchOptions = {}): Promise<AppHandle> {
  const userData = opts.userData ?? mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, {
    GPUBENCH_USER_DATA: userData,
    GPUBENCH_MODELS_DIR: path.join(userData, 'models'),
    ...(process.env.GPUBENCH_E2E_COVERAGE ? { NODE_V8_COVERAGE: process.env.GPUBENCH_E2E_COVERAGE } : {}),
    ...opts.env,
  });
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const coverageDir = process.env.GPUBENCH_E2E_COVERAGE;
  if (coverageDir) {
    // Start collecting before the app code runs: reload under coverage.
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  }
  return {
    app,
    page,
    userData,
    close: async () => {
      if (coverageDir && !page.isClosed()) {
        const entries = await page.coverage.stopJSCoverage();
        const dir = path.join(path.dirname(coverageDir), 'cov-renderer');
        mkdirSync(dir, { recursive: true });
        const ours = entries.filter((e) => /^http:\/\/127\.0\.0\.1:\d+\/assets\//.test(e.url));
        writeFileSync(path.join(dir, `${randomUUID()}.json`), JSON.stringify({ result: ours }));
      }
      await app.close();
      if (!opts.userData) rmSync(userData, { recursive: true, force: true });
    },
  };
}

export const test = base.extend<{ gb: AppHandle }>({
  gb: async ({}, use) => {
    const handle = await launchApp();
    await use(handle);
    await handle.close();
  },
});

export { expect } from '@playwright/test';
