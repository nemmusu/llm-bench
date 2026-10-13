import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseAppNotices } from '../../../src/contract/app-notices';
import { startShell } from '../../../src/main/shell';
import { FakeFs } from './fake-fs';
import { started, world } from './harness';

/** The harness's userData is /user: GPU Bench's folder is next to it. */
const NEW = '/user';
const OLD = path.join(path.dirname(NEW), 'GPU Bench');

function gpuBench(): FakeFs {
  return new FakeFs()
    .file(path.join(OLD, 'settings.json'), JSON.stringify({ lastEngine: { kind: 'llamacpp-native', executable: path.join(OLD, 'engines', 'llamacpp', 'b1', 'llama-server.exe') } }))
    .file(path.join(OLD, 'results', 'r1.json'), '{}');
}

const notices = (files: Map<string, Buffer | string>) => parseAppNotices(JSON.parse(String(files.get(path.join(NEW, 'app-notices.json')) ?? '[]')));
const stderr = (out: Buffer[]) => out.map(String).join('');

describe('the shell takes over GPU Bench’s data (the rename to LLM Bench)', () => {
  it('renamed before the lock file lands in the new folder; the paths follow; the window says it once; then the core starts', async () => {
    const legacy = gpuBench();
    let movedAtLock: boolean | undefined;
    const t = await started({ legacy, onLock: () => (movedAtLock = legacy.has(path.join(NEW, 'settings.json')) && !legacy.has(OLD)) });
    expect(movedAtLock).toBe(true);
    // (userData as Electron gave it, then the rest of the path as it was.)
    const exe = path.join(OLD, 'engines', 'llamacpp', 'b1', 'llama-server.exe');
    expect(JSON.parse(legacy.text(path.join(NEW, 'settings.json'))!).lastEngine.executable).toBe(NEW + exe.slice(OLD.length));
    expect(notices(t.files)).toEqual([{ id: 'data-moved', kind: 'data-moved', mode: 'moved', from: OLD }]);
    expect(t.forks).toHaveLength(1);
  });

  it('nothing to take over: no notice written, nothing touched', async () => {
    const legacy = new FakeFs().file(path.join(NEW, 'settings.json'), '{}');
    const t = await started({ legacy });
    expect(t.files.has(path.join(NEW, 'app-notices.json'))).toBe(false);
    expect(legacy.calls).toEqual([]);
  });

  it('tests: GPUBENCH_USER_DATA alone has no GPU Bench folder; GPUBENCH_LEGACY_USER_DATA names one', () => {
    const legacy = gpuBench();
    const w = world({ legacy, env: { GPUBENCH_USER_DATA: '/tmp/ud' } });
    startShell(w.e, w.h);
    expect(legacy.has(OLD)).toBe(true);
    const named = new FakeFs().file('/tmp/old/settings.json', '{}');
    const w2 = world({ legacy: named, env: { GPUBENCH_USER_DATA: '/tmp/ud', GPUBENCH_LEGACY_USER_DATA: '/tmp/old' } });
    startShell(w2.e, w2.h);
    // The harness's userData is always /user.
    expect(named.has(path.join(NEW, 'settings.json'))).toBe(true);
  });

  it('a login item that cannot be moved, or notices that cannot be saved, never stop the start', async () => {
    const t = await started({
      legacy: gpuBench(),
      run: () => {
        throw new Error('reg.exe crashed');
      },
      writeFails: (p) => p.endsWith('app-notices.json'),
    });
    expect(stderr(t.out)).toContain('login item not moved: Error: reg.exe crashed');
    expect(stderr(t.out)).toContain('notices not saved: Error: EACCES');
    expect(t.forks).toHaveLength(1);
  });
});

describe('secrets that cannot be decrypted any more', () => {
  const unreadable = (b: Buffer) => {
    if (b.toString().startsWith('old:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    return b.toString().replace(/^enc:/, '');
  };

  it('are removed and asked for again (after the rename: said so); the core gets none', async () => {
    const t = await started({ legacy: gpuBench(), decrypt: unreadable, tokenFile: Buffer.from('old:hf'), keyFile: Buffer.from('old:gpub-k') });
    await vi.waitFor(() => expect(t.proc.posted).toEqual([{ type: 'hf-token', token: null }, { type: 'autostart' }]));
    expect(t.files.has(path.join(NEW, 'hf-token.bin'))).toBe(false);
    expect(t.files.has(path.join(NEW, 'server-api-key.bin'))).toBe(false);
    expect(notices(t.files)).toEqual([
      { id: 'data-moved', kind: 'data-moved', mode: 'moved', from: OLD },
      { id: 'secret-unreadable:hf-token', kind: 'secret-unreadable', secret: 'hf-token', renamed: true },
      { id: 'secret-unreadable:server-api-key', kind: 'secret-unreadable', secret: 'server-api-key', renamed: true },
    ]);
  });

  it('without a rename (a keyring that changed): the same, said differently; a file that cannot be removed is reported', async () => {
    const t = await started({ decrypt: unreadable, tokenFile: Buffer.from('old:hf'), keyFile: Buffer.from('enc:gpub-k'), rmFails: true });
    await vi.waitFor(() => expect(t.proc.posted).toEqual([{ type: 'hf-token', token: null }, { type: 'server-api-key', key: 'gpub-k', storage: 'encrypted' }, { type: 'autostart' }]));
    expect(notices(t.files)).toEqual([{ id: 'secret-unreadable:hf-token', kind: 'secret-unreadable', secret: 'hf-token', renamed: false }]);
    expect(stderr(t.out)).toContain('unreadable secret not removed: Error: EPERM');
  });
});
