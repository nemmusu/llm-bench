import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, type Settings } from '../../../../src/contract/settings';
import type { CoreDeps, Logger } from '../../../../src/core/deps';
import { systemClock } from '../../../../src/core/node-deps';

export interface LogEntry {
  level: string;
  msg: string;
  data?: Record<string, unknown>;
}

export function memoryLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at = (level: string) => (msg: string, data?: Record<string, unknown>) => {
    entries.push({ level, msg, ...(data ? { data } : {}) });
  };
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export function tempDir(prefix = 'gb-models-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function settingsWith(patch: Partial<Settings> = {}): () => Promise<Settings> {
  const s = { ...defaultSettings(), scanKnownLocations: false, ...patch };
  return () => Promise.resolve(s);
}

export function modelDeps(root: string, overrides: Partial<CoreDeps> = {}): CoreDeps {
  return {
    clock: systemClock,
    proc: {
      run: () => Promise.reject(new Error('no processes')),
      spawn: () => {
        throw new Error('no processes');
      },
    },
    fetch: globalThis.fetch.bind(globalThis),
    log: memoryLogger(),
    paths: {
      dataDir: path.join(root, 'data'),
      cacheDir: path.join(root, 'cache'),
      enginesDir: path.join(root, 'engines'),
      resultsDir: path.join(root, 'results'),
      modelsDir: path.join(root, 'library'),
      resourcesDir: path.join(process.cwd(), 'resources'),
      home: path.join(root, 'home'),
    },
    endpoints: { githubApi: 'http://127.0.0.1:9', huggingface: 'http://127.0.0.1:9', dockerHub: 'http://127.0.0.1:9' },
    platform: process.platform === 'win32' ? 'win32' : 'linux',
    arch: 'x64',
    env: {},
    appVersion: '0.0.0-test',
    ...overrides,
  };
}

export const GPU_32GB = { totalMiB: 32607, freeMiB: 30900 };
