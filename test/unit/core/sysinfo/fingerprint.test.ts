import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hardwareFingerprintSchema, type GpuInfo } from '../../../../src/contract/hardware';
import {
  PS_SYSINFO_SCRIPT,
  countPhysicalCores,
  createSysInfo,
  hostIdFrom,
  parseOsRelease,
  parsePowercfg,
  parsePsSysinfo,
  parseRegValue,
  windowsName,
  type OsApi,
} from '../../../../src/core/sysinfo/fingerprint';
import { FakeRunner, fixture, memoryLogger, ok, type RunHandler } from '../telemetry/fakes';

const os = (over: Partial<OsApi> = {}): OsApi => ({
  hostname: () => 'DESKTOP-DHTKFJ0',
  cpus: () => Array.from({ length: 20 }, () => ({ model: 'Intel(R) Core(TM) Ultra 7 265F  ' })),
  totalmem: () => 205_751_443_456,
  release: () => '10.0.26300',
  ...over,
});

const GPU: GpuInfo = {
  index: 0,
  uuid: 'GPU-3d36b2ac-a47c-233d-3308-4c71f3bc4a30',
  name: 'NVIDIA GeForce RTX 5090',
  vendor: 'nvidia',
  memoryTotalMiB: 32607,
  memoryUsedMiB: 1858,
  driverVersion: '617.14',
  cudaVersion: '13.4',
};

/** Answers like this Windows PC (real captures). */
const windowsHandler: RunHandler = (cmd, args) => {
  if (cmd === 'reg' && args[1]?.endsWith('Cryptography')) return ok(fixture('sysinfo/win-reg-machineguid.txt', { crlf: true }));
  if (cmd === 'reg') return ok(fixture('sysinfo/win-reg-displayversion.txt', { crlf: true }));
  if (cmd === 'powershell') return ok(fixture('sysinfo/win-ps-sysinfo.txt', { crlf: true }));
  if (cmd === 'powercfg') return ok(fixture('sysinfo/win-powercfg.txt'));
  return ok('', 1);
};

const wslFiles: Record<string, string> = {
  '/etc/machine-id': fixture('sysinfo/wsl-machine-id.txt'),
  '/etc/os-release': fixture('sysinfo/wsl-os-release.txt'),
  '/proc/version': fixture('sysinfo/wsl-proc-version.txt'),
  '/proc/cpuinfo': fixture('sysinfo/wsl-cpuinfo.txt'),
};
const readFrom = (files: Record<string, string>) => (p: string) =>
  p in files ? Promise.resolve(files[p]!) : Promise.reject(Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' }));

describe('Windows parsers (real captures)', () => {
  it('reads REG_SZ values from reg query', () => {
    expect(parseRegValue(fixture('sysinfo/win-reg-machineguid.txt', { crlf: true }), 'MachineGuid')).toBe('0f1e2d3c-4b5a-4697-8877-665544332211');
    expect(parseRegValue(fixture('sysinfo/win-reg-displayversion.txt'), 'displayversion')).toBe('26H2');
    expect(parseRegValue(fixture('sysinfo/win-reg-displayversion.txt'), 'Other')).toBeUndefined();
    expect(parseRegValue('    Empty    REG_SZ    \r\n', 'Empty')).toBeUndefined();
  });

  it('takes the localized plan name between the outer parentheses', () => {
    expect(parsePowercfg(fixture('sysinfo/win-powercfg.txt'))).toBe('Prestazioni elevate');
    expect(parsePowercfg(fixture('sysinfo/handmade/powercfg-it-crlf.txt'))).toBe('Bilanciato');
    expect(parsePowercfg(fixture('sysinfo/handmade/powercfg-en.txt'))).toBe('Balanced');
    expect(parsePowercfg(fixture('sysinfo/handmade/powercfg-nested.txt'))).toBe('My (custom) plan');
    expect(parsePowercfg('no plan here')).toBeUndefined();
    expect(parsePowercfg('GUID: x  ( )')).toBeUndefined();
  });

  it('parses the PowerShell key=value output, ignoring junk', () => {
    expect(parsePsSysinfo(fixture('sysinfo/win-ps-sysinfo.txt', { crlf: true }))).toEqual({ cores: 20, caption: 'Microsoft Windows 11 Pro' });
    expect(parsePsSysinfo('cores=\ncaption=\ncores=abc\nnoise')).toEqual({});
    expect(parsePsSysinfo('cores=0')).toEqual({});
    // The two separate commands from the plan produce the same values.
    expect(Number(fixture('sysinfo/win-ps-cores.txt').trim())).toBe(20);
    expect(fixture('sysinfo/win-ps-os-caption.txt').trim()).toBe('Microsoft Windows 11 Pro');
    expect(PS_SYSINFO_SCRIPT).not.toContain('"');
  });

  it('builds "Windows 11 Pro 26H2"', () => {
    expect(windowsName('Microsoft Windows 11 Pro', '26H2', '10.0.26300')).toBe('Windows 11 Pro 26H2');
    expect(windowsName('Microsoft Windows Server 2022 Datacenter', undefined, '10.0.20348')).toBe('Windows Server 2022 Datacenter');
    expect(windowsName(undefined, '24H2', '10.0.26100')).toBe('Windows 10.0.26100 24H2');
    expect(windowsName('  ', undefined, '10.0')).toBe('Windows 10.0');
  });
});

describe('Linux parsers (WSL captures + hand-made)', () => {
  it('reads PRETTY_NAME, else NAME + VERSION', () => {
    expect(parseOsRelease(fixture('sysinfo/wsl-os-release.txt'))).toBe('Ubuntu 24.04.5 LTS');
    expect(parseOsRelease(fixture('sysinfo/handmade/os-release-no-pretty.txt'))).toBe('Fedora Linux 40 (Workstation Edition)');
    expect(parseOsRelease("NAME='Alpine Linux'")).toBe('Alpine Linux');
    expect(parseOsRelease('# nothing\n')).toBeUndefined();
  });

  it('counts unique (physical id, core id) pairs', () => {
    expect(countPhysicalCores(fixture('sysinfo/wsl-cpuinfo.txt'))).toBe(20);
    expect(countPhysicalCores(fixture('sysinfo/handmade/cpuinfo-2socket-ht.txt'))).toBe(4);
    expect(countPhysicalCores(fixture('sysinfo/handmade/cpuinfo-2socket-ht.txt', { crlf: true }))).toBe(4);
    expect(countPhysicalCores(fixture('sysinfo/handmade/cpuinfo-arm.txt'))).toBeUndefined();
    expect(countPhysicalCores('processor : 0\ncore id : 3\n\nprocessor : 1\ncore id : 3\n')).toBe(1);
  });

  it('hashes the machine id with the gpu-bench salt', () => {
    const want = createHash('sha256').update('gpu-bench:a1b2c3d4e5f60718293a4b5c6d7e8f90').digest('hex');
    expect(hostIdFrom(' A1B2C3D4E5F60718293A4B5C6D7E8F90\n')).toBe(want);
    expect(hostIdFrom('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createSysInfo', () => {
  it('builds the Windows fingerprint from reg, PowerShell, powercfg and the telemetry probe', async () => {
    const runner = new FakeRunner(windowsHandler);
    let probes = 0;
    const sys = createSysInfo(
      { proc: runner, platform: 'win32', arch: 'x64' },
      {
        os: os(),
        telemetry: {
          probe: () => {
            probes++;
            return Promise.resolve([GPU]);
          },
        },
      },
    );
    const fp = await sys.getFingerprint();
    expect(hardwareFingerprintSchema.parse(fp)).toEqual(fp);
    expect(fp).toEqual({
      hostId: hostIdFrom('0f1e2d3c-4b5a-4697-8877-665544332211'),
      hostLabel: 'DESKTOP-DHTKFJ0',
      gpus: [
        {
          index: 0,
          uuid: 'GPU-3d36b2ac-a47c-233d-3308-4c71f3bc4a30',
          name: 'NVIDIA GeForce RTX 5090',
          vendor: 'nvidia',
          memoryTotalMiB: 32607,
          driverVersion: '617.14',
          cudaVersion: '13.4',
        },
      ],
      cpu: { model: 'Intel(R) Core(TM) Ultra 7 265F', cores: 20, threads: 20 },
      ramBytes: 205_751_443_456,
      os: { platform: 'win32', release: '10.0.26300', arch: 'x64', name: 'Windows 11 Pro 26H2', isWsl: false, powerPlan: 'Prestazioni elevate' },
    });
    expect(runner.calls.map((c) => [c.cmd, ...c.args.slice(0, 3)])).toEqual([
      ['reg', 'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v'],
      ['powershell', '-NoProfile', '-NonInteractive', '-Command'],
      ['reg', 'query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v'],
      ['powercfg', '/getactivescheme'],
    ]);
    expect(runner.calls[1]!.opts?.timeoutMs).toBe(30_000);
    // Cached: no more processes, no more probes.
    expect(await sys.getFingerprint()).toEqual(fp);
    expect(runner.calls).toHaveLength(4);
    expect(probes).toBe(1);
    sys.invalidate();
    await sys.getFingerprint();
    expect(runner.calls).toHaveLength(8);
    expect(probes).toBe(2);
  });

  it('degrades on Windows when every command fails (hostname id, threads as cores, no plan)', async () => {
    const runner = new FakeRunner(() => ok('', 1, { timedOut: true }));
    const fp = await createSysInfo({ proc: runner, platform: 'win32', arch: 'x64' }, { os: os() }).getFingerprint();
    expect(fp.hostId).toBe(hostIdFrom('DESKTOP-DHTKFJ0'));
    expect(fp.cpu.cores).toBe(20);
    expect(fp.os).toEqual({ platform: 'win32', release: '10.0.26300', arch: 'x64', name: 'Windows 10.0.26300', isWsl: false });
    expect(fp.gpus).toEqual([]);
    const half = new FakeRunner((cmd) => (cmd === 'powercfg' ? ok('garbage') : ok('', 0)));
    const fp2 = await createSysInfo({ proc: half, platform: 'win32', arch: 'x64' }, { os: os() }).getFingerprint();
    expect(fp2.os.powerPlan).toBeUndefined();
  });

  it('builds the WSL fingerprint from /etc and /proc files', async () => {
    const runner = new FakeRunner();
    const fp = await createSysInfo(
      { proc: runner, platform: 'linux', arch: 'x64' },
      { os: os({ release: () => '6.18.33.2-microsoft-standard-WSL2' }), readFile: readFrom(wslFiles) },
    ).getFingerprint();
    expect(fp.hostId).toBe(hostIdFrom('a1b2c3d4e5f60718293a4b5c6d7e8f90'));
    expect(fp.cpu).toEqual({ model: 'Intel(R) Core(TM) Ultra 7 265F', cores: 20, threads: 20 });
    expect(fp.os).toEqual({ platform: 'linux', release: '6.18.33.2-microsoft-standard-WSL2', arch: 'x64', name: 'Ubuntu 24.04.5 LTS', isWsl: true });
    expect(runner.calls).toHaveLength(0);
  });

  it('uses the dbus machine-id / usr/lib os-release fallbacks and hyper-threaded core counting', async () => {
    const files = {
      '/var/lib/dbus/machine-id': 'feedface\n',
      '/usr/lib/os-release': fixture('sysinfo/handmade/os-release-no-pretty.txt'),
      '/proc/version': 'Linux version 6.8.0-45-generic (buildd@lcy02-amd64-075)',
      '/proc/cpuinfo': fixture('sysinfo/handmade/cpuinfo-2socket-ht.txt'),
    };
    const cpus = () => Array.from({ length: 8 }, () => ({ model: 'Intel(R) Xeon(R) Gold 6130 CPU @ 2.10GHz' }));
    const fp = await createSysInfo({ proc: new FakeRunner(), platform: 'linux', arch: 'x64' }, { os: os({ cpus }), readFile: readFrom(files) }).getFingerprint();
    expect(fp.hostId).toBe(hostIdFrom('feedface'));
    expect(fp.cpu).toMatchObject({ cores: 4, threads: 8 });
    expect(fp.os).toMatchObject({ name: 'Fedora Linux 40 (Workstation Edition)', isWsl: false });
  });

  it('degrades on Linux when nothing is readable, and supports macOS minimally', async () => {
    const empty = { '/etc/machine-id': '  \n', '/etc/os-release': '' };
    const fp = await createSysInfo(
      { proc: new FakeRunner(), platform: 'linux', arch: 'arm64' },
      { os: os({ cpus: () => [], release: () => '6.1' }), readFile: readFrom(empty) },
    ).getFingerprint();
    expect(fp.hostId).toBe(hostIdFrom('DESKTOP-DHTKFJ0'));
    expect(fp.cpu).toEqual({ model: 'unknown', cores: 1, threads: 1 });
    expect(fp.os).toMatchObject({ name: 'Linux 6.1', isWsl: false });

    const mac = await createSysInfo({ proc: new FakeRunner(), platform: 'darwin', arch: 'arm64' }, { os: os({ release: () => '24.0.0' }) }).getFingerprint();
    expect(mac.os).toEqual({ platform: 'darwin', release: '24.0.0', arch: 'arm64', name: 'macOS 24.0.0', isWsl: false });
  });

  it('keeps probing GPUs until one is found (driver installed later); probe errors are logged', async () => {
    const log = memoryLogger();
    let result: () => Promise<GpuInfo[]> = () => Promise.reject(new Error('nvidia-smi exploded'));
    const sys = createSysInfo(
      { proc: new FakeRunner(windowsHandler), platform: 'win32', arch: 'x64', log },
      { os: os(), telemetry: { probe: () => result() } },
    );
    expect((await sys.getFingerprint()).gpus).toEqual([]);
    expect(log.entries[0]!.msg).toBe('GPU probe failed for the fingerprint');
    result = () => Promise.resolve([]);
    expect((await sys.getFingerprint()).gpus).toEqual([]);
    result = () => Promise.resolve([GPU]);
    expect((await sys.getFingerprint()).gpus).toHaveLength(1);
    result = () => Promise.reject(new Error('not called again'));
    expect((await sys.getFingerprint()).gpus).toHaveLength(1);

    const quiet = createSysInfo({ proc: new FakeRunner(windowsHandler), platform: 'win32', arch: 'x64' }, { os: os(), telemetry: { probe: () => Promise.reject(new Error('x')) } });
    expect((await quiet.getFingerprint()).gpus).toEqual([]);
  });

  it('retries the host part after a failure instead of caching the error', async () => {
    let fail = true;
    const sys = createSysInfo(
      { proc: new FakeRunner(windowsHandler), platform: 'win32', arch: 'x64' },
      {
        os: os({
          cpus: () => {
            if (fail) throw new Error('os.cpus failed');
            return [{ model: 'cpu' }];
          },
        }),
      },
    );
    await expect(sys.getFingerprint()).rejects.toThrow('os.cpus failed');
    fail = false;
    expect((await sys.getFingerprint()).cpu.model).toBe('cpu');
  });

  it('works with the real node:os and fs defaults on this machine', async () => {
    // Linux branch on purpose: it only reads files (absent on Windows → fallbacks), never spawns.
    const fp = await createSysInfo({ proc: new FakeRunner(() => ok('', 1)), platform: 'linux', arch: process.arch }).getFingerprint();
    expect(hardwareFingerprintSchema.parse(fp).cpu.threads).toBeGreaterThan(0);
    expect(fp.hostLabel.length).toBeGreaterThan(0);
  });
});
