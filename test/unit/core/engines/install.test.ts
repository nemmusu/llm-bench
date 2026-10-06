import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LlamaRelease } from '../../../../src/contract/api';
import type { ProcessRunner, RunOptions, RunOutput } from '../../../../src/core/deps';
import {
  buildEnv,
  contentRoot,
  findFile,
  listFiles,
  installLlamaBuild,
  listInstalled,
  llamaRoot,
  mergeMove,
  readManifest,
  removeBuild,
  renameWithRetry,
  serverExeName,
  type InstallDeps,
} from '../../../../src/core/engines/llamacpp-native/install';
import { LlamaReleasesClient, selectAssets, type AssetSelection } from '../../../../src/core/engines/llamacpp-native/releases';
import { systemClock } from '../../../../src/core/node-deps';
import type { ProgressSink } from '../../../../src/core/engines/types';
import { startFakeGithub, type FakeGithub } from '../../../fakes/fake-github/server.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gb-inst-'));
const OK: RunOutput = { code: 0, stdout: '', stderr: 'version: 0.4.1-dev (build 11438, commit abc1234)\nbuilt with test', timedOut: false };

function smokeRunner(out: RunOutput = OK): ProcessRunner & { calls: [string, string[], RunOptions | undefined][] } {
  const calls: [string, string[], RunOptions | undefined][] = [];
  return {
    calls,
    run: async (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      return out;
    },
    spawn: () => {
      throw new Error('unused');
    },
  };
}

let gh: FakeGithub;
let release: LlamaRelease;
beforeAll(async () => {
  gh = await startFakeGithub();
  release = (await new LlamaReleasesClient({ fetch, githubApi: gh.url, cacheDir: tmp() }).list())[0] as LlamaRelease;
});
afterAll(() => gh.close());

async function freshRelease(): Promise<LlamaRelease> {
  return (await new LlamaReleasesClient({ fetch, githubApi: gh.url, cacheDir: tmp() }).list())[0] as LlamaRelease;
}

function deps(over: Partial<InstallDeps> = {}): InstallDeps {
  return { fetch, proc: smokeRunner(), clock: systemClock, platform: 'win32', enginesDir: tmp(), progressIntervalMs: 0, ...over };
}

const sel = (r: LlamaRelease, platform: 'win32' | 'linux', extra: object = {}) =>
  selectAssets(r, { platform, arch: 'x64', cudaVersion: '13.4', ...extra }) as AssetSelection;

describe('installLlamaBuild', () => {
  it('Windows: downloads main + cudart, verifies digests, extracts the flat zips, smoke-runs --version', async () => {
    const proc = smokeRunner();
    const d = deps({ proc });
    const events: Parameters<ProgressSink>[0][] = [];
    const b = await installLlamaBuild(d, release.tag, sel(release, 'win32'), (p) => events.push(p), new AbortController().signal);
    expect(b.id).toBe('b11438-cuda-13.4');
    expect(b.dir).toBe(path.join(llamaRoot(d.enginesDir), 'b11438-cuda-13.4'));
    expect(b.serverPath).toBe(path.join(b.dir, 'llama-server.exe'));
    expect(readFileSync(b.serverPath, 'utf8')).toBe('fake llama-server b11438 cuda');
    expect(readFileSync(path.join(b.dir, 'cudart64_13.dll'), 'utf8')).toBe('fake cudart 13');
    // Both archives ship a LICENSE: the later one (cudart) wins.
    expect(readFileSync(path.join(b.dir, 'LICENSE'), 'utf8')).toBe('cudart license');
    expect(b.files).toContain('ggml-cuda.dll');
    expect(b.sources.map((s) => s.name)).toEqual(['llama-b11438-bin-win-cuda-13.4-x64.zip', 'cudart-llama-bin-win-cuda-13.4-x64.zip']);
    expect(b.sources[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.smoke).toMatchObject({ ok: true, code: 0, output: 'version: 0.4.1-dev (build 11438, commit abc1234)\nbuilt with test' });
    expect(proc.calls[0]?.[0]).toBe(b.serverPath);
    expect(proc.calls[0]?.[1]).toEqual(['--version']);
    expect(proc.calls[0]?.[2]?.env).toEqual({});
    expect(events.map((e) => e.stage)).toEqual(expect.arrayContaining(['download', 'extract', 'smoke', 'done']));
    const dl = events.filter((e) => e.stage === 'download');
    expect(dl.at(-1)?.bytesDone).toBe(dl.at(-1)?.bytesTotal);
    // Manifest on disk round-trips, temp folders are gone.
    expect(await readManifest(b.dir)).toMatchObject({ tag: 'b11438', variant: 'cuda-13.4', server: 'llama-server.exe' });
    expect(readdirSync(llamaRoot(d.enginesDir))).toEqual(['b11438-cuda-13.4']);
    expect(await listInstalled(d.enginesDir)).toHaveLength(1);
  });

  it('Linux: flattens llama-<tag>/, merges cudart, marks binaries executable, sets LD_LIBRARY_PATH', async () => {
    const proc = smokeRunner();
    const chmod = vi.fn(async (_p: string, _m: number) => {});
    const symlink = vi.fn(async () => {});
    const d = deps({ proc, platform: 'linux', chmod, symlink, ldLibraryPath: '/usr/local/lib', smokeTimeoutMs: 1234 });
    const b = await installLlamaBuild(d, release.tag, sel(release, 'linux'), () => {}, new AbortController().signal);
    expect(b.server).toBe('llama-server');
    expect(existsSync(path.join(b.dir, 'libcudart.so.13'))).toBe(true);
    expect(chmod.mock.calls.map((c) => path.basename(c[0])).sort()).toEqual(['LICENSE', 'llama-bench', 'llama-server']);
    expect(chmod.mock.calls.every((c) => (c[1] & 0o755) === 0o755)).toBe(true);
    expect(symlink).toHaveBeenCalledWith('libllama.so', expect.stringContaining('libllama.so.0'));
    expect(proc.calls[0]?.[2]).toMatchObject({ timeoutMs: 1234, env: { LD_LIBRARY_PATH: `${b.dir}:/usr/local/lib` } });
  });

  it('Linux defaults: real chmod, no inherited LD_LIBRARY_PATH; CPU build without cudart', async () => {
    const proc = smokeRunner();
    const d = deps({ proc, platform: 'linux' });
    delete d.progressIntervalMs;
    const b = await installLlamaBuild(d, release.tag, sel(release, 'linux', { prefer: ['cpu'] }), () => {}, new AbortController().signal);
    expect(b.variant).toBe('cpu');
    expect(b.cudaVersion).toBeUndefined();
    expect(b.sources).toHaveLength(1);
    expect(proc.calls[0]?.[2]?.env).toEqual({ LD_LIBRARY_PATH: b.dir });
  });

  it('records a failing or hanging smoke run without failing the install', async () => {
    const failing = await installLlamaBuild(
      deps({ proc: smokeRunner({ code: -1073741515, stdout: '', stderr: '', timedOut: false }) }),
      release.tag,
      sel(release, 'win32'),
      () => {},
      new AbortController().signal,
    );
    expect(failing.smoke).toMatchObject({ ok: false, code: -1073741515, output: '' });
    const hanging = await installLlamaBuild(
      deps({ proc: smokeRunner({ code: 0, stdout: '', stderr: '', timedOut: true }) }),
      release.tag,
      sel(release, 'win32'),
      () => {},
      new AbortController().signal,
    );
    expect(hanging.smoke?.ok).toBe(false);
  });

  it('reinstalling replaces the previous build (retrying antivirus-locked renames)', async () => {
    const d = deps();
    const first = await installLlamaBuild(d, release.tag, sel(release, 'win32'), () => {}, new AbortController().signal);
    writeFileSync(path.join(first.dir, 'stale.txt'), 'old');
    let locked = 1;
    const fsRename = (await import('node:fs/promises')).rename;
    const rename = vi.fn(async (a: string, b: string) => {
      if (locked-- > 0) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      await fsRename(a, b);
    });
    const again = await installLlamaBuild({ ...d, rename, renameDelayMs: 1 }, release.tag, sel(release, 'win32'), () => {}, new AbortController().signal);
    expect(existsSync(path.join(again.dir, 'stale.txt'))).toBe(false);
    expect(rename.mock.calls.length).toBe(3);
  });

  it('an in-use build is reported and left intact', async () => {
    const d = deps();
    const first = await installLlamaBuild(d, release.tag, sel(release, 'win32'), () => {}, new AbortController().signal);
    const rename = vi.fn(async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    await expect(
      installLlamaBuild({ ...d, rename, renameDelayMs: 0 }, release.tag, sel(release, 'win32'), () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'in-use' } });
    expect(existsSync(first.serverPath)).toBe(true);
    expect(readdirSync(llamaRoot(d.enginesDir))).toEqual(['b11438-cuda-13.4']);
  });

  it('a failed final move restores the previous build (or just fails on a first install)', async () => {
    const d = deps();
    const first = await installLlamaBuild(d, release.tag, sel(release, 'win32'), () => {}, new AbortController().signal);
    const fsRename = (await import('node:fs/promises')).rename;
    const rename = vi.fn(async (a: string, b: string) => {
      if (a.endsWith('stage')) throw Object.assign(new Error('weird'), { code: 'EXDEV' });
      await fsRename(a, b);
    });
    await expect(installLlamaBuild({ ...d, rename }, release.tag, sel(release, 'win32'), () => {}, new AbortController().signal)).rejects.toMatchObject({
      params: { reason: 'io' },
    });
    expect(existsSync(first.serverPath)).toBe(true);
    await expect(
      installLlamaBuild({ ...deps(), rename }, release.tag, sel(release, 'win32'), () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ params: { reason: 'io' } });
  });

  it('checksum mismatch, missing binary, hostile archive and bad ids fail cleanly', async () => {
    const d = deps();
    gh.set({ wrongDigest: true });
    const bad = await freshRelease();
    gh.set({ wrongDigest: false });
    await expect(installLlamaBuild(d, bad.tag, sel(bad, 'win32'), () => {}, new AbortController().signal)).rejects.toMatchObject({
      code: 'DOWNLOAD_CHECKSUM',
    });
    expect(readdirSync(llamaRoot(d.enginesDir))).toEqual([]);

    gh.set({ noServerBinary: true });
    const empty = await freshRelease();
    await expect(installLlamaBuild(deps(), empty.tag, sel(empty, 'win32'), () => {}, new AbortController().signal)).rejects.toMatchObject({
      params: { reason: 'no-server-binary' },
    });
    gh.set({ noServerBinary: false, evil: 'zip-slip' });
    const evil = await freshRelease();
    await expect(installLlamaBuild(deps(), evil.tag, sel(evil, 'win32'), () => {}, new AbortController().signal)).rejects.toMatchObject({
      params: { reason: 'unsafe-archive' },
    });
    gh.set({ evil: undefined });
    await expect(installLlamaBuild(deps(), 'B1', sel(release, 'win32'), () => {}, new AbortController().signal)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('works without digests (older releases)', async () => {
    gh.set({ noDigest: true });
    const r = await freshRelease();
    gh.set({ noDigest: false });
    const b = await installLlamaBuild(deps(), r.tag, sel(r, 'win32'), () => {}, new AbortController().signal);
    expect(b.sources.every((s) => s.sha256 === undefined)).toBe(true);
  });

  it('cancellation before download or before extraction', async () => {
    await expect(installLlamaBuild(deps(), release.tag, sel(release, 'win32'), () => {}, AbortSignal.abort())).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    const ac = new AbortController();
    const d = deps();
    await expect(
      installLlamaBuild(d, release.tag, sel(release, 'win32'), (p) => p.stage === 'extract' && ac.abort(), ac.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(readdirSync(llamaRoot(d.enginesDir))).toEqual([]);
  });

  it('unexpected errors are wrapped as ENGINE_INSTALL_FAILED', async () => {
    const chmod = async () => {
      throw new Error('EIO');
    };
    await expect(
      installLlamaBuild(deps({ platform: 'linux', chmod }), release.tag, sel(release, 'linux'), () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'io' } });
  });

  it('throttles download progress events', async () => {
    let t = 0;
    const clock = { ...systemClock, now: () => (t += 1) };
    const events: string[] = [];
    await installLlamaBuild(deps({ clock, progressIntervalMs: 1000 }), release.tag, sel(release, 'win32'), (p) => events.push(p.stage), new AbortController().signal);
    expect(events.filter((s) => s === 'download').length).toBe(1);
  });
});

describe('helpers', () => {
  it('serverExeName / buildEnv', () => {
    expect(serverExeName('win32')).toBe('llama-server.exe');
    expect(serverExeName('linux')).toBe('llama-server');
    expect(buildEnv('win32', 'C:\\x', 'y')).toEqual({});
    expect(buildEnv('linux', '/e', undefined)).toEqual({ LD_LIBRARY_PATH: '/e' });
    expect(buildEnv('linux', '/e', '/l')).toEqual({ LD_LIBRARY_PATH: '/e:/l' });
  });

  it('contentRoot descends single folders (bounded), stops at files or several entries', async () => {
    const a = tmp();
    mkdirSync(path.join(a, 'one', 'two', 'three', 'four', 'five'), { recursive: true });
    expect(await contentRoot(a)).toBe(path.join(a, 'one', 'two', 'three', 'four'));
    const b = tmp();
    writeFileSync(path.join(b, 'only-file'), '');
    expect(await contentRoot(b)).toBe(b);
    const c = tmp();
    mkdirSync(path.join(c, 'x'));
    mkdirSync(path.join(c, 'y'));
    expect(await contentRoot(c)).toBe(c);
  });

  it('findFile searches breadth-first within the depth limit', async () => {
    const root = tmp();
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'a', 'b', 'llama-server'), '');
    expect(await findFile(root, 'llama-server', 4)).toBe('a/b/llama-server');
    expect(await findFile(root, 'llama-server', 1)).toBeUndefined();
    expect(await findFile(root, 'nothing', 9)).toBeUndefined();
  });

  it('listFiles returns sorted POSIX relative paths, recursing into folders', async () => {
    const root = tmp();
    mkdirSync(path.join(root, 'lib', 'x'), { recursive: true });
    writeFileSync(path.join(root, 'lib', 'x', 'a.so'), '');
    writeFileSync(path.join(root, 'b'), '');
    expect(await listFiles(root)).toEqual(['b', 'lib/x/a.so']);
  });

  it('mergeMove merges folders and replaces files', async () => {
    const src = tmp();
    const dst = tmp();
    mkdirSync(path.join(src, 'lib'));
    writeFileSync(path.join(src, 'lib', 'b.so'), 'new');
    writeFileSync(path.join(src, 'thing'), 'file now');
    mkdirSync(path.join(dst, 'lib'));
    writeFileSync(path.join(dst, 'lib', 'a.so'), 'keep');
    mkdirSync(path.join(dst, 'thing'));
    await mergeMove(src, dst);
    expect(readdirSync(path.join(dst, 'lib')).sort()).toEqual(['a.so', 'b.so']);
    expect(readFileSync(path.join(dst, 'thing'), 'utf8')).toBe('file now');
  });

  it('renameWithRetry retries transient errors only, within budget', async () => {
    let n = 0;
    await renameWithRetry(
      async () => {
        if (n++ < 2) throw Object.assign(new Error('x'), { code: 'EACCES' });
      },
      'a',
      'b',
      5,
      1,
    );
    expect(n).toBe(3);
    const always = vi.fn(async () => {
      throw Object.assign(new Error('x'), { code: 'EPERM' });
    });
    await expect(renameWithRetry(always, 'a', 'b', 2, 1)).rejects.toThrow('x');
    expect(always).toHaveBeenCalledTimes(3);
    const hard = vi.fn(async () => {
      throw new Error('no code');
    });
    await expect(renameWithRetry(hard, 'a', 'b')).rejects.toThrow('no code');
    expect(hard).toHaveBeenCalledTimes(1);
  });
});

describe('listInstalled / removeBuild', () => {
  it('lists valid managed builds newest first and ignores everything else', async () => {
    const enginesDir = tmp();
    expect(await listInstalled(enginesDir)).toEqual([]);
    const root = llamaRoot(enginesDir);
    const manifest = (tag: string, variant: string) => ({
      schema: 1,
      tag,
      variant,
      backend: 'cpu',
      server: 'bin/llama-server',
      files: [],
      installedAt: '2026-01-01T00:00:00.000Z',
      sources: [],
    });
    for (const [id, m] of [
      ['b9-cpu', manifest('b9', 'cpu')],
      ['b10-vulkan', manifest('b10', 'vulkan')],
      ['b10-cpu', manifest('b10', 'cpu')],
    ] as const) {
      mkdirSync(path.join(root, id), { recursive: true });
      writeFileSync(path.join(root, id, 'install.json'), JSON.stringify(m));
    }
    mkdirSync(path.join(root, 'b11-cpu'));
    writeFileSync(path.join(root, 'b11-cpu', 'install.json'), '{bad json');
    mkdirSync(path.join(root, 'b12-cpu'));
    writeFileSync(path.join(root, 'b12-cpu', 'install.json'), JSON.stringify({ schema: 9 }));
    mkdirSync(path.join(root, '.tmp-b13-cpu-x'));
    writeFileSync(path.join(root, 'b14-cpu'), 'a file');
    const list = await listInstalled(enginesDir);
    expect(list.map((b) => b.id)).toEqual(['b10-cpu', 'b10-vulkan', 'b9-cpu']);
    expect(list[0]?.serverPath).toBe(path.join(root, 'b10-cpu', 'bin', 'llama-server'));

    await removeBuild(enginesDir, 'b9-cpu');
    expect(existsSync(path.join(root, 'b9-cpu'))).toBe(false);
    await expect(removeBuild(enginesDir, '../etc')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(removeBuild(enginesDir, 'b11-cpu')).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED' });
    await expect(removeBuild(enginesDir, 'b99-cpu')).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED' });
  });
});
