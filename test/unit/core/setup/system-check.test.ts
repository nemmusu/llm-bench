import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineStatus } from '../../../../src/contract/engines';
import { AppError } from '../../../../src/contract/errors';
import type { GpuInfo } from '../../../../src/contract/hardware';
import { parseOsRelease } from '../../../../src/core/setup/os-release';
import {
  CHECK_IDS,
  DEFAULT_MIN_FREE_BYTES,
  SystemCheck,
  freeBytes,
  type CheckItem,
  type SystemCheckSources,
} from '../../../../src/core/setup/system-check';

const GIB = 1024 ** 3;
const RTX5090: GpuInfo = { index: 0, uuid: 'GPU-1', name: 'NVIDIA GeForce RTX 5090', vendor: 'nvidia', memoryTotalMiB: 32607, computeCapability: '12.0' };
const UBUNTU = parseOsRelease('ID=ubuntu\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble');
const LLAMA_OK: EngineStatus = { kind: 'llamacpp-native', available: true, installed: true, version: 'b11438', variant: 'cuda-13.4', location: 'C:\\e\\llama-server.exe', problems: [], supported: true };
const LLAMA_NONE: EngineStatus = { kind: 'llamacpp-native', available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true };

/** This PC: Windows, RTX 5090, driver 617.14, llama.cpp installed, models in C:\models, Docker stopped. */
function sources(over: Partial<SystemCheckSources> = {}): SystemCheckSources {
  return {
    platform: 'win32',
    arch: 'x64',
    telemetryStatus: () => Promise.resolve({ found: true, works: true, driverVersion: '617.14', cudaVersion: '13.4' }),
    probeGpus: () => Promise.resolve([RTX5090]),
    isWsl: () => Promise.resolve(false),
    llamacpp: () => Promise.resolve(LLAMA_OK),
    llamacppInstallBytes: () => Promise.resolve(512_000_000),
    localModels: () => Promise.resolve([{ dir: 'C:\\models' }, { dir: 'C:\\models' }, { dir: 'D:\\lm' }]),
    modelsDir: () => Promise.resolve('C:\\models'),
    statfs: () => Promise.resolve({ bavail: 100 * 1024 * 1024, bsize: 4096 }),
    dockerStatus: () => Promise.resolve({ state: 'stopped' }),
    dockerInstallBytes: () => Promise.resolve(635_493_296),
    clockWall: () => Date.UTC(2026, 9, 6, 8, 0, 0),
    timeoutMs: 1000,
    ...over,
  };
}

const item = (items: CheckItem[], id: CheckItem['id']) => items.find((i) => i.id === id) as CheckItem;

describe('SystemCheck: Docker that does not answer', () => {
  it('Windows: a warning with "Riavvia Docker"; Linux: the warning only (the UI gives the command)', async () => {
    const stuck = () => Promise.resolve({ state: 'not-responding' as const, version: '29.8.0' });
    const win = await new SystemCheck(sources({ dockerStatus: stuck })).check();
    expect(item(win.items, 'docker')).toEqual({
      id: 'docker',
      state: 'warning',
      required: false,
      params: { dockerState: 'not-responding', version: '29.8.0' },
      code: 'DOCKER_NOT_RESPONDING',
      action: { kind: 'restart-docker' },
    });
    const linux = await new SystemCheck(sources({ platform: 'linux', dockerStatus: stuck, osRelease: () => Promise.resolve(undefined) })).check();
    expect(item(linux.items, 'docker')).toMatchObject({ state: 'warning', code: 'DOCKER_NOT_RESPONDING' });
    expect(item(linux.items, 'docker').action).toBeUndefined();
  });

  it('stopped on Linux: no "Avvia Docker" (a system service: the UI gives the command)', async () => {
    const linux = await new SystemCheck(sources({ platform: 'linux', osRelease: () => Promise.resolve(UBUNTU) })).check();
    expect(item(linux.items, 'docker')).toEqual({ id: 'docker', state: 'optional', required: false, params: { dockerState: 'stopped' }, code: 'DOCKER_NOT_RUNNING' });
  });
});

describe('SystemCheck on this PC', () => {
  it('lists every item in order with the right lights', async () => {
    const r = await new SystemCheck(sources()).check();
    expect(r.items.map((i) => i.id)).toEqual([...CHECK_IDS]);
    expect(r).toMatchObject({ platform: 'win32', canBenchmark: true, checkedAt: '2026-10-06T08:00:00.000Z' });
    expect(item(r.items, 'driver')).toEqual({
      id: 'driver',
      state: 'ok',
      required: true,
      params: { driverVersion: '617.14', cudaVersion: '13.4', minRequired: '572.16', architecture: 'blackwell-rtx' },
    });
    expect(item(r.items, 'gpu')).toEqual({ id: 'gpu', state: 'ok', required: true, params: { name: 'NVIDIA GeForce RTX 5090', vramGb: 31.8, count: 1, computeCapability: '12.0' } });
    expect(item(r.items, 'llamacpp')).toEqual({
      id: 'llamacpp',
      state: 'ok',
      required: true,
      params: { version: 'b11438', variant: 'cuda-13.4', location: 'C:\\e\\llama-server.exe' },
    });
    expect(item(r.items, 'models')).toEqual({ id: 'models', state: 'ok', required: true, params: { count: 3, dirs: ['C:\\models', 'D:\\lm'] } });
    expect(item(r.items, 'disk')).toMatchObject({ state: 'ok', required: false, params: { freeGb: 400, minFreeGb: 20 } });
    expect(item(r.items, 'docker')).toEqual({
      id: 'docker',
      state: 'optional',
      required: false,
      params: { dockerState: 'stopped' },
      code: 'DOCKER_NOT_RUNNING',
      action: { kind: 'start-docker' },
    });
    expect(item(r.items, 'vllm-native')).toEqual({ id: 'vllm-native', state: 'unsupported', required: false, params: {} });
  });

  it('works with default timeout and clock, and GPUs without a compute capability', async () => {
    const gpu: GpuInfo = { index: 0, uuid: 'GPU-2', name: 'NVIDIA GeForce RTX 3070', vendor: 'nvidia', memoryTotalMiB: 8192 };
    const r = await new SystemCheck(sources({ timeoutMs: undefined, clockWall: undefined, probeGpus: () => Promise.resolve([gpu]) })).check();
    expect(item(r.items, 'gpu').params).toEqual({ name: 'NVIDIA GeForce RTX 3070', vramGb: 8, count: 1 });
    expect(Date.parse(r.checkedAt)).toBeGreaterThan(0);
  });

  it('refreshes cached detections on demand', async () => {
    let refreshed = 0;
    const check = new SystemCheck(sources({ refresh: () => refreshed++ }));
    await check.check();
    await check.check({ fresh: true });
    expect(refreshed).toBe(1);
    // Without a refresh hook a fresh check still works.
    await expect(new SystemCheck(sources()).check({ fresh: true })).resolves.toMatchObject({ canBenchmark: true });
  });
});

describe('clean PC paths', () => {
  it('no NVIDIA driver: red driver with the download page, GPU waits for it, llama.cpp offered inline', async () => {
    const r = await new SystemCheck(
      sources({
        telemetryStatus: () => Promise.resolve({ found: false, works: false }),
        probeGpus: () => Promise.reject(new AppError('DRIVER_MISSING', 'no nvidia-smi')),
        llamacpp: () => Promise.resolve(LLAMA_NONE),
        localModels: () => Promise.resolve([]),
        dockerStatus: () => Promise.resolve({ state: 'not-installed' }),
      }),
    ).check();
    expect(r.canBenchmark).toBe(false);
    expect(item(r.items, 'driver')).toMatchObject({
      state: 'missing',
      code: 'DRIVER_MISSING',
      params: { minRequired: '551.61' },
      action: { kind: 'open-driver-page', url: 'https://www.nvidia.com/en-us/drivers/' },
    });
    expect(item(r.items, 'gpu')).toEqual({ id: 'gpu', state: 'missing', required: true, params: {}, code: 'DRIVER_MISSING' });
    expect(item(r.items, 'llamacpp')).toEqual({ id: 'llamacpp', state: 'missing', required: true, params: {}, code: 'ENGINE_NOT_INSTALLED', action: { kind: 'install-llamacpp', bytes: 512_000_000 } });
    expect(item(r.items, 'models')).toEqual({ id: 'models', state: 'missing', required: true, params: { count: 0, dirs: [] }, code: 'MODEL_NOT_FOUND', action: { kind: 'pick-model' } });
    expect(item(r.items, 'docker')).toMatchObject({ state: 'optional', code: 'DOCKER_NOT_INSTALLED', action: { kind: 'install-docker', bytes: 635_493_296 } });
  });

  it('old driver: red with DRIVER_TOO_OLD', async () => {
    const r = await new SystemCheck(sources({ telemetryStatus: () => Promise.resolve({ found: true, works: true, driverVersion: '566.36' }) })).check();
    expect(item(r.items, 'driver')).toMatchObject({ state: 'missing', code: 'DRIVER_TOO_OLD', params: { driverVersion: '566.36', cudaVersion: '12.6', minRequired: '572.16' } });
    expect(r.canBenchmark).toBe(false);
  });

  it('nvidia-smi works but sees no GPU, or only non-NVIDIA adapters', async () => {
    const none = await new SystemCheck(
      sources({ telemetryStatus: () => Promise.resolve({ found: true, works: false, driverVersion: '617.14', error: { code: 'GPU_NOT_FOUND', message: 'x' } }), probeGpus: () => Promise.resolve([]) }),
    ).check();
    expect(item(none.items, 'gpu')).toMatchObject({ state: 'missing', code: 'GPU_NOT_FOUND' });
    const broken = await new SystemCheck(
      sources({ telemetryStatus: () => Promise.resolve({ found: true, works: false, error: { code: 'DRIVER_MISSING', message: 'x' } }) }),
    ).check();
    expect(item(broken.items, 'gpu')).toMatchObject({ state: 'missing', code: 'DRIVER_MISSING' });
    const intel: GpuInfo = { index: 0, uuid: 'x', name: 'Intel Arc A770', vendor: 'other', memoryTotalMiB: 16000 };
    const other = await new SystemCheck(sources({ probeGpus: () => Promise.resolve([intel]) })).check();
    expect(item(other.items, 'gpu')).toEqual({ id: 'gpu', state: 'unsupported', required: true, params: { name: 'Intel Arc A770' }, code: 'GPU_NOT_FOUND' });
  });

  it('installed llama.cpp that does not start: amber with reinstall', async () => {
    const broken: EngineStatus = { ...LLAMA_OK, available: false, problems: ['ENGINE_START_FAILED'] };
    const r = await new SystemCheck(sources({ llamacpp: () => Promise.resolve(broken), llamacppInstallBytes: () => Promise.reject(new Error('github down')) })).check();
    expect(item(r.items, 'llamacpp')).toMatchObject({ state: 'warning', code: 'ENGINE_START_FAILED', action: { kind: 'install-llamacpp' } });
    expect(item(r.items, 'llamacpp').action).not.toHaveProperty('bytes');
    const noProblem = await new SystemCheck(sources({ llamacpp: () => Promise.resolve({ ...broken, problems: [] }), llamacppInstallBytes: undefined })).check();
    expect(item(noProblem.items, 'llamacpp')).toMatchObject({ code: 'ENGINE_START_FAILED', action: { kind: 'install-llamacpp' } });
  });

  it('llama.cpp missing a system library: amber with the library, no reinstall (apt fixes it)', async () => {
    const st: EngineStatus = { ...LLAMA_OK, available: false, problems: ['ENGINE_MISSING_LIBRARY'], problemParams: { library: 'libgomp.so.1', package: 'libgomp1' } };
    const r = await new SystemCheck(sources({ llamacpp: () => Promise.resolve(st) })).check();
    const it_ = item(r.items, 'llamacpp');
    expect(it_).toMatchObject({ state: 'warning', code: 'ENGINE_MISSING_LIBRARY', params: { library: 'libgomp.so.1', package: 'libgomp1' } });
    expect(it_.action).toBeUndefined();
  });

  it('low disk: amber with how much to free', async () => {
    const r = await new SystemCheck(sources({ statfs: () => Promise.resolve({ bavail: BigInt(5 * 1024 * 1024), bsize: BigInt(1024) }) })).check();
    expect(item(r.items, 'disk')).toMatchObject({ state: 'warning', code: 'DISK_FULL', params: { freeGb: 5 }, action: { kind: 'free-disk', bytes: DEFAULT_MIN_FREE_BYTES - 5 * GIB } });
    const custom = await new SystemCheck(sources({ minFreeBytes: 500 * GIB })).check();
    expect(item(custom.items, 'disk')).toMatchObject({ state: 'warning', params: { minFreeGb: 500 } });
  });
});

describe('each source degrades on its own', () => {
  it('turns failures and timeouts into amber items with the error code', async () => {
    const never = () => new Promise<never>(() => {});
    const r = await new SystemCheck(
      sources({
        timeoutMs: 20,
        telemetryStatus: () => Promise.reject(new AppError('DRIVER_MISSING', 'nvidia-smi crashed')),
        llamacpp: never,
        localModels: () => Promise.reject(new Error('scan failed')),
        modelsDir: () => Promise.reject(new AppError('VALIDATION', 'bad dir')),
        dockerStatus: () => Promise.reject(new AppError('DOCKER_NOT_RUNNING', 'pipe closed')),
      }),
    ).check();
    expect(item(r.items, 'driver')).toMatchObject({ state: 'warning', code: 'DRIVER_MISSING', error: { message: 'nvidia-smi crashed' } });
    expect(item(r.items, 'gpu')).toMatchObject({ state: 'warning', code: 'DRIVER_MISSING' });
    expect(item(r.items, 'llamacpp')).toMatchObject({ state: 'warning', code: 'INTERNAL', error: { params: { reason: 'timeout' } } });
    expect(item(r.items, 'models')).toMatchObject({ state: 'warning', code: 'INTERNAL' });
    expect(item(r.items, 'disk')).toMatchObject({ state: 'warning', required: false, code: 'VALIDATION' });
    expect(item(r.items, 'docker')).toMatchObject({ state: 'warning', code: 'DOCKER_NOT_RUNNING' });
    expect(r.canBenchmark).toBe(false);
  });

  it('uses the real statfs by default and walks up to an existing folder', async () => {
    const r = await new SystemCheck(sources({ statfs: undefined, modelsDir: () => Promise.resolve(path.join(os.tmpdir(), 'gb-no-such', 'models')) })).check();
    const disk = item(r.items, 'disk');
    expect(['ok', 'warning']).toContain(disk.state);
    expect(disk.params.path).toBe(os.tmpdir());
  });
});

describe('freeBytes', () => {
  it('rethrows errors other than a missing folder, and gives up at the root', async () => {
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
    await expect(freeBytes('/a/b', () => Promise.reject(eacces))).rejects.toBe(eacces);
    const enoent = Object.assign(new Error('gone'), { code: 'ENOENT' });
    await expect(freeBytes('/a/b', () => Promise.reject(enoent))).rejects.toBe(enoent);
  });
});

describe('docker item', () => {
  const docker = async (state: string, over: Partial<SystemCheckSources> = {}) =>
    item((await new SystemCheck(sources({ dockerStatus: () => Promise.resolve({ state: state as never, version: '29.8', reason: 'r' }), ...over })).check()).items, 'docker');

  it('maps every docker state', async () => {
    expect(await docker('running')).toEqual({ id: 'docker', state: 'ok', required: false, params: { dockerState: 'running', version: '29.8', reason: 'r' } });
    expect(await docker('starting')).toMatchObject({ state: 'optional' });
    expect(await docker('starting')).not.toHaveProperty('action');
    expect(await docker('unsupported')).toMatchObject({ state: 'unsupported', code: 'DOCKER_UNSUPPORTED' });
    expect(await docker('unknown')).toMatchObject({ state: 'warning' });
    expect(await docker('no-gpu')).toMatchObject({ state: 'warning', code: 'DOCKER_NO_GPU' });
    expect(await docker('no-gpu')).not.toHaveProperty('action');
    expect(await docker('no-permission')).toMatchObject({ state: 'warning', code: 'DOCKER_PERMISSION' });
    expect(await docker('not-installed', { dockerInstallBytes: undefined })).toEqual({
      id: 'docker',
      state: 'optional',
      required: false,
      params: { dockerState: 'not-installed', version: '29.8', reason: 'r' },
      code: 'DOCKER_NOT_INSTALLED',
      action: { kind: 'install-docker' },
    });
  });

  it('Linux: the guided script fixes missing Docker, permissions and the GPU runtime on Ubuntu/Debian', async () => {
    const linux = { platform: 'linux' as const, osRelease: () => Promise.resolve(UBUNTU) };
    expect(await docker('not-installed', linux)).toMatchObject({ action: { kind: 'install-docker-linux' } });
    expect(await docker('no-permission', linux)).toMatchObject({ action: { kind: 'install-docker-linux' } });
    expect(await docker('no-gpu', linux)).toMatchObject({ action: { kind: 'install-docker-linux' } });
    const arch = await docker('not-installed', { platform: 'linux', osRelease: () => Promise.resolve(parseOsRelease('ID=arch')) });
    expect(arch).not.toHaveProperty('action');
    expect(arch.params).toMatchObject({ distroSupport: 'unsupported-distro', docs: 'https://docs.docker.com/engine/install/' });
    const unreadable = await docker('not-installed', { platform: 'linux', osRelease: () => Promise.reject(new Error('EACCES')) });
    expect(unreadable.params).toMatchObject({ distroSupport: 'no-os-release' });
    expect(await docker('not-installed', { platform: 'linux', osRelease: undefined })).toMatchObject({ params: { distroSupport: 'no-os-release' } });
  });

  it('without a docker source the item is optional and unknown', async () => {
    const r = await new SystemCheck(sources({ dockerStatus: undefined })).check();
    expect(item(r.items, 'docker')).toEqual({ id: 'docker', state: 'optional', required: false, params: { dockerState: 'unknown' } });
  });
});

describe('vllm-native item (Linux)', () => {
  const vllm = async (over: Partial<SystemCheckSources>) =>
    item((await new SystemCheck(sources({ platform: 'linux', osRelease: () => Promise.resolve(UBUNTU), ...over })).check()).items, 'vllm-native');

  it('offers uv first, then vLLM, and reports an installed vLLM', async () => {
    expect(await vllm({ uvInstallBytes: () => Promise.resolve(19_906_150) })).toEqual({
      id: 'vllm-native',
      state: 'optional',
      required: false,
      params: { uv: false },
      action: { kind: 'install-uv', bytes: 19_906_150 },
    });
    expect(await vllm({ uvPath: () => Promise.resolve(undefined), uvInstallBytes: () => Promise.resolve(undefined) })).toMatchObject({ action: { kind: 'install-uv' } });
    expect(await vllm({ uvPath: () => Promise.resolve('/e/uv/0.12.23/uv') })).toEqual({
      id: 'vllm-native',
      state: 'optional',
      required: false,
      params: { uv: true },
      action: { kind: 'install-vllm' },
    });
    expect(await vllm({ vllmNative: () => Promise.resolve({ installed: true, version: '0.12.0' }) })).toEqual({ id: 'vllm-native', state: 'ok', required: false, params: { version: '0.12.0' } });
    expect(await vllm({ vllmNative: () => Promise.resolve({ installed: true }) })).toMatchObject({ state: 'ok', params: {} });
    expect(await vllm({ vllmNative: () => Promise.reject(new Error('venv broken')) })).toMatchObject({ state: 'warning', code: 'INTERNAL' });
  });
});

describe('other platforms', () => {
  it('macOS: nothing is supported', async () => {
    const r = await new SystemCheck(sources({ platform: 'darwin' })).check();
    expect(item(r.items, 'driver')).toMatchObject({ state: 'unsupported', code: 'DRIVER_MISSING' });
    expect(item(r.items, 'driver')).not.toHaveProperty('action');
    expect(item(r.items, 'gpu')).toMatchObject({ state: 'unsupported' });
    expect(item(r.items, 'docker')).toMatchObject({ state: 'unsupported' });
    expect(r.canBenchmark).toBe(false);
  });
});

describe('driver()', () => {
  it('works with only the mandatory sources and tolerates failing optional ones', async () => {
    const minimal = new SystemCheck(sources({ isWsl: undefined, osRelease: undefined, probeGpus: () => Promise.reject(new Error('x')) }));
    expect(await minimal.driver()).toMatchObject({ state: 'ok', minRequired: '551.61' });
    const failing = new SystemCheck(
      sources({ platform: 'linux', isWsl: () => Promise.reject(new Error('x')), osRelease: () => Promise.reject(new Error('y')), telemetryStatus: () => Promise.resolve({ found: true, works: true, driverVersion: '580.65.06' }) }),
    );
    expect(await failing.driver()).toMatchObject({ state: 'ok', linuxGuidance: 'nvidia-docs' });
    const wsl = new SystemCheck(sources({ platform: 'linux', isWsl: () => Promise.resolve(true) }));
    expect(await wsl.driver()).toMatchObject({ state: 'ok', recommendedAction: 'none', links: [{ kind: 'driver-page' }, { kind: 'nvidia-app' }] });
  });

  it('carries the Linux guidance code into the item', async () => {
    const r = await new SystemCheck(
      sources({ platform: 'linux', osRelease: () => Promise.resolve(UBUNTU), telemetryStatus: () => Promise.resolve({ found: true, works: true, driverVersion: '550.54.14' }) }),
    ).check();
    expect(item(r.items, 'driver')).toMatchObject({
      state: 'missing',
      code: 'DRIVER_TOO_OLD',
      params: { guidance: 'ubuntu-drivers' },
      action: { kind: 'open-driver-page', url: 'https://ubuntu.com/server/docs/how-to/graphics/install-nvidia-drivers/' },
    });
  });
});
