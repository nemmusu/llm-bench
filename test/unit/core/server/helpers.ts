import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CoreContext } from '../../../../src/core/context';
import type { CoreDeps, ProcessRunner } from '../../../../src/core/deps';
import { createLogger, systemClock } from '../../../../src/core/node-deps';
import { EventHub } from '../../../../src/core/server/event-hub';
import { SettingsRepo } from '../../../../src/core/store/settings-repo';
import { createSysInfo } from '../../../../src/core/sysinfo/fingerprint';
import { createTelemetry } from '../../../../src/core/telemetry/factory';

export const noProc: ProcessRunner = {
  run: () => Promise.reject(new Error('no processes in this test')),
  spawn: () => {
    throw new Error('no processes in this test');
  },
};

export function tempDir(prefix = 'gb-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testDeps(dataDir: string, overrides: Partial<CoreDeps> = {}): CoreDeps {
  return {
    clock: systemClock,
    proc: noProc,
    fetch: globalThis.fetch.bind(globalThis),
    log: createLogger(() => {}),
    paths: {
      dataDir,
      cacheDir: path.join(dataDir, 'cache'),
      enginesDir: path.join(dataDir, 'engines'),
      resultsDir: path.join(dataDir, 'results'),
      modelsDir: path.join(dataDir, 'models'),
      resourcesDir: path.join(dataDir, 'resources'),
      home: dataDir,
    },
    endpoints: { githubApi: 'http://127.0.0.1:9', huggingface: 'http://127.0.0.1:9', dockerHub: 'http://127.0.0.1:9' },
    platform: 'linux',
    arch: 'x64',
    env: {},
    appVersion: '9.9.9',
    ...overrides,
  };
}

export function testContext(deps: CoreDeps): CoreContext {
  return {
    deps,
    hub: new EventHub(),
    settings: new SettingsRepo(deps.paths.dataDir),
    shutdown: new AbortController().signal,
    secrets: {},
    telemetry: createTelemetry(deps),
    sysinfo: createSysInfo(deps),
  };
}
