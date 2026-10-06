import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
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
  return {
    app,
    page,
    userData,
    close: async () => {
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
