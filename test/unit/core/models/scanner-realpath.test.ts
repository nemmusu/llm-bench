import type * as FsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { ModelScanner } from '../../../../src/core/models/scanner';
import { llamaLikeGguf, writeGguf } from '../../../fixtures/gguf/writer';
import { memoryLogger, settingsWith, tempDir } from './helpers';

// Some drives cannot resolve real paths (a Linux partition mounted on Windows, some network shares):
// realpath fails there while reading the folders works. Found on the user's Linux copy seen from Windows.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  return { ...real, realpath: (p: string) => (String(p).includes('no-realpath') ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) : real.realpath(p)) };
});

describe('ModelScanner on a drive without real paths', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir('gb-scan-rp-');
  });
  afterEach(() => t.cleanup());

  it('still finds the models (each folder once)', async () => {
    const root = path.join(t.dir, 'no-realpath');
    writeGguf(path.join(root, 'qwen', 'Qwen3.8-27B-MTP_(Q4_K_M).gguf'), { ...llamaLikeGguf({ embd: 16, vocab: 8 }), totalSize: 4096 });
    const scanner = new ModelScanner({
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      home: t.dir,
      env: {},
      defaultModelsDir: path.join(t.dir, 'library'),
      cacheDir: path.join(t.dir, 'cache'),
      log: memoryLogger(),
      // The same folder twice: scanned once.
      settings: settingsWith({ extraModelDirs: [root, root] }),
      knownRoots: [],
    });
    const models = await scanner.scan();
    expect(models.map((m) => [m.identity.displayName, m.identity.quant])).toEqual([['Qwen3.8-27B-MTP_(Q4_K_M)', 'Q4_K_M']]);
  });
});
