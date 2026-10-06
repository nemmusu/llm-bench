import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic, type AtomicFs } from '../../../src/core/store/atomic';

describe('writeFileAtomic', () => {
  it('writes the file and leaves no temp files behind', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gb-atomic-'));
    const file = path.join(dir, 'sub', 'a.json');
    await writeFileAtomic(file, '{"a":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(readdirSync(path.dirname(file))).toEqual(['a.json']);
  });

  it('retries a locked rename (antivirus) and then succeeds', async () => {
    let calls = 0;
    const fake: AtomicFs = {
      writeFile: async () => {},
      mkdir: async () => {},
      rm: async () => {},
      rename: async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      },
    };
    await writeFileAtomic('/x/y.json', 'data', { fs: fake, delayMs: 1 });
    expect(calls).toBe(3);
  });

  it('gives up after the retry budget and removes the temp file', async () => {
    const removed: string[] = [];
    const fake: AtomicFs = {
      writeFile: async () => {},
      mkdir: async () => {},
      rm: async (p) => {
        removed.push(p);
      },
      rename: async () => {
        throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      },
    };
    await expect(writeFileAtomic('/x/y.json', 'data', { fs: fake, delayMs: 1, retries: 2 })).rejects.toThrow('locked');
    expect(removed).toHaveLength(1);
  });

  it('does not retry non-transient errors', async () => {
    let calls = 0;
    const fake: AtomicFs = {
      writeFile: async () => {},
      mkdir: async () => {},
      rm: async () => {},
      rename: async () => {
        calls++;
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
    };
    await expect(writeFileAtomic('/x/y.json', 'd', { fs: fake })).rejects.toThrow('nope');
    expect(calls).toBe(1);
  });
});
