import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { E2E_ENV_FILE, ROOT } from './global-setup';
import { buildGguf, llamaLikeGguf } from '../fakes/fake-hub/model-files.mjs';

export { ROOT };

export interface LaunchOptions {
  /** Extra env vars (fake tool locations, endpoints…). */
  env?: Record<string, string>;
  /** Put a small synthetic GGUF in the library (default true). */
  seedModel?: boolean;
  /** Initial settings.json content (default: known locations off, so the real C:\models is never scanned). */
  settings?: Record<string, unknown>;
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
  // Fake internet + fake GPU tools (see global-setup.ts): the app never touches the network or the GPU.
  const fakes = existsSync(E2E_ENV_FILE) ? (JSON.parse(readFileSync(E2E_ENV_FILE, 'utf8')) as Record<string, string>) : {};
  // Deterministic library: one tiny model, and never the real folders of this PC.
  const settingsFile = path.join(userData, 'settings.json');
  if (!existsSync(settingsFile)) writeFileSync(settingsFile, JSON.stringify({ scanKnownLocations: false, ...opts.settings }));
  const seeded = path.join(userData, 'models', 'local', 'Qwen3-0.6B-Q4_K_M.gguf');
  if ((opts.seedModel ?? true) && !existsSync(seeded)) {
    mkdirSync(path.dirname(seeded), { recursive: true });
    writeFileSync(seeded, buildGguf({ ...llamaLikeGguf({ name: 'Qwen3 0.6B', sizeLabel: '0.6B' }), totalSize: 96 * 1024 }));
  }
  const dockerState = path.join(userData, 'fake-docker');
  const smiState = path.join(userData, 'fake-nvidia-smi.json');
  if (!existsSync(smiState)) writeFileSync(smiState, JSON.stringify({ gpus: [{ memUsedMiB: 1600, powerW: 38, utilPct: 1, tempC: 39 }] }));
  Object.assign(env, {
    ...fakes,
    GPUBENCH_NVIDIA_SMI: JSON.stringify([process.execPath, path.join(ROOT, 'test', 'fakes', 'fake-nvidia-smi', 'fake-nvidia-smi.mjs')]),
    FAKE_NVIDIA_SMI_STATE: smiState,
    GPUBENCH_LLAMA_LAUNCHER: JSON.stringify([process.execPath]),
    FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsCold: 1200, loadMsWarm: 400, prefillTps: 9000, decodeTps: 190, tokensPerChunk: 1 }),
    FAKE_ENGINE_ALLOW_MISSING_MODEL: '1',
    GPUBENCH_DOCKER: JSON.stringify([process.execPath, path.join(ROOT, 'test', 'fakes', 'fake-docker', 'fake-docker.mjs')]),
    FAKE_DOCKER_STATE: dockerState,
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
