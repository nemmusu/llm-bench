import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyDockerError,
  daemonStateFrom,
  DockerCli,
  envValue,
  isOurs,
  knownDockerPaths,
  parseCliVersion,
  parseLabels,
  parseTimestampedLine,
} from '../../../../src/core/docker/cli';
import { DOCKER_FIXTURES, fail, manualProcess, ok, scriptedProc } from './helpers';

const fx = (n: string) => readFileSync(path.join(DOCKER_FIXTURES, n), 'utf8');

describe('DockerCli.command', () => {
  it('uses the override verbatim', async () => {
    const cli = new DockerCli({ proc: scriptedProc(() => ok()), platform: 'win32', env: {}, override: ['node', 'fake.mjs'] });
    expect(await cli.command()).toEqual(['node', 'fake.mjs']);
  });

  it('prefers plain "docker" when it is on PATH (Windows "Path" spelling)', async () => {
    const seen: string[] = [];
    const cli = new DockerCli({
      proc: scriptedProc(() => ok()),
      platform: 'win32',
      env: { Path: 'C:\\nothing;C:\\Docker\\bin' },
      exists: async (p) => {
        seen.push(p);
        return p === 'C:\\Docker\\bin\\docker.exe';
      },
    });
    expect(await cli.command()).toEqual(['docker']);
    expect(await cli.command()).toEqual(['docker']);
    expect(seen).toEqual(['C:\\nothing\\docker.exe', 'C:\\Docker\\bin\\docker.exe']);
  });

  it('falls back to the Docker Desktop install folders, then to "docker"', async () => {
    const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', PATH: '' };
    const desktop = 'C:\\Users\\u\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe';
    const cli = new DockerCli({ proc: scriptedProc(() => ok()), platform: 'win32', env, exists: async (p) => p === desktop });
    expect(await cli.command()).toEqual([desktop]);
    const none = new DockerCli({ proc: scriptedProc(() => ok()), platform: 'linux', env: { PATH: '/usr/bin:/bin' }, exists: async () => false });
    expect(await none.command()).toEqual(['docker']);
    const linux = new DockerCli({ proc: scriptedProc(() => ok()), platform: 'linux', env: {}, exists: async (p) => p === '/usr/local/bin/docker' });
    expect(await linux.command()).toEqual(['/usr/local/bin/docker']);
    const onPath = new DockerCli({ proc: scriptedProc(() => ok()), platform: 'linux', env: { PATH: '/opt/x:/usr/bin' }, exists: async (p) => p === '/usr/bin/docker' });
    expect(await onPath.command()).toEqual(['docker']);
  });

  it('checks the real file system by default', async () => {
    const cli = new DockerCli({ proc: scriptedProc(() => ok()), platform: 'linux', env: { PATH: path.join(DOCKER_FIXTURES, 'nope') } });
    expect((await cli.command()).length).toBe(1);
  });

  it('knows the install folders per platform', () => {
    expect(knownDockerPaths('win32', {})).toEqual([]);
    expect(knownDockerPaths('linux', {})).toContain('/usr/bin/docker');
    expect(envValue({ path: 'x' }, 'PATH', 'win32')).toBe('x');
    expect(envValue({ path: 'x' }, 'PATH', 'linux')).toBeUndefined();
    expect(envValue({}, 'PATH', 'win32')).toBeUndefined();
  });
});

describe('DockerCli commands', () => {
  const make = (handler: Parameters<typeof scriptedProc>[0], spawn?: Parameters<typeof scriptedProc>[1]) => {
    const proc = scriptedProc(handler, spawn);
    return { proc, cli: new DockerCli({ proc, platform: 'linux', env: {}, override: ['docker'], timeoutMs: 1234 }) };
  };

  it('runs with the prefix and the default timeout', async () => {
    const { proc, cli } = make(() => ok('x'));
    const out = await cli.exec(['info']);
    expect(out.stdout).toBe('x');
    expect(proc.calls[0]).toEqual({ cmd: 'docker', args: ['info'], opts: { timeoutMs: 1234 } });
    const two = new DockerCli({ proc, platform: 'linux', env: {}, override: ['node', 'fake.mjs'] });
    await two.exec(['ps'], { timeoutMs: 5 });
    expect(proc.calls[1]).toEqual({ cmd: 'node', args: ['fake.mjs', 'ps'], opts: { timeoutMs: 5 } });
    expect(two.timeoutMs).toBe(30_000);
  });

  it('parses version output (real daemon-down capture)', async () => {
    const { cli } = make(() => fail(1, fx('win-version-daemon-down.stderr.txt'), fx('win-version-daemon-down.stdout.json')));
    const v = await cli.version();
    expect(v.client).toEqual({ version: '29.8.0', context: 'desktop-linux', os: 'windows' });
    expect(v.server).toBeUndefined();
    expect(v.code).toBe(1);
  });

  it('inspects containers and images', async () => {
    const container = JSON.stringify([{ Id: 'abc', Name: '/gpubench-m', State: { Running: true, Status: 'running', ExitCode: 0 }, Config: { Labels: { gpubench: '1' } } }]);
    const { cli } = make((args) => {
      if (args[0] === 'container') return args[2] === 'abc' ? ok(container) : fail(1, 'Error: No such container: x', '[]');
      if (args[2] === 'present') return ok(JSON.stringify([{ Id: 'sha256:1', RepoTags: ['present'], RepoDigests: ['present@sha256:2', 3], Size: 10 }]));
      if (args[2] === 'odd') return ok(JSON.stringify([{}]));
      if (args[2] === 'empty') return ok('[]');
      if (args[2] === 'down') return fail(1, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
      return fail(1, 'Error response from daemon: No such image: missing', '[]');
    });
    expect(await cli.inspect('abc')).toMatchObject({ id: 'abc', name: 'gpubench-m', running: true, labels: { gpubench: '1' } });
    expect(await cli.inspect('x')).toBeUndefined();
    expect(await cli.imageInspect('present')).toEqual({ id: 'sha256:1', repoTags: ['present'], repoDigests: ['present@sha256:2'], size: 10 });
    expect(await cli.imageInspect('odd')).toEqual({ id: '', repoTags: [], repoDigests: [], size: 0 });
    expect(await cli.imageInspect('empty')).toBeUndefined();
    expect(await cli.imageInspect('missing')).toBeUndefined();
    await expect(cli.imageInspect('down')).rejects.toMatchObject({ code: 'DOCKER_NOT_RUNNING' });
  });

  it('lists containers by label', async () => {
    const rows = [
      JSON.stringify({ ID: 'a1', Names: 'gpubench-m1', Image: 'img', State: 'running', Labels: 'gpubench=1,gpubench.marker=m1' }),
      'WARNING: something',
      '',
      JSON.stringify({}),
    ].join('\n');
    const { proc, cli } = make((args) => (args.includes('label=bad') ? fail(1, 'permission denied while trying to connect') : ok(rows)));
    expect(await cli.ps(['gpubench=1'])).toEqual([
      { id: 'a1', name: 'gpubench-m1', image: 'img', state: 'running', labels: { gpubench: '1', 'gpubench.marker': 'm1' } },
      { id: '', name: '', image: '', state: '', labels: {} },
    ]);
    expect(proc.calls[0]?.args).toEqual(['ps', '-a', '--no-trunc', '--filter', 'label=gpubench=1', '--format', '{{json .}}']);
    await expect(cli.ps(['bad'])).rejects.toMatchObject({ code: 'DOCKER_PERMISSION' });
  });

  it('stops and removes, tolerating containers that are already gone', async () => {
    const { proc, cli } = make((args) => {
      if (args.includes('gone')) return fail(1, 'Error response from daemon: No such container: gone');
      if (args.includes('broken')) return fail(1, 'Cannot connect to the Docker daemon');
      return ok();
    });
    await cli.stop('c1', 10);
    expect(proc.calls[0]).toMatchObject({ args: ['stop', '-t', '10', 'c1'], opts: { timeoutMs: 40_000 } });
    await cli.stop('gone', 1);
    await expect(cli.stop('broken', 1)).rejects.toMatchObject({ code: 'DOCKER_NOT_RUNNING' });
    await cli.rm('c1');
    await cli.rm('c1', false);
    expect(proc.calls.slice(-2).map((c) => c.args)).toEqual([['rm', '-f', 'c1'], ['rm', 'c1']]);
    await cli.rm('gone');
    await expect(cli.rm('broken')).rejects.toMatchObject({ code: 'DOCKER_NOT_RUNNING' });
  });

  it('follows logs as a managed process', async () => {
    const mp = manualProcess();
    const { proc, cli } = make(() => ok(), () => mp);
    expect(await cli.followLogs('abc', { runId: 'r', marker: 'm' })).toBe(mp);
    expect(proc.spawns[0]).toEqual({ cmd: 'docker', args: ['logs', '-f', '--timestamps', 'abc'], owner: { runId: 'r', marker: 'm' } });
    await cli.spawn(['pull', 'x'], { runId: 'r', marker: 'm' }, { A: '1' });
    expect(proc.spawns[1]?.env).toEqual({ A: '1' });
  });
});

describe('parsers', () => {
  it('parses RFC3339Nano timestamps with sub-ms precision', () => {
    const p = parseTimestampedLine('2026-10-06T05:12:34.123456789Z hello world');
    expect(p.text).toBe('hello world');
    expect(p.tsMs).toBeCloseTo(Date.parse('2026-10-06T05:12:34Z') + 123.456789, 5);
    expect(parseTimestampedLine('2026-10-06T05:12:34+02:00 x')).toEqual({ tsMs: Date.parse('2026-10-06T03:12:34Z'), text: 'x' });
    expect(parseTimestampedLine('no stamp')).toEqual({ text: 'no stamp' });
    expect(parseTimestampedLine('2026-13-45T99:99:99Z bad')).toEqual({ text: '2026-13-45T99:99:99Z bad' });
  });

  it('parses label strings and ownership', () => {
    expect(parseLabels('a=1,b=x=y,broken,=v')).toEqual({ a: '1', b: 'x=y' });
    expect(isOurs({ gpubench: '1', 'gpubench.marker': 'm' }, 'm')).toBe(true);
    expect(isOurs({ gpubench: '1', 'gpubench.marker': 'm' }, 'other')).toBe(false);
    expect(isOurs({ gpubench: '1' })).toBe(true);
    expect(isOurs({ gpubench: 'true', 'gpubench.marker': 'm' }, 'm')).toBe(false);
  });

  it('parses running, podman, windows and broken version JSON', () => {
    const base = { code: 0, stderr: '', timedOut: false };
    const running = parseCliVersion({
      ...base,
      stdout: JSON.stringify({ Client: { Version: '29.8.0' }, Server: { Version: '29.8.0', Os: 'linux', Platform: { Name: 'Docker Desktop 4.47.0' }, Components: [{ Name: 'Engine' }, null] } }),
    });
    expect(running.server).toEqual({ version: '29.8.0', os: 'linux', platform: 'Docker Desktop 4.47.0', podman: false });
    expect(running.client).toEqual({ version: '29.8.0' });
    expect(parseCliVersion({ ...base, stdout: JSON.stringify({ Client: {}, Server: { Components: [{ Name: 'Podman Engine' }] } }) }).server).toEqual({
      version: '',
      podman: true,
    });
    expect(parseCliVersion({ ...base, stdout: JSON.stringify({ Server: { Platform: { Name: 'Podman' } } }) }).server?.podman).toBe(true);
    expect(
      parseCliVersion({ ...base, stderr: 'Emulate Docker CLI using podman. Create /etc/containers/nodocker to quiet msg.', stdout: JSON.stringify({ Server: {} }) }).server
        ?.podman,
    ).toBe(true);
    expect(parseCliVersion({ ...base, stdout: 'null' })).toEqual({ code: 0, timedOut: false, stdout: 'null', stderr: '' });
    expect(parseCliVersion({ ...base, stdout: fx('wsl-shim.stdout.txt') }).client).toBeUndefined();
  });
});

describe('classifyDockerError', () => {
  const c = (stderr: string, fallback?: Parameters<typeof classifyDockerError>[1]) =>
    classifyDockerError({ code: 125, stdout: '', stderr }, fallback);

  it('recognises installation, WSL and daemon states', () => {
    expect(classifyDockerError({ code: null, stdout: '', stderr: 'Error: spawn docker ENOENT' }).code).toBe('DOCKER_NOT_INSTALLED');
    expect(classifyDockerError({ code: 0, stdout: fx('wsl-shim.stdout.txt'), stderr: '' }).params).toMatchObject({ reason: 'wsl-integration' });
    expect(c(fx('win-version-daemon-down.stderr.txt'))).toMatchObject({ code: 'DOCKER_NOT_RUNNING', params: { reason: 'stopped' } });
    expect(c('request returned 500 Internal Server Error for API route and version http://x/v1.51/version').params).toMatchObject({ reason: 'starting' });
    expect(c('permission denied while trying to connect to the Docker daemon socket').code).toBe('DOCKER_PERMISSION');
    expect(c('error during connect: open //./pipe/docker_engine: Access is denied.').code).toBe('DOCKER_PERMISSION');
  });

  it('recognises GPU, port, image, mount and flag problems', () => {
    expect(c('docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]]').code).toBe('DOCKER_NO_GPU');
    expect(c('nvidia-container-cli: initialization error: nvml error: driver not loaded: unknown').code).toBe('DOCKER_NO_GPU');
    expect(c('nvidia-container-cli: requirement error: unsatisfied condition: cuda>=13.0, please update your driver')).toMatchObject({
      code: 'DRIVER_TOO_OLD',
      params: { cuda: '13.0' },
    });
    expect(c('Bind for 127.0.0.1:8080 failed: port is already allocated').code).toBe('ENGINE_PORT_IN_USE');
    expect(c('Ports are not available: exposing port TCP 127.0.0.1:8080').code).toBe('ENGINE_PORT_IN_USE');
    expect(c('docker: Error response from daemon: No such image: x')).toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { reason: 'image-missing' } });
    expect(c("pull access denied for x, repository does not exist or may require 'docker login'").code).toBe('DOCKER_PULL_FAILED');
    expect(c('write /var/lib/docker: no space left on device').code).toBe('DISK_FULL');
    expect(c('invalid mount config for type "bind": bind source path does not exist: /m')).toMatchObject({ code: 'MODEL_NOT_FOUND', params: { reason: 'mount' } });
    expect(c('The container name "/x" is already in use by container "abc"')).toMatchObject({ params: { reason: 'name-conflict' } });
    expect(c("unknown flag: --bogus\nSee 'docker run --help'.")).toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '--bogus' } });
    expect(c("unknown shorthand flag: 'z' in -z")).toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '-z' } });
    expect(c('docker: invalid reference format.').code).toBe('VALIDATION');
    expect(c('something odd', 'ENGINE_START_FAILED').code).toBe('ENGINE_START_FAILED');
    expect(c('something odd').code).toBe('INTERNAL');
    expect(c('x'.repeat(5000)).detail?.length).toBe(2000);
  });

  it('exposes the daemon state alone', () => {
    expect(daemonStateFrom('all good')).toBeUndefined();
    expect(daemonStateFrom('Docker Desktop is starting')).toBe('starting');
  });
});

describe('DockerCli edge cases', () => {
  it('finds docker on PATH with the real file system', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const os = await import('node:os');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gb-dcli-'));
    try {
      writeFileSync(path.join(dir, 'docker'), '');
      const cli = new DockerCli({ proc: scriptedProc(() => ok()), platform: 'linux', env: { PATH: dir } });
      expect(await cli.command()).toEqual(['docker']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores inspect output that is not a JSON array', async () => {
    const cli = new DockerCli({ proc: scriptedProc(() => ok('{"Id":"x"}')), platform: 'linux', env: {}, override: ['docker'] });
    expect(await cli.imageInspect('a/b')).toBeUndefined();
    expect(await cli.inspect('x')).toBeUndefined();
  });
});
