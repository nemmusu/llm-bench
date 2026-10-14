import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Unit + integration tests.
 *  - core/contract/main: Node environment (test/unit/core/**, test/integration/**)
 *  - renderer: happy-dom (test/unit/renderer/**)
 * Coverage (V8) is merged with E2E coverage by scripts/coverage.mjs; the 100% gate is enforced there.
 */
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    // Dates are written in local time and the expectations were taken in Italy: the same zone everywhere
    // (a Linux container runs in UTC).
    env: { TZ: 'Europe/Rome' },
    projects: [
      {
        extends: true,
        test: {
          name: 'core',
          environment: 'node',
          include: ['test/unit/core/**/*.test.ts', 'test/unit/contract/**/*.test.ts', 'test/unit/main/**/*.test.ts', 'test/unit/preload/**/*.test.ts', 'test/integration/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'happy-dom',
          setupFiles: ['test/unit/renderer/setup.ts'],
          include: ['test/unit/renderer/**/*.test.{ts,tsx}'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'json'],
      reportsDirectory: '.qa/coverage-unit',
    },
  },
});
