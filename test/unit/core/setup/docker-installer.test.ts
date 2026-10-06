import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunOptions } from '../../../../src/core/deps';
import { LINUX_SCRIPT, LINUX_STEPS, SCRIPT_NAME } from '../../../../src/core/setup/docker-linux';
import {
  DOCKER_DESKTOP_URLS,
  DockerInstaller,
  INSTALLER_FILE,
  type DockerInstallProgress,
  type DockerInstallerOptions,
} from '../../../../src/core/setup/docker-installer';
import { parseOsRelease } from '../../../../src/core/setup/os-release';
import { LAUNCH_SCRIPT, VERIFY_SCRIPT } from '../../../../src/core/setup/windows';
import { FakeClock, FakeRunner, fixture, ok, type FakeProcess } from '../telemetry/fakes';

const SIG_VALID = fixture('setup/authenticode-docker-valid.stdout.txt');
const SIG_UNSIGNED = fixture('setup/authenticode-unsigned.stdout.txt');
const WSL_OK = fixture('setup/wsl-status.utf8.stdout.txt');
const WSL_VERSION = fixture('setup/wsl-version.utf8.stdout.txt');
const UBUNTU = parseOsRelease('ID=ubuntu\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble');
const PAYLOAD = Buffer.alloc(3000, 1);

const dirs: string[] = [];
afterEach(() => {
  dirs.length = 0;
});
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'gb-docker-'));
  dirs.push(d);
  return d;
};

/** Serves the installer in three chunks; HEAD answers with the size. */
function fakeFetch(opts: { status?: number; headStatus?: number; headLength?: string | null; headThrows?: boolean; noLength?: boolean } = {}) {
  const calls: { url: string; method: string }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (method === 'HEAD') {
      if (opts.headThrows) throw new Error('offline');
      const headers: Record<string, string> = {};
      if (opts.headLength !== null) headers['content-length'] = opts.headLength ?? '635493296';
      return new Response(null, { status: opts.headStatus ?? 200, headers });
    }
    if (opts.status && opts.status !== 200) return new Response('nope', { status: opts.status });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 3; i++) c.enqueue(PAYLOAD.subarray(i * 1000, (i + 1) * 1000));
        c.close();
      },
    });
    return new Response(body, { status: 200, ...(opts.noLength ? {} : { headers: { 'content-length': String(PAYLOAD.length) } }) });
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

interface WinScript {
  wslStatus?: ReturnType<typeof ok>;
  verify?: ReturnType<typeof ok>;
  launch?: ReturnType<typeof ok> | ((opts?: RunOptions) => ReturnType<typeof ok>);
}

function winRunner(s: WinScript = {}) {
  const seenInstaller: { exists: boolean; file: string }[] = [];
  const proc = new FakeRunner((cmd, args, opts) => {
    if (cmd.endsWith('wsl.exe')) return args[0] === '--status' ? (s.wslStatus ?? ok(WSL_OK)) : ok(WSL_VERSION);
    const script = args.at(-1);
    if (script === VERIFY_SCRIPT) {
      const file = opts?.env?.GPUBENCH_VERIFY_FILE as string;
      seenInstaller.push({ file, exists: existsSync(file) });
      return s.verify ?? ok(SIG_VALID);
    }
    if (script === LAUNCH_SCRIPT) return typeof s.launch === 'function' ? s.launch(opts) : (s.launch ?? ok('{"exitCode":0}'));
    return ok('', 1);
  });
  return { proc, seenInstaller };
}

function installer(over: Partial<DockerInstallerOptions> = {}) {
  const cacheDir = tmp();
  const fetch = fakeFetch();
  const inst = new DockerInstaller({
    platform: 'win32',
    arch: 'x64',
    proc: winRunner().proc,
    fetch: fetch.fn,
    clock: new FakeClock(),
    cacheDir,
    env: { SystemRoot: 'C:\\Windows' },
    progressIntervalMs: 0,
    ...over,
  });
  return { inst, cacheDir, fetch };
}

const leftovers = (cacheDir: string) => {
  const root = path.join(cacheDir, 'docker-installer');
  return existsSync(root) ? readdirSync(root) : [];
};

describe('DockerInstaller.plan', () => {
  it('Windows: official URL, HEAD size and WSL status', async () => {
    const { proc } = winRunner();
    const { inst, fetch } = installer({ proc });
    expect(await inst.plan()).toEqual({
      platform: 'win32',
      kind: 'docker-desktop',
      supported: true,
      url: DOCKER_DESKTOP_URLS.x64,
      sizeBytes: 635493296,
      wsl: { available: true, defaultVersion: 2, version: '2.7.14.0', meetsDockerMinimum: true },
    });
    expect(fetch.calls).toEqual([{ url: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe', method: 'HEAD' }]);
  });

  it('Windows: size unknown when HEAD fails or says nothing', async () => {
    for (const f of [fakeFetch({ headThrows: true }), fakeFetch({ headStatus: 404 }), fakeFetch({ headLength: null })]) {
      const { inst } = installer({ fetch: f.fn });
      const plan = await inst.plan(new AbortController().signal);
      expect(plan).toMatchObject({ supported: true });
      expect(plan).not.toHaveProperty('sizeBytes');
    }
    const { inst } = installer({ arch: 'ia32' });
    await expect(inst.installerSize()).resolves.toBeUndefined();
    expect(await inst.plan()).toEqual({ platform: 'win32', kind: 'docker-desktop', supported: false, reason: 'unsupported-arch', arch: 'ia32' });
    expect(DOCKER_DESKTOP_URLS.arm64).toContain('/arm64/');
  });

  it('Linux: distro support and the exact argv for a valid user', async () => {
    const { inst } = installer({ platform: 'linux', osRelease: () => Promise.resolve(UBUNTU), userName: () => 'nemmusu' });
    expect(await inst.plan()).toEqual({
      platform: 'linux',
      kind: 'docker-linux',
      steps: LINUX_STEPS,
      supported: true,
      distro: 'ubuntu',
      dockerOs: 'ubuntu',
      codename: 'noble',
      argv: ['pkexec', '/bin/bash', '-c', LINUX_SCRIPT, SCRIPT_NAME, 'nemmusu'],
    });
    const odd = installer({ platform: 'linux', osRelease: () => Promise.resolve(UBUNTU), userName: () => 'Weird User' }).inst;
    expect(await odd.plan()).not.toHaveProperty('argv');
    const fedora = installer({ platform: 'linux', osRelease: () => Promise.resolve(parseOsRelease('ID=fedora')) }).inst;
    expect(await fedora.plan()).toMatchObject({ supported: false, reason: 'unsupported-distro', distro: 'fedora' });
  });

  it('Linux: default os-release reader and login name', async () => {
    const plan = await installer({ platform: 'linux' }).inst.plan();
    expect(plan.kind).toBe('docker-linux');
    expect(typeof plan.supported).toBe('boolean');
  });

  it('other platforms: nothing to install', async () => {
    expect(await installer({ platform: 'darwin' }).inst.plan()).toEqual({ platform: 'darwin', kind: 'none', supported: false, reason: 'unsupported-platform' });
    await expect(installer({ platform: 'darwin' }).inst.install(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'DOCKER_UNSUPPORTED' });
  });

  it('exposes the Linux script for the transparency panel', () => {
    expect(installer().inst.linuxScript()).toEqual({ script: LINUX_SCRIPT, steps: LINUX_STEPS });
  });
});

describe('DockerInstaller Windows install', () => {
  it('downloads, verifies the signature, runs the installer, re-checks and cleans up', async () => {
    const { proc, seenInstaller } = winRunner();
    const progress: DockerInstallProgress[] = [];
    const { inst, cacheDir } = installer({ proc, dockerStatus: () => Promise.resolve({ state: 'stopped' }) });
    const r = await inst.install((p) => progress.push(p), new AbortController().signal);
    expect(r).toEqual({ kind: 'docker-desktop', outcome: 'installed', exitCode: 0, docker: { state: 'stopped' } });
    expect(progress[0]).toEqual({ stage: 'download', bytesDone: 0 });
    expect(progress.filter((p) => p.stage === 'download').at(-1)).toEqual({ stage: 'download', bytesDone: 3000, bytesTotal: 3000 });
    expect(progress.slice(-2).map((p) => p.stage)).toEqual(['verify', 'installer']);
    // The signature was checked on the downloaded file, before the launch.
    expect(seenInstaller).toHaveLength(1);
    expect(seenInstaller[0]?.exists).toBe(true);
    expect(path.basename(seenInstaller[0]?.file ?? '')).toBe(INSTALLER_FILE);
    const scripts = proc.calls.filter((c) => !c.cmd.endsWith('wsl.exe')).map((c) => c.args.at(-1));
    expect(scripts).toEqual([VERIFY_SCRIPT, LAUNCH_SCRIPT]);
    expect(leftovers(cacheDir)).toEqual([]);
  });

  it('throttles download progress', async () => {
    const progress: DockerInstallProgress[] = [];
    const { inst } = installer({ progressIntervalMs: 60_000 });
    await inst.install((p) => progress.push(p), new AbortController().signal);
    expect(progress.filter((p) => p.stage === 'download')).toHaveLength(2);
  });

  it('uses the default throttle and copes with a server that sends no length', async () => {
    const progress: DockerInstallProgress[] = [];
    const { inst } = installer({ progressIntervalMs: undefined, fetch: fakeFetch({ noLength: true }).fn });
    await inst.install((p) => progress.push(p), new AbortController().signal);
    expect(progress.filter((p) => p.stage === 'download')).toEqual([
      { stage: 'download', bytesDone: 0 },
      { stage: 'download', bytesDone: 1000 },
    ]);
  });

  it('reports a probable reboot (installer exit code, or WSL missing before)', async () => {
    const a = installer({ proc: winRunner({ launch: ok('{"exitCode":3010}') }).proc });
    expect(await a.inst.install(() => {}, new AbortController().signal)).toEqual({ kind: 'docker-desktop', outcome: 'reboot-maybe-required', exitCode: 3010 });
    const b = installer({ proc: winRunner({ wslStatus: ok('not installed', 1) }).proc, dockerStatus: () => Promise.reject(new Error('cli broken')) });
    expect(await b.inst.install(() => {}, new AbortController().signal)).toEqual({ kind: 'docker-desktop', outcome: 'reboot-maybe-required', exitCode: 0 });
  });

  it('never runs an installer whose signature does not check out', async () => {
    const { proc } = winRunner({ verify: ok(SIG_UNSIGNED) });
    const { inst, cacheDir } = installer({ proc });
    await expect(inst.install(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'bad-signature' } });
    expect(proc.calls.some((c) => c.args.at(-1) === LAUNCH_SCRIPT)).toBe(false);
    expect(leftovers(cacheDir)).toEqual([]);
  });

  it('maps UAC refusal and installer cancel to CANCELLED', async () => {
    for (const out of ['{"error":"start-failed","nativeErrorCode":1223,"message":"annullata"}', '{"exitCode":1602}']) {
      const { inst } = installer({ proc: winRunner({ launch: ok(out) }).proc });
      await expect(inst.install(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'CANCELLED', params: { reason: 'user-cancelled' } });
    }
  });

  it('maps launch and installer failures', async () => {
    const run = (out: string) => installer({ proc: winRunner({ launch: ok(out) }).proc }).inst.install(() => {}, new AbortController().signal);
    await expect(run('{"error":"start-failed","nativeErrorCode":2,"message":"not found"}')).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      message: 'Docker installer did not start: not found',
      params: { reason: 'launch-failed', nativeErrorCode: 2 },
    });
    const noCode = await run('{"error":"start-failed"}').catch((e: unknown) => e);
    expect(noCode).toMatchObject({ message: 'Docker installer did not start: unknown error' });
    expect((noCode as { params: Record<string, unknown> }).params).not.toHaveProperty('nativeErrorCode');
    await expect(run('{"exitCode":1}')).rejects.toMatchObject({ params: { reason: 'installer-failed', exitCode: 1 } });
  });

  it('stops when cancelled during verification or while the installer runs', async () => {
    const ac1 = new AbortController();
    const proc1 = new FakeRunner((cmd, args) => {
      if (cmd.endsWith('wsl.exe')) return ok(WSL_OK);
      if (args.at(-1) === VERIFY_SCRIPT) ac1.abort();
      return ok(SIG_VALID);
    });
    await expect(installer({ proc: proc1 }).inst.install(() => {}, ac1.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(proc1.calls.some((c) => c.args.at(-1) === LAUNCH_SCRIPT)).toBe(false);

    const ac2 = new AbortController();
    const proc2 = winRunner({
      launch: () => {
        ac2.abort();
        return ok('', null);
      },
    }).proc;
    await expect(installer({ proc: proc2 }).inst.install(() => {}, ac2.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('fails on download errors and unsupported CPUs', async () => {
    const { inst, cacheDir } = installer({ fetch: fakeFetch({ status: 503 }).fn });
    await expect(inst.install(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    expect(leftovers(cacheDir)).toEqual([]);
    await expect(installer({ arch: 'ia32' }).inst.installWindows(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'DOCKER_UNSUPPORTED' });
  });

  it('uses an injected installer URL', async () => {
    const f = fakeFetch();
    await installer({ fetch: f.fn, installerUrl: 'http://127.0.0.1:1/x.exe' }).inst.install(() => {}, new AbortController().signal);
    expect(f.calls[0]?.url).toBe('http://127.0.0.1:1/x.exe');
  });
});

describe('DockerInstaller Linux install', () => {
  function pkexec(lines: string[], code: number) {
    return new FakeRunner(undefined, undefined, (p: FakeProcess) => {
      queueMicrotask(() => {
        for (const l of lines) p.emit(l);
        p.exit(code);
      });
    });
  }

  it('runs the fixed script and maps steps to progress', async () => {
    const proc = pkexec(['##GPUBENCH_STEP 1/7 prepare', '##GPUBENCH_STEP 5/7 nvidia-toolkit', '##GPUBENCH_DONE'], 0);
    const progress: DockerInstallProgress[] = [];
    const { inst } = installer({
      platform: 'linux',
      proc,
      osRelease: () => Promise.resolve(UBUNTU),
      userName: () => 'nemmusu',
      dockerStatus: () => Promise.resolve({ state: 'no-permission' }),
    });
    const r = await inst.install((p) => progress.push(p), new AbortController().signal);
    expect(r).toEqual({ kind: 'docker-linux', outcome: 'relogin-required', docker: { state: 'no-permission' } });
    expect(progress).toEqual([
      { stage: 'prepare', bytesDone: 1, bytesTotal: 7 },
      { stage: 'nvidia-toolkit', bytesDone: 5, bytesTotal: 7 },
    ]);
    expect(proc.spawned[0]?.spec.args.at(-1)).toBe('nemmusu');
  });

  it('works without a docker re-check', async () => {
    const proc = pkexec(['##GPUBENCH_DONE'], 0);
    const { inst } = installer({ platform: 'linux', proc, osRelease: () => Promise.resolve(UBUNTU), userName: () => 'u' });
    expect(await inst.install(() => {}, new AbortController().signal)).toEqual({ kind: 'docker-linux', outcome: 'relogin-required' });
  });

  it('refuses unsupported distros before asking for a password', async () => {
    const proc = pkexec([], 0);
    const { inst } = installer({ platform: 'linux', proc, osRelease: () => Promise.resolve(parseOsRelease('ID=arch')) });
    await expect(inst.install(() => {}, new AbortController().signal)).rejects.toMatchObject({
      code: 'DOCKER_UNSUPPORTED',
      params: { reason: 'unsupported-distro', distro: 'arch' },
    });
    const none = installer({ platform: 'linux', proc, osRelease: () => Promise.resolve(undefined) }).inst;
    await expect(none.install(() => {}, new AbortController().signal)).rejects.toMatchObject({ params: { reason: 'no-os-release', distro: '' } });
    expect(proc.spawned).toHaveLength(0);
  });
});
