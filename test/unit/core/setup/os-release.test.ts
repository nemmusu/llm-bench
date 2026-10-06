import { describe, expect, it } from 'vitest';
import { isUbuntuLike, parseOsRelease, readOsRelease } from '../../../../src/core/setup/os-release';

const UBUNTU_2404 = [
  'PRETTY_NAME="Ubuntu 24.04.3 LTS"',
  'NAME="Ubuntu"',
  'VERSION_ID="24.04"',
  'VERSION="24.04.3 LTS (Noble Numbat)"',
  'VERSION_CODENAME=noble',
  'ID=ubuntu',
  'ID_LIKE=debian',
  'UBUNTU_CODENAME=noble',
  '',
].join('\n');

describe('parseOsRelease', () => {
  it('reads the fields the installers need', () => {
    expect(parseOsRelease(UBUNTU_2404)).toEqual({
      id: 'ubuntu',
      idLike: ['debian'],
      versionId: '24.04',
      versionCodename: 'noble',
      ubuntuCodename: 'noble',
      prettyName: 'Ubuntu 24.04.3 LTS',
    });
  });

  it('handles quoting styles, CRLF, comments and missing fields', () => {
    const r = parseOsRelease("# comment\r\nID='LinuxMint'\r\nID_LIKE=\"ubuntu  debian\"\r\nPRETTY_NAME=\"Say \\\"hi\\\"\"\r\nbroken line\r\n");
    expect(r).toEqual({ id: 'linuxmint', idLike: ['ubuntu', 'debian'], prettyName: 'Say "hi"' });
    expect(parseOsRelease('NAME=nothing')).toBeUndefined();
    expect(parseOsRelease('ID=')).toBeUndefined();
  });

  it('recognizes Ubuntu-like systems', () => {
    expect(isUbuntuLike(parseOsRelease('ID=ubuntu')!)).toBe(true);
    expect(isUbuntuLike(parseOsRelease('ID=pop\nID_LIKE="ubuntu debian"')!)).toBe(true);
    expect(isUbuntuLike(parseOsRelease('ID=debian')!)).toBe(false);
  });
});

describe('readOsRelease', () => {
  it('prefers /etc/os-release and falls back to /usr/lib/os-release', async () => {
    const seen: string[] = [];
    const r = await readOsRelease((f) => {
      seen.push(f);
      return f === '/etc/os-release' ? Promise.reject(new Error('ENOENT')) : Promise.resolve('ID=debian\nVERSION_CODENAME=trixie');
    });
    expect(seen).toEqual(['/etc/os-release', '/usr/lib/os-release']);
    expect(r?.versionCodename).toBe('trixie');
    await expect(readOsRelease((f) => Promise.resolve(f === '/etc/os-release' ? 'ID=fedora' : 'ID=x'))).resolves.toMatchObject({ id: 'fedora' });
  });

  it('returns undefined when nothing parses', async () => {
    await expect(readOsRelease(() => Promise.resolve('garbage'))).resolves.toBeUndefined();
    // The default reader works on any OS (on Windows the files simply do not exist).
    const r = await readOsRelease();
    expect(r === undefined || typeof r.id === 'string').toBe(true);
  });
});
