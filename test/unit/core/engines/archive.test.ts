import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  extractArchive,
  extractTarGz,
  extractZip,
  isInside,
  isUnsafeEntryName,
  linkInside,
  safeJoin,
} from '../../../../src/core/engines/archive';
import { makeTarGz, makeZip, type ArchiveEntry } from '../../../fakes/fake-github/archives.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gb-arc-'));

function write(dir: string, name: string, buf: Buffer): string {
  const p = path.join(dir, name);
  writeFileSync(p, buf);
  return p;
}

describe('path guards', () => {
  it('flags absolute and climbing names', () => {
    expect(isUnsafeEntryName('a/b.txt')).toBe(false);
    expect(isUnsafeEntryName('a/..b')).toBe(false);
    expect(isUnsafeEntryName('/etc/passwd')).toBe(true);
    expect(isUnsafeEntryName('C:\\x')).toBe(true);
    expect(isUnsafeEntryName('a/../../b')).toBe(true);
    expect(isUnsafeEntryName('a\\..\\b')).toBe(true);
  });

  it('isInside / safeJoin', () => {
    const root = tmp();
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.join(root, 'x', 'y'))).toBe(true);
    expect(isInside(root, path.dirname(root))).toBe(false);
    expect(safeJoin(root, 'a/b')).toBe(path.join(root, 'a', 'b'));
    expect(() => safeJoin(root, '../x')).toThrow(/escapes/);
  });

  it('linkInside only links targets that stay inside', async () => {
    const root = tmp();
    const symlink = vi.fn(async () => {});
    expect(await linkInside(root, path.join(root, 'lib', 'l.so.0'), 'l.so', symlink)).toBe(true);
    expect(symlink).toHaveBeenCalledWith('l.so', path.join(root, 'lib', 'l.so.0'));
    expect(await linkInside(root, path.join(root, 'x'), '/etc/passwd', symlink)).toBe(false);
    expect(await linkInside(root, path.join(root, 'x'), 'C:\\Windows', symlink)).toBe(false);
    expect(await linkInside(root, path.join(root, 'x'), '../../outside', symlink)).toBe(false);
    const failing = vi.fn(async () => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    expect(await linkInside(root, path.join(root, 'y'), 'l.so', failing)).toBe(false);
    expect(symlink).toHaveBeenCalledTimes(1);
  });
});

describe('extractZip', () => {
  it('extracts files and folders (stored and deflated), symlinks only when inside', async () => {
    const src = tmp();
    const dest = path.join(tmp(), 'out');
    const big = 'z'.repeat(5000);
    const zip = write(
      src,
      'a.zip',
      makeZip([
        { name: 'bin/', type: 'dir' },
        { name: 'bin/llama-server.exe', data: 'exe' },
        { name: 'big.txt', data: big },
        { name: 'link', type: 'symlink', target: 'big.txt' },
        { name: 'escape', type: 'symlink', target: '../../outside' },
      ]),
    );
    const symlink = vi.fn(async () => {});
    await extractArchive(zip, dest, { symlink });
    expect(readFileSync(path.join(dest, 'bin', 'llama-server.exe'), 'utf8')).toBe('exe');
    expect(readFileSync(path.join(dest, 'big.txt'), 'utf8')).toBe(big);
    expect(symlink).toHaveBeenCalledTimes(1);
    expect(symlink).toHaveBeenCalledWith('big.txt', path.join(dest, 'link'));
  });

  it.each([
    ['zip-slip', '../evil.txt'],
    ['absolute', '/tmp/gb-evil.txt'],
  ])('rejects %s entries', async (_label, name) => {
    const src = tmp();
    const dest = path.join(src, 'deep', 'out');
    const zip = write(src, 'evil.zip', makeZip([{ name: 'ok.txt', data: 'ok' }, { name, data: 'pwned' }]));
    await expect(extractZip(zip, dest)).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'unsafe-archive' } });
    expect(existsSync(path.join(src, 'deep', 'evil.txt'))).toBe(false);
  });

  it('reports corrupt archives', async () => {
    const src = tmp();
    const bad = write(src, 'bad.zip', Buffer.from('this is not a zip file at all, sorry'));
    await expect(extractZip(bad, path.join(src, 'o'))).rejects.toMatchObject({ params: { reason: 'corrupt-archive' } });
    // Valid directory, truncated data: fails while reading an entry.
    const good = makeZip([{ name: 'f.txt', data: 'q'.repeat(4000) }]);
    const truncated = Buffer.concat([good.subarray(0, 60), Buffer.alloc(40), good.subarray(100)]);
    const t = write(src, 'trunc.zip', truncated);
    await expect(extractZip(t, path.join(src, 'o2'))).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED' });
  });

  it('closes the archive when extraction fails half-way', async () => {
    const src = tmp();
    const zip = write(src, 'clash.zip', makeZip([{ name: 'a', data: 'file' }, { name: 'a/b', data: 'under a file' }, { name: 'c', data: 'c' }]));
    await expect(extractZip(zip, path.join(src, 'o'))).rejects.toMatchObject({ params: { reason: 'corrupt-archive' } });
  });

  it('uses fs.symlink by default (may be refused on Windows: then skipped)', async () => {
    const src = tmp();
    const dest = path.join(src, 'o');
    await extractZip(write(src, 's.zip', makeZip([{ name: 'a', data: 'a' }, { name: 'b', type: 'symlink', target: 'a' }])), dest);
    expect(readdirSync(dest)).toContain('a');
  });
});

describe('extractTarGz', () => {
  const layout: ArchiveEntry[] = [
    { name: 'llama-b1/', type: 'dir' },
    { name: 'llama-b1/llama-server', data: 'bin', mode: 0o755 },
    { name: 'llama-b1/libllama.so', data: 'lib' },
    { name: 'llama-b1/libllama.so.0', type: 'symlink', target: 'libllama.so' },
    { name: 'llama-b1/escape', type: 'symlink', target: '../../../etc' },
    { name: 'llama-b1/hard', type: 'hardlink', target: 'llama-b1/libllama.so' },
    { name: 'llama-b1/hard-out', type: 'hardlink', target: '../outside' },
    { name: 'llama-b1/pipe', type: 'fifo' },
  ];

  it('extracts the real Linux layout; safe symlinks via the hook, hostile links and specials skipped', async () => {
    const src = tmp();
    const dest = path.join(src, 'out');
    const symlink = vi.fn(async () => {});
    await extractArchive(write(src, 'a.tar.gz', makeTarGz(layout)), dest, { symlink });
    expect(readFileSync(path.join(dest, 'llama-b1', 'llama-server'), 'utf8')).toBe('bin');
    expect(readFileSync(path.join(dest, 'llama-b1', 'hard'), 'utf8')).toBe('lib');
    expect(existsSync(path.join(dest, 'llama-b1', 'hard-out'))).toBe(false);
    expect(existsSync(path.join(dest, 'llama-b1', 'pipe'))).toBe(false);
    expect(symlink).toHaveBeenCalledTimes(1);
    expect(symlink).toHaveBeenCalledWith('libllama.so', path.join(dest, 'llama-b1', 'libllama.so.0'));
  });

  it('.tgz works too, default symlink implementation included', async () => {
    const src = tmp();
    await extractArchive(write(src, 'a.tgz', makeTarGz(layout.slice(0, 4))), path.join(src, 'o'));
    expect(existsSync(path.join(src, 'o', 'llama-b1', 'libllama.so'))).toBe(true);
  });

  it.each([['/etc/gb-evil'], ['../gb-evil'], ['a/../../gb-evil']])('rejects %s', async (name) => {
    const src = tmp();
    const dest = path.join(src, 'x', 'out');
    const tgz = write(src, 'e.tar.gz', makeTarGz([{ name: 'ok', data: 'ok' }, { name, data: 'pwned' }]));
    await expect(extractTarGz(tgz, dest)).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'unsafe-archive' } });
    expect(existsSync(path.join(src, 'x', 'gb-evil'))).toBe(false);
    expect(existsSync(path.join(src, 'gb-evil'))).toBe(false);
  });

  it('reports corrupt gzip data', async () => {
    const src = tmp();
    await expect(extractTarGz(write(src, 'c.tar.gz', Buffer.from('not gzip')), path.join(src, 'o'))).rejects.toMatchObject({
      params: { reason: 'corrupt-archive' },
    });
  });
});

describe('extractArchive', () => {
  it('rejects unknown archive types', async () => {
    await expect(extractArchive('x.rar', tmp())).rejects.toMatchObject({ params: { reason: 'unsupported-archive' } });
  });
});
