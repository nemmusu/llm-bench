import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  UV_FALLBACK_VERSION,
  UvInstaller,
  parseSha256File,
  uvAssetName,
  uvBinaryName,
  type UvInstallerOptions,
  type UvProgress,
} from '../../../../src/core/setup/uv';
import { makeTarGz, makeZip } from '../../../fakes/fake-github/archives.mjs';
import { FakeClock, FakeRunner, ok } from '../telemetry/fakes';

const VERSION = '0.12.23';
const LINUX_ASSET = 'uv-x86_64-unknown-linux-gnu.tar.gz';
const WIN_ASSET = 'uv-x86_64-pc-windows-msvc.zip';
const TAR = makeTarGz([
  { name: 'uv-x86_64-unknown-linux-gnu/', type: 'dir' },
  { name: 'uv-x86_64-unknown-linux-gnu/uv', data: 'ELF uv', mode: 0o755 },
  { name: 'uv-x86_64-unknown-linux-gnu/uvx', data: 'ELF uvx', mode: 0o755 },
]);
const ZIP = makeZip([
  { name: 'uv.exe', data: 'MZ uv' },
  { name: 'uvx.exe', data: 'MZ uvx' },
]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gb-uv-'));

interface Served {
  archive?: Buffer;
  asset?: string;
  shaText?: string;
  shaStatus?: number;
  shaThrows?: boolean;
  api?: unknown;
  apiStatus?: number;
  digest?: string | null;
  noLength?: boolean;
}

function fakeFetch(s: Served = {}) {
  const asset = s.asset ?? LINUX_ASSET;
  const archive = s.archive ?? TAR;
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (url.endsWith('/releases/latest')) {
      if (s.apiStatus) return new Response('rate limited', { status: s.apiStatus });
      const body = s.api ?? {
        tag_name: VERSION,
        assets: [
          { name: asset, size: archive.length, browser_download_url: `https://dl.test/${asset}`, digest: s.digest === undefined ? `sha256:${sha(archive)}` : s.digest },
          { name: `${asset}.sha256`, size: 100, browser_download_url: `https://dl.test/${asset}.sha256`, digest: null },
        ],
      };
      return Response.json(body);
    }
    if (url.endsWith('.sha256')) {
      if (s.shaThrows) throw new Error('reset');
      if (s.shaStatus) return new Response('no', { status: s.shaStatus });
      return new Response(s.shaText ?? `${sha(archive)}  ${asset}\n`);
    }
    // Two chunks, so progress throttling is exercised.
    const half = Math.floor(archive.length / 2);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(archive.subarray(0, half)));
        c.enqueue(new Uint8Array(archive.subarray(half)));
        c.close();
      },
    });
    return new Response(body, s.noLength ? {} : { headers: { 'content-length': String(archive.length) } });
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

function uv(over: Partial<UvInstallerOptions> = {}, served: Served = {}) {
  const enginesDir = tmp();
  const fetch = fakeFetch(served);
  const chmods: [string, number][] = [];
  const proc = new FakeRunner(() => ok(`uv ${VERSION} (abc123 2026-10-03)\n`));
  const inst = new UvInstaller({
    fetch: fetch.fn,
    proc,
    clock: new FakeClock(),
    platform: 'linux',
    arch: 'x64',
    enginesDir,
    githubApi: 'https://api.test/',
    appVersion: '1.2.3',
    progressIntervalMs: 0,
    chmod: (p, m) => {
      chmods.push([path.basename(p), m]);
      return Promise.resolve();
    },
    ...over,
  });
  return { inst, enginesDir, fetch, chmods, proc };
}

const signal = () => new AbortController().signal;

describe('uv helpers', () => {
  it('picks the release asset per OS and CPU', () => {
    expect(uvAssetName('linux', 'x64')).toBe(LINUX_ASSET);
    expect(uvAssetName('linux', 'arm64')).toBe('uv-aarch64-unknown-linux-gnu.tar.gz');
    expect(uvAssetName('win32', 'x64')).toBe(WIN_ASSET);
    expect(uvAssetName('win32', 'arm64')).toBe('uv-aarch64-pc-windows-msvc.zip');
    expect(uvAssetName('darwin', 'arm64')).toBeUndefined();
    expect(uvAssetName('linux', 'ia32')).toBeUndefined();
    expect(uvBinaryName('win32')).toBe('uv.exe');
    expect(uvBinaryName('linux')).toBe('uv');
  });

  it('parses .sha256 files (real format: "<hex>  <name>")', () => {
    const h = 'A'.repeat(64);
    expect(parseSha256File(`${h}  ${LINUX_ASSET}\n`, LINUX_ASSET)).toBe('a'.repeat(64));
    expect(parseSha256File(`${h} *${LINUX_ASSET}`, LINUX_ASSET)).toBe('a'.repeat(64));
    expect(parseSha256File(h, LINUX_ASSET)).toBe('a'.repeat(64));
    expect(parseSha256File(`${h}  other.tar.gz`, LINUX_ASSET)).toBeUndefined();
    expect(parseSha256File('not a hash', LINUX_ASSET)).toBeUndefined();
  });
});

describe('UvInstaller.plan', () => {
  it('asks GitHub for the latest release', async () => {
    const { inst, fetch } = uv();
    expect(await inst.plan()).toEqual({
      version: VERSION,
      asset: LINUX_ASSET,
      url: `https://dl.test/${LINUX_ASSET}`,
      sha256Url: `https://dl.test/${LINUX_ASSET}.sha256`,
      sizeBytes: TAR.length,
      digest: sha(TAR),
    });
    expect(fetch.calls).toEqual(['https://api.test/repos/astral-sh/uv/releases/latest']);
  });

  it('works without a GitHub digest', async () => {
    expect(await uv({}, { digest: null }).inst.plan()).not.toHaveProperty('digest');
    expect(await uv({}, { digest: 'md5:x' }).inst.plan()).not.toHaveProperty('digest');
  });

  it('falls back to the pinned release when GitHub cannot answer', async () => {
    const pinned = {
      version: UV_FALLBACK_VERSION,
      asset: LINUX_ASSET,
      url: `https://github.com/astral-sh/uv/releases/download/${UV_FALLBACK_VERSION}/${LINUX_ASSET}`,
      sha256Url: `https://github.com/astral-sh/uv/releases/download/${UV_FALLBACK_VERSION}/${LINUX_ASSET}.sha256`,
    };
    expect(await uv({}, { apiStatus: 403 }).inst.plan()).toEqual(pinned);
    expect(await uv({}, { api: { tag_name: 'v1-evil/../x', assets: [] } }).inst.plan()).toEqual(pinned);
    expect(await uv({}, { api: { tag_name: VERSION, assets: [] } }).inst.plan()).toEqual(pinned);
    expect(await uv({}, { api: { nope: true } }).inst.plan()).toEqual(pinned);
  });

  it('honours a pinned version and download base', async () => {
    const { inst, fetch } = uv({ version: '0.9.1', downloadBase: 'http://127.0.0.1:9/' });
    expect(await inst.plan()).toMatchObject({ version: '0.9.1', url: `http://127.0.0.1:9/astral-sh/uv/releases/download/0.9.1/${LINUX_ASSET}` });
    expect(fetch.calls).toEqual([]);
    await expect(uv({ version: '../../etc' }).inst.plan()).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses unsupported platforms and honours cancellation', async () => {
    await expect(uv({ platform: 'darwin' }).inst.plan()).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'unsupported-platform' } });
    const ac = new AbortController();
    ac.abort();
    await expect(uv().inst.plan(ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('UvInstaller.install', () => {
  it('installs the Linux tarball: verified, extracted, executable, smoke-tested', async () => {
    const { inst, enginesDir, chmods, proc } = uv();
    const progress: UvProgress[] = [];
    const r = await inst.install((p) => progress.push(p), signal());
    const exe = path.join(enginesDir, 'uv', VERSION, 'uv');
    expect(r).toEqual({ version: VERSION, path: exe });
    expect(readFileSync(exe, 'utf8')).toBe('ELF uv');
    expect(existsSync(path.join(enginesDir, 'uv', VERSION, 'uvx'))).toBe(true);
    expect(chmods).toEqual([
      ['uv', 0o755],
      ['uvx', 0o755],
    ]);
    expect(proc.calls[0]?.args).toEqual(['--version']);
    expect(progress.map((p) => p.stage)).toEqual(['download', 'download', 'download', 'extract', 'verify', 'done']);
    expect(progress[0]).toEqual({ stage: 'download', bytesDone: 0, bytesTotal: TAR.length });
    // No temp folder left behind.
    expect(readdirSync(path.join(enginesDir, 'uv'))).toEqual([VERSION]);
    expect(await inst.uvPath()).toBe(exe);
  });

  it('skips the download when that version is already there', async () => {
    const { inst, fetch } = uv({ version: VERSION });
    await inst.install(() => {}, signal());
    const before = fetch.calls.length;
    const progress: UvProgress[] = [];
    expect(await inst.install((p) => progress.push(p), signal())).toMatchObject({ version: VERSION });
    expect(fetch.calls.length).toBe(before);
    expect(progress).toEqual([{ stage: 'done', bytesDone: 0 }]);
  });

  it('installs the Windows zip (binary at the archive root) with throttled progress', async () => {
    const { inst, enginesDir, chmods } = uv({ platform: 'win32', progressIntervalMs: 60_000 }, { archive: ZIP, asset: WIN_ASSET });
    const progress: UvProgress[] = [];
    const r = await inst.install((p) => progress.push(p), signal());
    expect(r.path).toBe(path.join(enginesDir, 'uv', VERSION, 'uv.exe'));
    expect(chmods).toEqual([]);
    expect(progress.filter((p) => p.stage === 'download')).toHaveLength(2);
  });

  it('works with default options and a server that sends no length', async () => {
    const { inst } = uv({ progressIntervalMs: undefined, appVersion: undefined }, { noLength: true });
    const progress: UvProgress[] = [];
    await inst.install((p) => progress.push(p), signal());
    expect(progress.filter((p) => p.stage === 'download').at(-1)).toEqual({ stage: 'download', bytesDone: Math.floor(TAR.length / 2) });
  });

  it('uses fs.chmod by default and tolerates a missing uvx', async () => {
    const tar = makeTarGz([{ name: 'uv-x86_64-unknown-linux-gnu/uv', data: 'ELF uv' }]);
    const { inst } = uv({ chmod: undefined as never }, { archive: tar });
    await expect(inst.install(() => {}, signal())).resolves.toMatchObject({ version: VERSION });
  });

  it('lists installed versions newest first, ignoring junk', async () => {
    const { inst, enginesDir } = uv();
    const root = path.join(enginesDir, 'uv');
    for (const v of ['0.9.1', '0.12.3', '0.12.23', '1.0.0']) {
      mkdirSync(path.join(root, v), { recursive: true });
      if (v !== '1.0.0') writeFileSync(path.join(root, v, 'uv'), 'x');
    }
    mkdirSync(path.join(root, '.tmp-abc'));
    mkdirSync(path.join(root, 'latest'));
    expect((await inst.installed()).map((i) => i.version)).toEqual(['0.12.23', '0.12.3', '0.9.1']);
    expect(await uv().inst.uvPath()).toBeUndefined();
  });

  it('rejects checksum problems and cleans up', async () => {
    const wrong = uv({}, { shaText: `${'0'.repeat(64)}  ${LINUX_ASSET}`, digest: null });
    await expect(wrong.inst.install(() => {}, signal())).rejects.toMatchObject({ code: 'DOWNLOAD_CHECKSUM' });
    expect(readdirSync(path.join(wrong.enginesDir, 'uv'))).toEqual([]);
    await expect(uv({}, { digest: `sha256:${'1'.repeat(64)}` }).inst.install(() => {}, signal())).rejects.toMatchObject({
      code: 'DOWNLOAD_CHECKSUM',
      params: { file: LINUX_ASSET },
    });
    await expect(uv({}, { shaText: 'garbage' }).inst.install(() => {}, signal())).rejects.toMatchObject({ params: { reason: 'bad-checksum-file' } });
    await expect(uv({}, { shaStatus: 404 }).inst.install(() => {}, signal())).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });

  it('maps a cancelled checksum download to CANCELLED', async () => {
    const ac = new AbortController();
    const { inst } = uv({}, { shaThrows: true });
    const plan = await inst.plan();
    ac.abort();
    await expect(inst.install(() => {}, ac.signal, plan)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('fails when the archive has no uv binary', async () => {
    const tar = makeTarGz([{ name: 'docs/README.md', data: 'hi' }, { name: 'docs/', type: 'dir' }]);
    await expect(uv({}, { archive: tar }).inst.install(() => {}, signal())).rejects.toMatchObject({ params: { reason: 'binary-missing' } });
  });

  it('fails when uv does not run or reports another version', async () => {
    const run = (out: ReturnType<typeof ok>) => {
      const u = uv();
      const proc = new FakeRunner(() => out);
      return new UvInstaller({ ...(u.inst as unknown as { o: UvInstallerOptions }).o, proc }).install(() => {}, signal());
    };
    await expect(run(ok('', 1, { stderr: 'exec format error' }))).rejects.toMatchObject({ params: { reason: 'smoke-failed', exitCode: '1' }, detail: 'exec format error' });
    await expect(run(ok('uv 0.0.1'))).rejects.toMatchObject({ params: { reason: 'smoke-failed' }, detail: 'uv 0.0.1' });
  });

  it('stops when cancelled during the smoke test', async () => {
    const ac = new AbortController();
    const u = uv();
    const proc = new FakeRunner(() => {
      ac.abort();
      return ok('', null);
    });
    const inst = new UvInstaller({ ...(u.inst as unknown as { o: UvInstallerOptions }).o, proc });
    await expect(inst.install(() => {}, ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
