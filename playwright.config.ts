import { defineConfig } from '@playwright/test';

/**
 * E2E against the real Electron app (built bundle in out/). Every test gets an isolated
 * userData folder and fake tools (see test/e2e/fixtures.ts), so it never touches the real
 * machine state. Run `npm run build` first (scripts/validate.mjs does it).
 */
export default defineConfig({
  testDir: 'test/e2e',
  outputDir: '.qa/test-results',
  timeout: 60_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '.qa/playwright-report', open: 'never' }]],
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{testFilePath}/{arg}{ext}',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
